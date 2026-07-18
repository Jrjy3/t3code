import { describe, expect, it } from "vite-plus/test";

import { createModelSelection } from "@t3tools/shared/model";
import { ProviderInstanceId } from "@t3tools/contracts";

import { mergeClaudeProxyEnvironment } from "./ClaudeDriver.ts";
import { resolveClaudeApiModelId } from "../Layers/ClaudeProvider.ts";

describe("Claude Code proxy boundary", () => {
  it("applies required routing values after provider environment", () => {
    const environment = mergeClaudeProxyEnvironment(
      {
        ANTHROPIC_BASE_URL: "https://example.invalid",
        ANTHROPIC_AUTH_TOKEN: "override",
        UNRELATED: "preserved",
      },
      "http://127.0.0.1:18765",
    );
    expect(environment.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:18765");
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe("unused");
    expect(environment.ANTHROPIC_API_KEY).toBe("");
    expect(environment.UNRELATED).toBe("preserved");
  });

  it("stores clean GPT ids and appends the local context hint only at the SDK boundary", () => {
    const selection = createModelSelection(
      ProviderInstanceId.make("claude_chatgpt"),
      "gpt-5.6-terra",
    );
    expect(selection.model).toBe("gpt-5.6-terra");
    expect(resolveClaudeApiModelId(selection)).toBe("gpt-5.6-terra[1m]");
  });
});
