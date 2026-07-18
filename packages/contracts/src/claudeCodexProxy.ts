import * as Schema from "effect/Schema";

export const CLAUDE_CODEX_PROXY_VERSION = "0.1.21" as const;

export const ClaudeCodexProxyInstallationState = Schema.Literals([
  "unsupported",
  "missing",
  "installing",
  "installed",
]);
export type ClaudeCodexProxyInstallationState = typeof ClaudeCodexProxyInstallationState.Type;

export const ClaudeCodexProxyAuthenticationState = Schema.Literals([
  "signedOut",
  "signingIn",
  "signedIn",
  "expired",
  "error",
]);
export type ClaudeCodexProxyAuthenticationState = typeof ClaudeCodexProxyAuthenticationState.Type;

export const ClaudeCodexProxyRuntimeState = Schema.Literals([
  "stopped",
  "starting",
  "healthy",
  "unhealthy",
]);
export type ClaudeCodexProxyRuntimeState = typeof ClaudeCodexProxyRuntimeState.Type;

export const ClaudeCodexProxyStatus = Schema.Struct({
  version: Schema.Literal(CLAUDE_CODEX_PROXY_VERSION),
  platform: Schema.String,
  arch: Schema.String,
  installation: ClaudeCodexProxyInstallationState,
  authentication: ClaudeCodexProxyAuthenticationState,
  runtime: ClaudeCodexProxyRuntimeState,
  errorMessage: Schema.optional(Schema.String),
});
export type ClaudeCodexProxyStatus = typeof ClaudeCodexProxyStatus.Type;

export const ClaudeCodexProxyInstallProgressStage = Schema.Literals([
  "checking",
  "waitingForLock",
  "downloading",
  "verifyingChecksum",
  "extracting",
  "validating",
  "activating",
]);
export type ClaudeCodexProxyInstallProgressStage = typeof ClaudeCodexProxyInstallProgressStage.Type;

export const ClaudeCodexProxyInstallProgressEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("progress"), stage: ClaudeCodexProxyInstallProgressStage }),
  Schema.Struct({ type: Schema.Literal("complete"), status: ClaudeCodexProxyStatus }),
]);
export type ClaudeCodexProxyInstallProgressEvent = typeof ClaudeCodexProxyInstallProgressEvent.Type;

export const ClaudeCodexProxyLoginProgressStage = Schema.Literals([
  "checking",
  "starting",
  "waitingForBrowser",
  "completing",
]);
export type ClaudeCodexProxyLoginProgressStage = typeof ClaudeCodexProxyLoginProgressStage.Type;

export const ClaudeCodexProxyLoginProgressEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    stage: ClaudeCodexProxyLoginProgressStage,
    authorizationUrl: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("complete"), status: ClaudeCodexProxyStatus }),
]);
export type ClaudeCodexProxyLoginProgressEvent = typeof ClaudeCodexProxyLoginProgressEvent.Type;

export const ClaudeCodexProxyFailureReason = Schema.Literals([
  "unsupportedPlatform",
  "downloadFailed",
  "checksumMismatch",
  "extractionFailed",
  "validationFailed",
  "installLocked",
  "loginCancelled",
  "loginTimedOut",
  "callbackPortConflict",
  "authenticationFailed",
  "logoutFailed",
  "runtimePortConflict",
  "processStartFailed",
  "healthCheckFailed",
]);
export type ClaudeCodexProxyFailureReason = typeof ClaudeCodexProxyFailureReason.Type;

export class ClaudeCodexProxyError extends Schema.TaggedErrorClass<ClaudeCodexProxyError>()(
  "ClaudeCodexProxyError",
  {
    reason: ClaudeCodexProxyFailureReason,
    message: Schema.String,
  },
) {}
