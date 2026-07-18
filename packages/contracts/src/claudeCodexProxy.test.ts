import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ClaudeCodexProxyInstallProgressEvent,
  ClaudeCodexProxyLoginProgressEvent,
  ClaudeCodexProxyStatus,
} from "./claudeCodexProxy.ts";

const decodeInstallProgress = Schema.decodeUnknownSync(ClaudeCodexProxyInstallProgressEvent);
const decodeLoginProgress = Schema.decodeUnknownSync(ClaudeCodexProxyLoginProgressEvent);
const decodeStatus = Schema.decodeUnknownSync(ClaudeCodexProxyStatus);

describe("ClaudeCodexProxy public contracts", () => {
  it("round-trips sanitized status and progress payloads", () => {
    expect(
      decodeInstallProgress({
        type: "progress",
        stage: "verifyingChecksum",
      }),
    ).toEqual({ type: "progress", stage: "verifyingChecksum" });
    const loginProgress = decodeLoginProgress({
      type: "progress",
      stage: "waitingForBrowser",
      authorizationUrl: "https://auth.openai.com/example",
    });
    expect(loginProgress.type).toBe("progress");
    if (loginProgress.type === "progress") {
      expect(loginProgress.authorizationUrl).toContain("auth.openai.com");
    }
  });

  it("drops sensitive fields from public status", () => {
    const decoded = decodeStatus({
      version: "0.1.21",
      platform: "win32",
      arch: "arm64",
      installation: "installed",
      authentication: "signedIn",
      runtime: "stopped",
      accessToken: "secret",
      refreshToken: "secret",
      accountId: "secret",
      rawOutput: "secret",
    });
    expect(decoded).not.toHaveProperty("accessToken");
    expect(decoded).not.toHaveProperty("refreshToken");
    expect(decoded).not.toHaveProperty("accountId");
    expect(decoded).not.toHaveProperty("rawOutput");
  });
});
