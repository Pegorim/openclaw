import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import {
  authorizeResolvedSessionMutationAsync,
  SessionMutationAuthorizationChangedError,
} from "./session-sharing.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

function sandboxRoleClient(role: "view" | "write"): GatewayClient {
  const profile = ensureProfileForEmail(`sandbox-required-${role}@example.test`);
  setUserProfileRole(profile.id, role);
  return sharingPolicyClient({ user: profile.id });
}

function roleDefinition(others: "view" | "write", sandbox?: "required") {
  return {
    sessions: { others },
    agents: "*" as const,
    scopes: ["operator.read", "operator.write"],
    ...(sandbox ? { sandbox } : {}),
  };
}

describe("session sharing sandbox requirements", () => {
  it("denies sandbox-required members host execution without changing session provenance", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "view",
            definitions: {
              view: roleDefinition("view", "required"),
              write: roleDefinition("write"),
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const guest = sandboxRoleClient("view");
      const maintainer = sandboxRoleClient("write");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      using authorizations = new DisposableStack();
      const guestId = guest.authenticatedUserProfile!.profileId;
      const maintainerId = maintainer.authenticatedUserProfile!.profileId;
      const hostSessionKey = "agent:main:maintainer-host-session";
      const sandboxSessionKey = "agent:main:guest-sandbox-session";

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: hostSessionKey },
        {
          sessionId: "maintainer-host-session",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: maintainerId },
        },
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: sandboxSessionKey },
        {
          sessionId: "guest-sandbox-session",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: guestId },
          sandbox: "required",
        },
      );
      addSessionMember(
        { agentId: "main", sessionKey: hostSessionKey },
        {
          identityId: guestId,
          addedBy: maintainerId,
          expectedSessionId: "maintainer-host-session",
        },
      );

      expect(
        await authorizeResolvedSessionMutationAsync({
          cfg,
          client: guest,
          sessionKey: hostSessionKey,
          agentId: "main",
        }),
      ).toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/sandbox/i) });

      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      const authorize = async (
        client: GatewayClient,
        method: string,
        requestParams: Record<string, unknown>,
        selectedContext = context,
      ) => {
        const result = await resolveSessionMutationAuthorizationAsync({
          client,
          method,
          requestParams,
          context: selectedContext,
        });
        authorizations.defer(() => result.authorization?.release?.());
        return result;
      };
      for (const method of [
        "agent",
        "chat.send",
        "message.action",
        "send",
        "sessions.dispatch",
        "sessions.send",
        "sessions.steer",
        "talk.client.create",
        "talk.client.toolCall",
        "talk.session.create",
        "tools.invoke",
        "wake",
      ]) {
        const requestParams = method.startsWith("sessions.")
          ? { key: hostSessionKey }
          : { sessionKey: hostSessionKey };
        expect((await authorize(guest, method, requestParams)).error, method).toMatchObject({
          code: "FORBIDDEN",
          message: expect.stringMatching(/sandbox/i),
        });
      }
      const patch = await authorize(guest, "sessions.patch", { key: hostSessionKey });
      expect(patch.error).toBeNull();

      for (const participant of [guest, maintainer]) {
        const sandboxRun = await authorize(participant, "chat.send", {
          sessionKey: sandboxSessionKey,
        });
        expect(sandboxRun.error).toBeNull();
      }

      cfg.gateway!.roles!.definitions.view!.sandbox = "inherit";
      const admittedHostRun = await authorize(guest, "chat.send", { sessionKey: hostSessionKey });
      expect(admittedHostRun.error).toBeNull();
      expect(admittedHostRun.authorization).toBeDefined();
      cfg.gateway!.roles!.definitions.view!.sandbox = "required";
      expect(() => admittedHostRun.authorization!.assertCurrent()).toThrow(
        SessionMutationAuthorizationChangedError,
      );

      const unscoped = await authorize(guest, "chat.send", { sessionKey: hostSessionKey }, {
        getRuntimeConfig: () => ({}),
      } as GatewayRequestContext);
      expect(unscoped.error).toBeNull();
    });
  });
});
