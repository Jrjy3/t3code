import type {
  ClaudeCodexProxyInstallProgressEvent,
  ClaudeCodexProxyInstallProgressStage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import extractZip from "extract-zip";

import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";

export const CLAUDE_CODEX_PROXY_VERSION = "0.1.21";

export interface ClaudeCodexProxyReleaseAsset {
  readonly url: string;
  readonly sha256: string;
}

export const CLAUDE_CODEX_PROXY_RELEASE_ASSETS: Readonly<
  Partial<Record<`${NodeJS.Platform}-${string}`, ClaudeCodexProxyReleaseAsset>>
> = {
  "win32-x64": {
    url: "https://github.com/raine/claude-code-proxy/releases/download/v0.1.21/claude-code-proxy-windows-amd64.zip",
    sha256: "99f5dce0bc84043241aa20b7c4c870e71f55ee0a424156f2385de1e06c62ebbe",
  },
  "win32-arm64": {
    url: "https://github.com/raine/claude-code-proxy/releases/download/v0.1.21/claude-code-proxy-windows-arm64.zip",
    sha256: "ed3a3cb2dd9a390f70eaba944a6d4f481f73572fe26e58a0a104ad816b23f191",
  },
};

export type ClaudeCodexProxyExecutableStatus =
  | { readonly status: "installed"; readonly executablePath: string; readonly version: string }
  | { readonly status: "missing"; readonly version: string }
  | {
      readonly status: "unsupported";
      readonly platform: NodeJS.Platform;
      readonly arch: string;
      readonly version: string;
    };

export type InstalledClaudeCodexProxy = Extract<
  ClaudeCodexProxyExecutableStatus,
  { readonly status: "installed" }
>;

export class ClaudeCodexProxyInstallError extends Data.TaggedError("ClaudeCodexProxyInstallError")<{
  readonly reason:
    | "unsupportedPlatform"
    | "downloadFailed"
    | "checksumMismatch"
    | "extractionFailed"
    | "validationFailed"
    | "installLocked"
    | "writeFailed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ClaudeCodexProxyInstallerShape {
  readonly resolve: Effect.Effect<ClaudeCodexProxyExecutableStatus>;
  readonly install: Effect.Effect<InstalledClaudeCodexProxy, ClaudeCodexProxyInstallError>;
  readonly installWithProgress: (
    report: (event: ClaudeCodexProxyInstallProgressEvent) => Effect.Effect<void>,
  ) => Effect.Effect<InstalledClaudeCodexProxy, ClaudeCodexProxyInstallError>;
}

export class ClaudeCodexProxyInstaller extends Context.Service<
  ClaudeCodexProxyInstaller,
  ClaudeCodexProxyInstallerShape
>()("@t3tools/shared/claudeCodexProxy/ClaudeCodexProxyInstaller") {}

const LOCK_RETRY_COUNT = 100;
const LOCK_RETRY_DELAY = "100 millis";
const LOCK_STALE_MS = 5 * 60 * 1_000;

export function resolveClaudeCodexProxyReleaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): ClaudeCodexProxyReleaseAsset | null {
  return CLAUDE_CODEX_PROXY_RELEASE_ASSETS[`${platform}-${arch}`] ?? null;
}

export function claudeCodexProxyManagedPath(input: {
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly join: (...parts: ReadonlyArray<string>) => string;
}): string {
  return input.join(
    input.baseDir,
    "tools",
    "claude-code-proxy",
    CLAUDE_CODEX_PROXY_VERSION,
    `${input.platform}-${input.arch}`,
    input.platform === "win32" ? "claude-code-proxy.exe" : "claude-code-proxy",
  );
}

function isAlreadyExists(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "AlreadyExists";
}

export const makeClaudeCodexProxyInstaller = Effect.fn("claudeCodexProxy.installer.make")(
  function* (options: {
    readonly baseDir: string;
    readonly releaseAsset?: ClaudeCodexProxyReleaseAsset;
  }) {
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const semaphore = yield* Semaphore.make(1);
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const releaseAsset =
      options.releaseAsset ?? resolveClaudeCodexProxyReleaseAsset(platform, arch);
    const managedPath = claudeCodexProxyManagedPath({
      baseDir: options.baseDir,
      platform,
      arch,
      join: (...parts) => path.join(...parts),
    });

    const isExecutable = Effect.fn("claudeCodexProxy.installer.isExecutable")(function* (
      executablePath: string,
    ) {
      const info = yield* fileSystem.stat(executablePath).pipe(Effect.option);
      return Option.isSome(info) && info.value.type === "File";
    });

    const resolve: ClaudeCodexProxyInstallerShape["resolve"] = Effect.gen(function* () {
      if (!releaseAsset) {
        return { status: "unsupported", platform, arch, version: CLAUDE_CODEX_PROXY_VERSION };
      }
      return (yield* isExecutable(managedPath))
        ? { status: "installed", executablePath: managedPath, version: CLAUDE_CODEX_PROXY_VERSION }
        : { status: "missing", version: CLAUDE_CODEX_PROXY_VERSION };
    });

    const reportStage = (
      report: (event: ClaudeCodexProxyInstallProgressEvent) => Effect.Effect<void>,
      stage: ClaudeCodexProxyInstallProgressStage,
    ) => report({ type: "progress", stage });

    const acquireLock = Effect.fn("claudeCodexProxy.installer.acquireLock")(function* (
      lockPath: string,
    ) {
      for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
        const acquired = yield* fileSystem.writeFileString(lockPath, "", { flag: "wx" }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            isAlreadyExists(error) ? Effect.succeed(false) : Effect.fail(error),
          ),
        );
        if (acquired) return;
        const info = yield* fileSystem.stat(lockPath).pipe(Effect.option);
        const mtime = Option.flatMap(info, (value) => value.mtime);
        if (
          Option.isSome(mtime) &&
          (yield* Clock.currentTimeMillis) - mtime.value.getTime() > LOCK_STALE_MS
        ) {
          yield* fileSystem.remove(lockPath, { force: true });
          continue;
        }
        yield* Effect.sleep(LOCK_RETRY_DELAY);
      }
      return yield* new ClaudeCodexProxyInstallError({
        reason: "installLocked",
        message: "Another Claude + GPT installation is still in progress.",
      });
    });

    const installUnlocked = Effect.fn("claudeCodexProxy.installer.installUnlocked")(function* (
      report: (event: ClaudeCodexProxyInstallProgressEvent) => Effect.Effect<void>,
    ) {
      yield* reportStage(report, "checking");
      const existing = yield* resolve;
      if (existing.status === "installed") return existing;
      if (!releaseAsset) {
        return yield* new ClaudeCodexProxyInstallError({
          reason: "unsupportedPlatform",
          message: `Claude + GPT is only available on Windows x64 and arm64 (${platform}-${arch} detected).`,
        });
      }

      const managedDirectory = path.dirname(managedPath);
      const lockPath = `${managedPath}.lock`;
      yield* fileSystem.makeDirectory(managedDirectory, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ClaudeCodexProxyInstallError({
              reason: "writeFailed",
              message: "Could not create the managed proxy directory.",
              cause,
            }),
        ),
      );
      yield* reportStage(report, "waitingForLock");
      yield* acquireLock(lockPath).pipe(
        Effect.mapError((cause) =>
          cause instanceof ClaudeCodexProxyInstallError
            ? cause
            : new ClaudeCodexProxyInstallError({
                reason: "writeFailed",
                message: "Could not acquire the installer lock.",
                cause,
              }),
        ),
      );

      return yield* Effect.gen(function* () {
        const afterLock = yield* resolve;
        if (afterLock.status === "installed") return afterLock;
        const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
          directory: managedDirectory,
          prefix: ".install-",
        });
        const zipPath = path.join(tempDirectory, "claude-code-proxy.zip");

        yield* reportStage(report, "downloading");
        const response = yield* httpClient.execute(HttpClientRequest.get(releaseAsset.url)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(
            (cause) =>
              new ClaudeCodexProxyInstallError({
                reason: "downloadFailed",
                message: "Could not download the pinned Claude Code proxy release.",
                cause,
              }),
          ),
        );
        const bytes = new Uint8Array(
          yield* response.arrayBuffer.pipe(
            Effect.mapError(
              (cause) =>
                new ClaudeCodexProxyInstallError({
                  reason: "downloadFailed",
                  message: "Could not read the proxy download.",
                  cause,
                }),
            ),
          ),
        );
        yield* reportStage(report, "verifyingChecksum");
        const digest = yield* crypto.digest("SHA-256", bytes).pipe(
          Effect.mapError(
            (cause) =>
              new ClaudeCodexProxyInstallError({
                reason: "validationFailed",
                message: "Could not calculate the proxy checksum.",
                cause,
              }),
          ),
        );
        if (Encoding.encodeHex(digest) !== releaseAsset.sha256) {
          return yield* new ClaudeCodexProxyInstallError({
            reason: "checksumMismatch",
            message: "The downloaded proxy did not match the pinned SHA-256 checksum.",
          });
        }
        yield* fileSystem.writeFile(zipPath, bytes).pipe(
          Effect.mapError(
            (cause) =>
              new ClaudeCodexProxyInstallError({
                reason: "writeFailed",
                message: "Could not stage the proxy archive.",
                cause,
              }),
          ),
        );

        yield* reportStage(report, "extracting");
        yield* Effect.tryPromise({
          try: () => extractZip(zipPath, { dir: tempDirectory }),
          catch: (cause) =>
            new ClaudeCodexProxyInstallError({
              reason: "extractionFailed",
              message: "Could not extract the proxy archive.",
              cause,
            }),
        });
        const extractedPath = path.join(tempDirectory, "claude-code-proxy.exe");
        if (!(yield* isExecutable(extractedPath))) {
          return yield* new ClaudeCodexProxyInstallError({
            reason: "extractionFailed",
            message: "The proxy archive did not contain claude-code-proxy.exe.",
          });
        }

        yield* reportStage(report, "validating");
        const child = yield* spawner
          .spawn(
            ChildProcess.make(extractedPath, ["--version"], {
              shell: false,
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ClaudeCodexProxyInstallError({
                  reason: "validationFailed",
                  message: "The downloaded proxy could not be started.",
                  cause,
                }),
            ),
          );
        if (Number(yield* child.exitCode) !== 0) {
          return yield* new ClaudeCodexProxyInstallError({
            reason: "validationFailed",
            message: "The downloaded proxy failed its version check.",
          });
        }

        yield* reportStage(report, "activating");
        const stagedPath = `${managedPath}.${yield* crypto.randomUUIDv4}.tmp`;
        yield* fileSystem.rename(extractedPath, stagedPath).pipe(
          Effect.mapError(
            (cause) =>
              new ClaudeCodexProxyInstallError({
                reason: "writeFailed",
                message: "Could not stage the verified proxy executable.",
                cause,
              }),
          ),
        );
        yield* fileSystem.rename(stagedPath, managedPath).pipe(
          Effect.ensuring(fileSystem.remove(stagedPath, { force: true }).pipe(Effect.ignore)),
          Effect.mapError(
            (cause) =>
              new ClaudeCodexProxyInstallError({
                reason: "writeFailed",
                message: "Could not activate the verified proxy executable.",
                cause,
              }),
          ),
        );
        return {
          status: "installed",
          executablePath: managedPath,
          version: CLAUDE_CODEX_PROXY_VERSION,
        } satisfies InstalledClaudeCodexProxy;
      }).pipe(
        Effect.scoped,
        Effect.ensuring(fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore)),
        Effect.mapError((cause) =>
          cause instanceof ClaudeCodexProxyInstallError
            ? cause
            : new ClaudeCodexProxyInstallError({
                reason: "writeFailed",
                message: "Could not complete the managed proxy installation.",
                cause,
              }),
        ),
      );
    });

    const installWithProgress: ClaudeCodexProxyInstallerShape["installWithProgress"] = (report) =>
      semaphore.withPermit(installUnlocked(report));
    const install = installWithProgress(() => Effect.void);
    return ClaudeCodexProxyInstaller.of({ resolve, install, installWithProgress });
  },
);

export const layerClaudeCodexProxyInstaller = (options: { readonly baseDir: string }) =>
  Layer.effect(ClaudeCodexProxyInstaller, makeClaudeCodexProxyInstaller(options));
