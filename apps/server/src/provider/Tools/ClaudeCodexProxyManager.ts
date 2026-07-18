import type {
  ClaudeCodexProxyInstallProgressEvent,
  ClaudeCodexProxyLoginProgressEvent,
  ClaudeCodexProxyStatus,
} from "@t3tools/contracts";
import { CLAUDE_CODEX_PROXY_VERSION, ClaudeCodexProxyError } from "@t3tools/contracts";
import * as Installer from "@t3tools/shared/claudeCodexProxy";
import * as NetService from "@t3tools/shared/Net";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { collectStreamAsString } from "../providerSnapshot.ts";

const FIRST_RUNTIME_PORT = 18_765;
const LAST_RUNTIME_PORT = 18_784;
const AUTH_CALLBACK_PORT = 1_455;
const AUTHORIZATION_URL_PATTERN = /https:\/\/[^\s]+/u;
const isClaudeCodexProxyError = Schema.is(ClaudeCodexProxyError);

interface ActiveProxy {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly baseUrl: string;
  readonly port: number;
}

export interface ClaudeCodexProxyLease {
  readonly baseUrl: string;
}

export interface ClaudeCodexProxyManagerShape {
  readonly getStatus: Effect.Effect<ClaudeCodexProxyStatus>;
  readonly refreshStatus: Effect.Effect<ClaudeCodexProxyStatus>;
  readonly install: (
    report: (event: ClaudeCodexProxyInstallProgressEvent) => Effect.Effect<void>,
  ) => Effect.Effect<ClaudeCodexProxyStatus, ClaudeCodexProxyError>;
  readonly login: (
    report: (event: ClaudeCodexProxyLoginProgressEvent) => Effect.Effect<void>,
  ) => Effect.Effect<ClaudeCodexProxyStatus, ClaudeCodexProxyError>;
  readonly logout: Effect.Effect<ClaudeCodexProxyStatus, ClaudeCodexProxyError>;
  readonly acquire: Effect.Effect<ClaudeCodexProxyLease, ClaudeCodexProxyError, Scope.Scope>;
  readonly stop: Effect.Effect<void>;
}

const unavailableManager = (): ClaudeCodexProxyManagerShape => {
  const error = new ClaudeCodexProxyError({
    reason: "processStartFailed",
    message: "The Claude Code proxy manager is unavailable in this runtime.",
  });
  const status: ClaudeCodexProxyStatus = {
    version: CLAUDE_CODEX_PROXY_VERSION,
    platform: "unknown",
    arch: "unknown",
    installation: "unsupported",
    authentication: "signedOut",
    runtime: "stopped",
    errorMessage: error.message,
  };
  return {
    getStatus: Effect.succeed(status),
    refreshStatus: Effect.succeed(status),
    install: () => Effect.fail(error),
    login: () => Effect.fail(error),
    logout: Effect.fail(error),
    acquire: Effect.fail(error),
    stop: Effect.void,
  };
};

export class ClaudeCodexProxyManager extends Context.Reference<ClaudeCodexProxyManagerShape>(
  "t3/provider/Tools/ClaudeCodexProxyManager",
  { defaultValue: unavailableManager },
) {}

function proxyEnvironment(dataDirectory: string, port?: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CCP_BIND_ADDRESS: "127.0.0.1",
    CCP_CONFIG_DIR: dataDirectory,
    CCP_LOG_VERBOSE: "0",
    CCP_TRAFFIC_LOG: "0",
    ...(port === undefined ? {} : { PORT: String(port) }),
  };
}

function redactOutput(value: string): string {
  return value
    .replace(/(?:access|refresh|id)_token["'=:\s]+[^\s,"']+/giu, "oauth_token=<redacted>")
    .replace(/ChatGPT-Account-Id["'=:\s]+[^\s,"']+/giu, "ChatGPT-Account-Id=<redacted>");
}

export const make = Effect.gen(function* () {
  const installer = yield* Installer.ClaudeCodexProxyInstaller;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;
  const httpClient = yield* HttpClient.HttpClient;
  const { baseDir } = yield* ServerConfig;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const dataDirectory = `${baseDir}/claude-code-proxy`;
  const activeRef = yield* Ref.make<ActiveProxy | null>(null);
  const leaseCountRef = yield* Ref.make(0);
  const authStateRef = yield* Ref.make<ClaudeCodexProxyStatus["authentication"]>("signedOut");
  const runtimeStateRef = yield* Ref.make<ClaudeCodexProxyStatus["runtime"]>("stopped");
  const errorRef = yield* Ref.make<string | undefined>(undefined);
  const mutex = yield* Semaphore.make(1);

  const status = Effect.fn("ClaudeCodexProxyManager.status")(function* (
    refreshAuthentication = false,
  ) {
    const executable = yield* installer.resolve;
    if (executable.status !== "installed") {
      return {
        version: CLAUDE_CODEX_PROXY_VERSION,
        platform: executable.status === "unsupported" ? executable.platform : platform,
        arch: executable.status === "unsupported" ? executable.arch : arch,
        installation: executable.status,
        authentication: "signedOut",
        runtime: "stopped",
        ...Option.match(Option.fromNullishOr(yield* Ref.get(errorRef)), {
          onNone: () => ({}),
          onSome: (errorMessage) => ({ errorMessage }),
        }),
      } satisfies ClaudeCodexProxyStatus;
    }

    if (refreshAuthentication) {
      const signedIn = yield* spawner
        .spawn(
          ChildProcess.make(executable.executablePath, ["codex", "auth", "status"], {
            shell: false,
            env: proxyEnvironment(dataDirectory),
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(
          Effect.flatMap((child) => child.exitCode),
          Effect.map((exitCode) => Number(exitCode) === 0),
          Effect.orElseSucceed(() => false),
          Effect.scoped,
        );
      const nextAuthentication = signedIn ? "signedIn" : "signedOut";
      yield* Ref.set(authStateRef, nextAuthentication);
    }

    return {
      version: CLAUDE_CODEX_PROXY_VERSION,
      platform,
      arch,
      installation: "installed",
      authentication: yield* Ref.get(authStateRef),
      runtime: yield* Ref.get(runtimeStateRef),
      ...Option.match(Option.fromNullishOr(yield* Ref.get(errorRef)), {
        onNone: () => ({}),
        onSome: (errorMessage) => ({ errorMessage }),
      }),
    } satisfies ClaudeCodexProxyStatus;
  });

  const stopActive = Effect.fn("ClaudeCodexProxyManager.stop")(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    if (active) yield* Scope.close(active.scope, Exit.void).pipe(Effect.ignore);
    yield* Ref.set(runtimeStateRef, "stopped");
  });

  const supervise = (active: ActiveProxy) =>
    active.child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(activeRef);
          if (current?.child.pid !== active.child.pid) return;
          yield* Ref.set(activeRef, null);
          yield* Ref.set(runtimeStateRef, "unhealthy");
          yield* Ref.set(
            errorRef,
            `The local proxy exited unexpectedly (code ${Number(exitCode)}).`,
          );
          yield* Effect.logWarning("Claude Code proxy exited", {
            pid: Number(active.child.pid),
            exitCode: Number(exitCode),
          });
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Claude Code proxy supervisor failed", { cause }),
      ),
    );

  const start = Effect.fn("ClaudeCodexProxyManager.start")(function* () {
    const current = yield* Ref.get(activeRef);
    if (current && (yield* current.child.isRunning.pipe(Effect.orElseSucceed(() => false)))) {
      return current;
    }
    const executable = yield* installer.resolve;
    if (executable.status !== "installed") {
      return yield* new ClaudeCodexProxyError({
        reason: executable.status === "unsupported" ? "unsupportedPlatform" : "processStartFailed",
        message:
          executable.status === "unsupported"
            ? `Claude + GPT is unsupported on ${executable.platform}-${executable.arch}.`
            : "Install the Claude Code proxy before starting this provider.",
      });
    }
    if ((yield* status(true)).authentication !== "signedIn") {
      return yield* new ClaudeCodexProxyError({
        reason: "authenticationFailed",
        message: "Connect ChatGPT before starting Claude + GPT.",
      });
    }
    let port: number | undefined;
    for (let candidate = FIRST_RUNTIME_PORT; candidate <= LAST_RUNTIME_PORT; candidate += 1) {
      if (yield* net.isPortAvailableOnLoopback(candidate)) {
        port = candidate;
        break;
      }
    }
    if (!port) {
      return yield* new ClaudeCodexProxyError({
        reason: "runtimePortConflict",
        message: `No local proxy port was available from ${FIRST_RUNTIME_PORT} to ${LAST_RUNTIME_PORT}.`,
      });
    }
    yield* Ref.set(runtimeStateRef, "starting");
    const processScope = yield* Scope.make("sequential");
    const child = yield* spawner
      .spawn(
        ChildProcess.make(executable.executablePath, ["serve", "--no-monitor"], {
          shell: false,
          detached: false,
          env: proxyEnvironment(dataDirectory, port),
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, processScope),
        Effect.mapError(
          () =>
            new ClaudeCodexProxyError({
              reason: "processStartFailed",
              message: "Could not start the local Claude Code proxy.",
            }),
        ),
      );
    const baseUrl = `http://127.0.0.1:${port}`;
    yield* waitForHttpReady({
      baseUrl,
      path: "/healthz",
      timeoutMs: 15_000,
      makeError: () =>
        new ClaudeCodexProxyError({
          reason: "healthCheckFailed",
          message: "The local proxy did not become healthy in time.",
        }),
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.tapError(() => Scope.close(processScope, Exit.void).pipe(Effect.ignore)),
    );
    const active = { child, scope: processScope, baseUrl, port } satisfies ActiveProxy;
    yield* Ref.set(activeRef, active);
    yield* Ref.set(runtimeStateRef, "healthy");
    yield* Ref.set(errorRef, undefined);
    yield* Effect.forkIn(supervise(active), processScope);
    return active;
  });

  const acquire = Effect.acquireRelease(
    mutex.withPermit(
      Effect.gen(function* () {
        const active = yield* start();
        yield* Ref.update(leaseCountRef, (count) => count + 1);
        return { baseUrl: active.baseUrl } satisfies ClaudeCodexProxyLease;
      }),
    ),
    () =>
      mutex.withPermit(
        Effect.gen(function* () {
          const remaining = yield* Ref.modify(leaseCountRef, (count) => {
            const next = Math.max(0, count - 1);
            return [next, next] as const;
          });
          if (remaining === 0) yield* stopActive();
        }),
      ),
  );

  const install: ClaudeCodexProxyManagerShape["install"] = (report) =>
    installer.installWithProgress(report).pipe(
      Effect.flatMap(() => status(true)),
      Effect.mapError(
        (error) =>
          new ClaudeCodexProxyError({
            reason:
              error instanceof Installer.ClaudeCodexProxyInstallError &&
              error.reason !== "writeFailed"
                ? error.reason
                : "validationFailed",
            message:
              error instanceof Error ? error.message : "Could not install the Claude Code proxy.",
          }),
      ),
    );

  const runAuthCommand = Effect.fn("ClaudeCodexProxyManager.runAuthCommand")(
    function* (args: ReadonlyArray<string>) {
      const executable = yield* installer.resolve;
      if (executable.status !== "installed") {
        return yield* new ClaudeCodexProxyError({
          reason: "processStartFailed",
          message: "Install the Claude Code proxy first.",
        });
      }
      const child = yield* spawner.spawn(
        ChildProcess.make(executable.executablePath, args, {
          shell: false,
          env: proxyEnvironment(dataDirectory),
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout: redactOutput(stdout), stderr: redactOutput(stderr), code: Number(code) };
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      isClaudeCodexProxyError(cause)
        ? cause
        : new ClaudeCodexProxyError({
            reason: "processStartFailed",
            message: "Could not run the proxy authentication command.",
          }),
    ),
  );

  const login: ClaudeCodexProxyManagerShape["login"] = (report) =>
    Effect.gen(function* () {
      if (!(yield* net.isPortAvailableOnLoopback(AUTH_CALLBACK_PORT))) {
        return yield* new ClaudeCodexProxyError({
          reason: "callbackPortConflict",
          message: `OAuth callback port ${AUTH_CALLBACK_PORT} is already in use.`,
        });
      }
      yield* Ref.set(authStateRef, "signingIn");
      yield* report({ type: "progress", stage: "starting" });
      const result = yield* runAuthCommand(["codex", "auth", "login"]);
      const authorizationUrl = `${result.stdout}\n${result.stderr}`.match(
        AUTHORIZATION_URL_PATTERN,
      )?.[0];
      if (authorizationUrl) {
        yield* report({ type: "progress", stage: "waitingForBrowser", authorizationUrl });
      }
      if (result.code !== 0) {
        yield* Ref.set(authStateRef, "signedOut");
        return yield* new ClaudeCodexProxyError({
          reason: "authenticationFailed",
          message: "ChatGPT sign-in did not complete.",
        });
      }
      yield* report({ type: "progress", stage: "completing" });
      return yield* status(true);
    }).pipe(Effect.onInterrupt(() => Ref.set(authStateRef, "signedOut")));

  const logout = Effect.gen(function* () {
    yield* stopActive();
    const result = yield* runAuthCommand(["codex", "auth", "logout"]);
    if (result.code !== 0) {
      return yield* new ClaudeCodexProxyError({
        reason: "logoutFailed",
        message: "Claude + GPT was disabled, but its ChatGPT credentials may remain.",
      });
    }
    yield* Ref.set(authStateRef, "signedOut");
    return yield* status(false);
  });

  const manager = ClaudeCodexProxyManager.of({
    getStatus: status(false),
    refreshStatus: status(true),
    install,
    login,
    logout,
    acquire,
    stop: stopActive(),
  });
  yield* Effect.addFinalizer(() => manager.stop);
  return manager;
});

export const layer = Layer.effect(ClaudeCodexProxyManager, make);
