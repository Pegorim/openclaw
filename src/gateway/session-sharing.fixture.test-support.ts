import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { canReceivePreparedSessionEvent, rolePolicyConfig } from "./session-sharing.test-utils.js";

export const sessionExecutionMethods = [
  "agent",
  "chat.send",
  "message.action",
  "send",
  "sessions.dispatch",
  "sessions.send",
  "sessions.steer",
  "talk.client.create",
  "talk.session.create",
  "tools.invoke",
  "wake",
] as const;

export const sessionParticipationMethods = [
  "chat.send",
  "mcp.app.callTool",
  "mcp.app.updateModelContext",
  "talk.client.create",
  "talk.client.toolCall",
  "talk.client.transcript",
  "talk.client.close",
  "talk.client.steer",
  "talk.session.create",
  "talk.session.steer",
  "taskSuggestions.create",
  "sessions.companion.reset",
  "wake",
] as const;

export function withSharingState(
  run: (cfg: OpenClawConfig) => Promise<void>,
  cfg = rolePolicyConfig(),
) {
  return withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    setRuntimeConfigSnapshot(cfg);
    await run(cfg);
  });
}

export function authorizationFor(
  context: GatewayRequestContext,
  retain: (release: () => void) => void,
) {
  return async (
    client: GatewayClient,
    method: string,
    requestParams: Record<string, unknown>,
    sessionScope?: Parameters<typeof resolveSessionMutationAuthorizationAsync>[0]["sessionScope"],
  ) => {
    const result = await resolveSessionMutationAuthorizationAsync({
      client,
      method,
      requestParams,
      context,
      sessionScope,
    });
    if (result.authorization?.release) {
      retain(result.authorization.release);
    }
    return result;
  };
}

export function receiveEvent(cfg: OpenClawConfig, client: GatewayClient, sessionKey: string) {
  return canReceivePreparedSessionEvent({ cfg, client, sessionKeys: [sessionKey] });
}

export function seedSession(
  sessionKey: string,
  sessionId: string,
  fields: Parameters<typeof upsertSessionEntryCore>[1],
  agentId = "main",
) {
  return upsertSessionEntryCore({ agentId, sessionKey }, { sessionId, updatedAt: 1, ...fields });
}

export function seedOwnedSession(
  key: string,
  id: string,
  owner: string,
  fields: Parameters<typeof upsertSessionEntryCore>[1] = {},
) {
  return seedSession(key, id, {
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: owner },
    ...fields,
  });
}
