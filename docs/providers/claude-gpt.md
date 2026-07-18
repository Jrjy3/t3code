# Claude + GPT (experimental)

Claude + GPT keeps Claude Code as the agent harness while routing its Anthropic-compatible model
requests through the open-source [`raine/claude-code-proxy`](https://github.com/raine/claude-code-proxy)
to the ChatGPT Codex endpoint. It uses ChatGPT Codex OAuth, not an OpenAI API key.

T3 pins proxy version `0.1.21` and supports local Windows x64 and arm64:

| Platform      | Release asset                         | SHA-256                                                            |
| ------------- | ------------------------------------- | ------------------------------------------------------------------ |
| Windows x64   | `claude-code-proxy-windows-amd64.zip` | `99f5dce0bc84043241aa20b7c4c870e71f55ee0a424156f2385de1e06c62ebbe` |
| Windows arm64 | `claude-code-proxy-windows-arm64.zip` | `ed3a3cb2dd9a390f70eaba944a6d4f481f73572fe26e58a0a104ad816b23f191` |

The verified executable is cached below `<T3 base directory>/tools/claude-code-proxy/0.1.21/`.
Proxy configuration and OAuth credentials are isolated below
`<T3 base directory>/claude-code-proxy/`. T3 never edits global Claude settings or shell profiles.

The helper binds to `127.0.0.1` only. It receives all prompts sent through this provider and stores
a refresh token, so setup requires an explicit disclosure confirmation.

## Removal

Use **Remove Claude + GPT** on its provider card. T3 removes every proxy-backed Claude profile,
favorites, and model preferences, stops the managed process after its sessions reconcile, and runs
the proxy logout command. Native Claude and Codex settings are not changed. The checksummed binary
remains cached for a later reinstall.

Historical threads are not migrated to native Claude because their continuation identity belongs to
a different backend.

## Proxy upgrade checklist

1. Inspect the upstream release diff and protocol/auth changes.
2. Update the pinned version, asset URLs, and both SHA-256 values in one reviewed change.
3. Rerun translation, tool-use, installer, lifecycle, and continuation tests.
4. Manually test OAuth, Sol/Terra/Luna, compaction, tool calls, interruption, and resume on Windows.
5. Run `vp test`, `vp check`, and `vp run typecheck`.
