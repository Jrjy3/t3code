import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_CODEX_PROXY_VERSION,
  claudeCodexProxyManagedPath,
  resolveClaudeCodexProxyReleaseAsset,
} from "./claudeCodexProxy.ts";

describe("Claude Code proxy release pin", () => {
  it("resolves only the supported Windows assets", () => {
    expect(resolveClaudeCodexProxyReleaseAsset("win32", "x64")?.sha256).toBe(
      "99f5dce0bc84043241aa20b7c4c870e71f55ee0a424156f2385de1e06c62ebbe",
    );
    expect(resolveClaudeCodexProxyReleaseAsset("win32", "arm64")?.sha256).toBe(
      "ed3a3cb2dd9a390f70eaba944a6d4f481f73572fe26e58a0a104ad816b23f191",
    );
    expect(resolveClaudeCodexProxyReleaseAsset("linux", "x64")).toBeNull();
  });

  it("uses a versioned platform-specific managed path", () => {
    expect(
      claudeCodexProxyManagedPath({
        baseDir: "T3",
        platform: "win32",
        arch: "arm64",
        join: (...parts) => parts.join("/"),
      }),
    ).toBe(
      `T3/tools/claude-code-proxy/${CLAUDE_CODEX_PROXY_VERSION}/win32-arm64/claude-code-proxy.exe`,
    );
  });
});
