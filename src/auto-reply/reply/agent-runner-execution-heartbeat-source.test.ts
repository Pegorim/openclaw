import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractMessagingToolSourceReplyPayload } from "../../agents/embedded-agent-messaging-extraction.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { createOpenClawToolsAsync } from "../../agents/openclaw-tools.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { GetReplyOptions } from "../types.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  useProductionEmbeddedRunExecutionParamsForTest,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();

async function heartbeatRuntime(
  runtime: "cli" | "embedded",
  sessionKey: string,
  opts: GetReplyOptions = {},
) {
  const isCli = runtime === "cli";
  const provider = isCli ? "claude-cli" : "anthropic";
  const model = isCli ? "sonnet-4.6" : "claude";
  const followupRun = createFollowupRun();
  Object.assign(followupRun.run, { provider, model, sessionKey });
  state.isCliProviderMock.mockReturnValue(isCli);
  await useProductionEmbeddedRunExecutionParamsForTest();
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
    result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
    provider,
    model,
    attempts: [],
  }));
  const params = createMinimalRunAgentTurnParams({
    followupRun,
    opts: { isHeartbeat: true, ...opts },
  });
  params.isHeartbeat = true;
  return {
    params: { ...params, sessionKey },
    followupRun,
    isCli,
    runAgent: isCli ? state.runCliAgentMock : state.runEmbeddedAgentMock,
  };
}

describe.each(["cli", "embedded"] as const)("heartbeat %s source delivery", (runtime) => {
  it.each([false, true, undefined])(
    "honors the admitted explicit-target policy (%s) at message-tool creation",
    async (requireExplicitMessageTarget) => {
      const sessionKey = "agent:main:dashboard:completion";
      const { followupRun, runAgent, params } = await heartbeatRuntime(runtime, sessionKey, {
        requireExplicitMessageTarget,
      });
      followupRun.run.messageProvider = "webchat";
      followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
      followupRun.originatingChannel = "webchat";
      followupRun.originatingTo = sessionKey;
      followupRun.originatingChatType = "direct";
      let sourceReply:
        | Awaited<
            ReturnType<Awaited<ReturnType<typeof createOpenClawToolsAsync>>[number]["execute"]>
          >
        | undefined;
      let sendError: unknown;
      runAgent.mockImplementationOnce(async (runParams: RunEmbeddedAgentInternalParams) => {
        // Exercise the actual runner policy and tool factory while the run owns delivery.
        const message = (
          await createOpenClawToolsAsync({
            config: runParams.config,
            agentSessionKey: runParams.sessionKey,
            workspaceDir: runParams.workspaceDir,
            runId: runParams.runId,
            agentChannel: runParams.messageProvider,
            currentChannelId: runParams.currentChannelId,
            requireExplicitMessageTarget: runParams.requireExplicitMessageTarget,
            sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
          })
        ).find((tool) => tool.name === "message");
        if (!message) {
          throw new Error("message tool was not created");
        }
        try {
          sourceReply = await message.execute("completion-send", {
            action: "send",
            message: "WEBCHAT_SOURCE_REPLY",
          });
        } catch (error) {
          sendError = error;
        }
        return { payloads: [], meta: {} };
      });
      params.sessionCtx = {
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        OriginatingTo: sessionKey,
        To: sessionKey,
        ChatType: "direct",
        SessionKey: sessionKey,
      };
      const result = await executeAgentTurn(params);
      expect(result.kind).toBe("success");
      expect(runAgent).toHaveBeenCalledOnce();
      if (requireExplicitMessageTarget === false) {
        expect(sendError).toBeUndefined();
        expect(sourceReply?.details).toMatchObject({
          channel: "webchat",
          sourceReplySink: "internal-ui",
        });
        expect(extractMessagingToolSourceReplyPayload(sourceReply)?.text).toBe(
          "WEBCHAT_SOURCE_REPLY",
        );
      } else {
        expect(sendError).toBeInstanceOf(Error);
        expect(String(sendError)).toMatch(/Explicit message target required/);
        expect(sourceReply).toBeUndefined();
      }
    },
  );
  it("retains revoked source authority at runtime admission", async () => {
    const { followupRun, isCli, runAgent, params } = await heartbeatRuntime(
      runtime,
      "agent:main:dashboard:source-authority",
    );
    let current = true;
    const failures: unknown[] = [];
    runAgent.mockImplementationOnce(async (run: RunEmbeddedAgentInternalParams) => {
      current = false;
      const actions = [() => run.preparedRunAdmission!.assertSourceCurrent()];
      // CLI is already admitted; embedded admission must retain the same live authority.
      if (!isCli) {
        actions.push(async () => {
          await run.preparedRunAdmission!.admit(runtime, "source-test-runtime");
        });
      }
      for (const action of actions) {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      }
      return { payloads: [], meta: {} };
    });
    params.storePath = path.join(followupRun.run.workspaceDir, "sessions.json");
    const target = {
      agentId: followupRun.run.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      sessionId: followupRun.run.sessionId,
    };
    const entry = await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    expect(entry).not.toBeNull();
    params.getActiveSessionEntry = () => entry ?? undefined;
    await withSessionTranscriptWriteAssertion(
      target,
      () => {
        if (!current) {
          throw new Error("source revoked");
        }
      },
      () => executeAgentTurn(params),
    );
    expect(runAgent).toHaveBeenCalledOnce();
    expect(failures).toHaveLength(isCli ? 1 : 2);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("source revoked");
    }
  });
});
