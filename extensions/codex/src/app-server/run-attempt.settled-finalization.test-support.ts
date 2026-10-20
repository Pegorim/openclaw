import path from "node:path";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  type writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import * as settledTurnContext from "./settled-turn-context.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

type SettledFinalizationFixtures = {
  expectResumeRequest: (
    requests: Array<{ method: string; params: unknown }>,
    params: Record<string, unknown>,
  ) => void;
  writeExistingBinding: (
    sessionFile: string,
    workspaceDir: string,
    overrides?: Partial<Parameters<typeof writeCodexAppServerBinding>[1]>,
  ) => Promise<void>;
};

/** Keep finalization evidence cases under the parent suite's original hooks and ordering. */
export function registerSettledFinalizationTests({
  expectResumeRequest,
  writeExistingBinding,
}: SettledFinalizationFixtures) {
  it.each([
    {
      label: "preserve-only host-auth turn",
      failure: undefined,
      preserveNativeModel: true,
    },
    {
      label: "provider overload after the tool result",
      failure: {
        message: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
      },
    },
  ])("preserves settled finalization eligibility for a $label", async (scenario) => {
    const { failure } = scenario;
    const preserveNativeModel = "preserveNativeModel" in scenario;
    const storePath = path.join(tempDir, "settled-finalization-context.sqlite");
    const sessionId = "session-settled-finalization-context";
    const sessionFile = `agent:main:${sessionId}`;
    const workspaceDir = path.join(tempDir, "workspace-settled-finalization-context");
    const sourceSelection = { model: "gpt-5.6-luna", modelProvider: "openai" };
    const onStart = vi.fn();
    const harness = createStartedThreadHarness(
      async (method) =>
        method === "thread/start" || method === "thread/resume"
          ? { ...threadStartResult(), ...sourceSelection }
          : undefined,
      { onStart, ...(preserveNativeModel ? { persistedThreads: ["thread-1"] } : {}) },
    );
    const params = createParams(sessionFile, workspaceDir);
    params.registerPluginRuntimeRefreshConsumer = vi.fn();
    params.modelId = "synthetic-outer-model";
    params.authProfileStore = {
      version: 1,
      order: { openai: ["openai:ordered"] },
      profiles: {
        "openai:ordered": { type: "api_key", provider: "openai", key: "synthetic-ordered-key" },
        "openai:binding": { type: "api_key", provider: "openai", key: "synthetic-binding-key" },
      },
    };
    await attachSqliteSessionTarget(params, storePath, sessionId);
    if (preserveNativeModel) {
      registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
      await writeExistingBinding(sessionFile, workspaceDir, {
        threadId: "thread-1",
        model: "synthetic-previous-model",
        preserveNativeModel: true,
        authProfileId: "openai:binding",
      });
    }
    params.prompt = "Send the update to Alice.";
    params.onSettledTurn = async (attempt, captureContext) => {
      attempt.settledTurnFinalizationContext = await captureContext();
    };
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const emptyAssistant = { type: "agentMessage", id: "empty-assistant", text: "" };
    const command = {
      type: "commandExecution",
      id: "tool-settled",
      command: "echo sent-to-alice",
      cwd: workspaceDir,
      source: "agent",
      commandActions: [],
    };
    // Native events arrive in wire order; local projection must not delay terminal receipt.
    await Promise.all([
      harness.notify(itemNotification("item/started", emptyAssistant)),
      harness.notify(itemNotification("item/completed", emptyAssistant)),
      harness.notify(
        itemNotification("item/started", {
          ...command,
          processId: null,
          status: "inProgress",
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        }),
      ),
      harness.notify(
        itemNotification("item/completed", {
          ...command,
          processId: 42,
          status: "completed",
          aggregatedOutput: "sent-to-alice\n",
          exitCode: 0,
          durationMs: 12,
        }),
      ),
      failure
        ? harness.notify(turnCompleted({ id: "turn-1", status: "failed", error: failure }))
        : harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" }),
    ]);
    const result = await run;
    const selectedProfile = preserveNativeModel ? "openai:binding" : "openai:ordered";
    expect(onStart).toHaveBeenCalledWith(selectedProfile, expect.anything(), expect.anything());
    if (preserveNativeModel) {
      expect(params.registerPluginRuntimeRefreshConsumer).not.toHaveBeenCalled();
      expectResumeRequest(harness.requests, { threadId: "thread-1" });
      const resume = harness.requests.find((request) => request.method === "thread/resume");
      expect(resume?.params).not.toHaveProperty("model");
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        preserveNativeModel: true,
        authProfileId: selectedProfile,
        ...sourceSelection,
      });
    }
    expect(Boolean(readAttemptTerminal(result).promptError)).toBe(Boolean(failure));
    if (!failure) {
      expect(result.terminal).toEqual({ kind: "ok" });
    }
    expect(result.currentAttemptAssistant).toBeDefined();
    expect(result.replayMetadata).toMatchObject({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
    expect(result.itemLifecycle).toMatchObject({
      startedCount: 2,
      completedCount: 2,
      activeCount: 0,
    });
    const context = result.settledTurnFinalizationContext;
    expect(context).toMatchObject({
      source: "harness",
      selection: { ...sourceSelection, authProfileId: selectedProfile },
    });
    if (!(context instanceof settledTurnContext.CodexSettledTurnContext)) {
      throw new Error("Expected complete settled-turn evidence from the harness");
    }
    expect(context.data).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: expect.stringContaining(params.prompt) }],
      },
      {
        type: "function_call",
        call_id: "tool-settled",
        name: "bash",
        arguments: JSON.stringify({ command: "echo sent-to-alice", cwd: workspaceDir }),
      },
      { type: "function_call_output", call_id: "tool-settled", output: "sent-to-alice\n" },
    ]);
  });
  it("captures settled tool evidence when an active native compaction fails terminally", async () => {
    const storePath = path.join(tempDir, "settled-compaction-failure.sqlite");
    const sessionId = "session-settled-compaction-failure";
    const sessionFile = `agent:main:${sessionId}`;
    const workspaceDir = path.join(tempDir, "workspace-settled-compaction-failure");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    await attachSqliteSessionTarget(params, storePath, sessionId);
    params.prompt = "Finish the task and report the result.";
    params.onSettledTurn = async (attempt, captureContext) => {
      attempt.settledTurnFinalizationContext = await captureContext();
    };
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const command = {
      type: "commandExecution",
      id: "tool-settled",
      command: "echo completed-work",
      cwd: workspaceDir,
    };
    const error = {
      message: "remote compaction failed",
      codexErrorInfo: "other",
      additionalDetails: null,
    };
    // Native events arrive in wire order; local projection must not delay terminal receipt.
    await Promise.all([
      harness.notify(
        itemNotification("item/started", {
          ...command,
          status: "inProgress",
        }),
      ),
      harness.notify(
        itemNotification("item/completed", {
          ...command,
          status: "completed",
          aggregatedOutput: "completed-work\n",
          exitCode: 0,
          durationMs: 12,
        }),
      ),
      harness.notify(
        itemNotification("item/started", { type: "contextCompaction", id: "compact-failed" }),
      ),
      harness.notify({
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          error,
          willRetry: false,
        },
      }),
      harness.notify(turnCompleted({ id: "turn-1", status: "failed", error })),
    ]);

    const result = await run;

    expect(readAttemptTerminal(result)).toMatchObject({
      promptError: "remote compaction failed",
      promptErrorSource: "compaction",
    });
    expect(result.itemLifecycle).toEqual({ startedCount: 2, completedCount: 1, activeCount: 0 });
    expect(result.settledTurnFinalizationContext).toMatchObject({
      source: "harness",
      data: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ type: "function_call" }),
        expect.objectContaining({ type: "function_call_output", call_id: "tool-settled" }),
      ],
    });
  });
}
