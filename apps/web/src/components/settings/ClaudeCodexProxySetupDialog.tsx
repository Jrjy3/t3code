"use client";

import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ClaudeCodexProxyStatus,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";

const STEPS = ["Disclosure", "Install", "Connect", "Create profile", "Ready"] as const;

export function nextClaudeChatGptInstanceId(existingIds: ReadonlySet<string>): ProviderInstanceId {
  let suffix = 1;
  while (true) {
    const candidate = suffix === 1 ? "claude_chatgpt" : `claude_chatgpt_${suffix}`;
    if (!existingIds.has(candidate)) return ProviderInstanceId.make(candidate);
    suffix += 1;
  }
}

interface ClaudeCodexProxySetupDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onComplete?: (instanceId: ProviderInstanceId) => void;
  readonly launchContext?: "settings" | "composer";
}

function failureMessage(result: { readonly cause: Cause.Cause<unknown> }): string {
  const failure = Cause.squash(result.cause);
  return failure instanceof Error ? failure.message : String(failure);
}

export function ClaudeCodexProxySetupDialog({
  open,
  onOpenChange,
  onComplete,
  launchContext = "settings",
}: ClaudeCodexProxySetupDialogProps) {
  const environment = usePrimaryEnvironment();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const getStatus = useAtomCommand(serverEnvironment.claudeCodexProxyGetStatus, {
    reportFailure: false,
  });
  const installProxy = useAtomCommand(serverEnvironment.claudeCodexProxyInstall, {
    reportFailure: false,
  });
  const loginProxy = useAtomCommand(serverEnvironment.claudeCodexProxyLogin, {
    reportFailure: false,
  });

  const [step, setStep] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [status, setStatus] = useState<ClaudeCodexProxyStatus | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const refreshStatus = useCallback(async () => {
    if (!environment) return null;
    const result = await getStatus({ environmentId: environment.environmentId, input: {} });
    if (result._tag === "Success") {
      setStatus(result.value);
      return result.value;
    }
    setError(failureMessage(result));
    return null;
  }, [environment, getStatus]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void refreshStatus();
  }, [open, refreshStatus]);

  const continueFromDisclosure = useCallback(() => {
    if (!accepted) return;
    setStep(status?.installation === "installed" ? 2 : 1);
  }, [accepted, status?.installation]);

  const runInstall = useCallback(async () => {
    if (!environment || isBusy) return;
    setIsBusy(true);
    setError(null);
    const result = await installProxy({ environmentId: environment.environmentId, input: {} });
    setIsBusy(false);
    if (result._tag === "Failure") {
      setError(failureMessage(result));
      return;
    }
    if (result.value.type === "complete") setStatus(result.value.status);
    setStep(2);
  }, [environment, installProxy, isBusy]);

  const runLogin = useCallback(async () => {
    if (!environment || isBusy) return;
    setIsBusy(true);
    setError(null);
    const result = await loginProxy({ environmentId: environment.environmentId, input: {} });
    setIsBusy(false);
    if (result._tag === "Failure") {
      setError(failureMessage(result));
      return;
    }
    if (result.value.type === "complete") setStatus(result.value.status);
    setStep(3);
  }, [environment, isBusy, loginProxy]);

  const createProfile = useCallback(() => {
    const instanceId = nextClaudeChatGptInstanceId(existingIds);
    const instance: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude + GPT",
      enabled: true,
      config: { inferenceBackend: "chatgptCodexProxy" },
    };
    updateSettings({
      providerInstances: { ...settings.providerInstances, [instanceId]: instance },
    });
    setStep(4);
    onComplete?.(instanceId);
  }, [existingIds, onComplete, settings.providerInstances, updateSettings]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>Set up Claude + GPT</DialogTitle>
            <Badge variant="warning" size="sm">
              Experimental
            </Badge>
          </div>
          <DialogDescription>
            Run Claude Code’s harness against GPT-5.6 through a managed local proxy.
          </DialogDescription>
          <ol className="grid grid-cols-5 gap-1" aria-label="Setup progress">
            {STEPS.map((label, index) => (
              <li
                key={label}
                className="flex min-w-0 flex-col gap-1 text-[10px] text-muted-foreground"
                aria-current={index === step ? "step" : undefined}
              >
                <span
                  className={
                    index <= step ? "h-1 rounded-full bg-primary" : "h-1 rounded-full bg-muted"
                  }
                />
                <span className="truncate">{label}</span>
              </li>
            ))}
          </ol>
        </DialogHeader>

        <div className="flex min-h-64 flex-col gap-4 px-6 py-5" aria-live="polite">
          {step === 0 ? (
            <>
              <Alert variant="warning">
                <ShieldAlertIcon />
                <AlertTitle>Third-party credential boundary</AlertTitle>
                <AlertDescription>
                  <p>
                    The open-source helper receives every prompt routed through this profile and
                    stores a ChatGPT Codex OAuth refresh token in T3’s server data directory.
                  </p>
                  <p>Protocol or authentication changes may temporarily break this integration.</p>
                </AlertDescription>
              </Alert>
              <div className="flex flex-wrap gap-2 text-xs">
                <a
                  className="inline-flex items-center gap-1 underline"
                  href="https://github.com/raine/claude-code-proxy"
                  target="_blank"
                  rel="noreferrer"
                >
                  Source repository <ExternalLinkIcon aria-hidden />
                </a>
                <a
                  className="inline-flex items-center gap-1 underline"
                  href="https://github.com/raine/claude-code-proxy/releases/tag/v0.1.21"
                  target="_blank"
                  rel="noreferrer"
                >
                  Pinned v0.1.21 release <ExternalLinkIcon aria-hidden />
                </a>
              </div>
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <Checkbox
                  checked={accepted}
                  onCheckedChange={(checked) => setAccepted(checked === true)}
                />
                <span>I understand and accept the third-party helper and compatibility risk.</span>
              </label>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <h3 className="text-sm font-semibold">Install the managed proxy</h3>
              <p className="text-sm text-muted-foreground">
                T3 downloads the Windows build, verifies its pinned SHA-256 checksum, validates the
                executable, and caches it under the T3 tools directory.
              </p>
              {isBusy ? (
                <div className="flex items-center gap-2 text-sm">
                  <Spinner /> Downloading and verifying v0.1.21…
                </div>
              ) : null}
            </>
          ) : null}

          {step === 2 ? (
            <>
              <h3 className="text-sm font-semibold">Connect ChatGPT</h3>
              <p className="text-sm text-muted-foreground">
                A browser window will open for the proxy’s PKCE OAuth flow. Sign in with the ChatGPT
                Plus account you want to use with Codex.
              </p>
              {status?.authentication === "signedIn" ? (
                <Alert variant="success">
                  <CheckCircle2Icon />
                  <AlertTitle>Already connected</AlertTitle>
                </Alert>
              ) : null}
              {isBusy ? (
                <div className="flex items-center gap-2 text-sm">
                  <LoaderCircleIcon className="animate-spin" /> Waiting for browser sign-in…
                </div>
              ) : null}
            </>
          ) : null}

          {step === 3 ? (
            <>
              <h3 className="text-sm font-semibold">Create the provider profile</h3>
              <p className="text-sm text-muted-foreground">
                This creates a separate Claude harness profile with GPT-5.6 Sol as its first and
                default model. Native Claude and Codex settings are not changed.
              </p>
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                Claude + GPT · GPT-5.6 Sol <span className="text-muted-foreground">(default)</span>
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <Alert variant="success">
              <CheckCircle2Icon />
              <AlertTitle>Claude + GPT is ready</AlertTitle>
              <AlertDescription>
                {launchContext === "composer"
                  ? "GPT-5.6 Sol is selected for this draft."
                  : "Choose Claude + GPT in the composer model picker to start a new thread."}
              </AlertDescription>
            </Alert>
          ) : null}

          {error ? (
            <Alert variant="error">
              <AlertTitle>Setup could not continue</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {step === 4 ? "Close" : "Cancel"}
          </Button>
          {step === 0 ? (
            <Button disabled={!accepted} onClick={continueFromDisclosure}>
              Continue
            </Button>
          ) : null}
          {step === 1 ? (
            <Button disabled={isBusy} onClick={() => void runInstall()}>
              {isBusy ? <Spinner data-icon="inline-start" /> : null}Install proxy
            </Button>
          ) : null}
          {step === 2 ? (
            status?.authentication === "signedIn" ? (
              <Button onClick={() => setStep(3)}>Continue</Button>
            ) : (
              <Button disabled={isBusy} onClick={() => void runLogin()}>
                {isBusy ? <Spinner data-icon="inline-start" /> : null}Open ChatGPT login
              </Button>
            )
          ) : null}
          {step === 3 ? <Button onClick={createProfile}>Create Claude + GPT</Button> : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
