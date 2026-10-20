import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readSessionMembersInWorker } from "../config/sessions/session-sharing-store.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import { registerRpcSource } from "../sessions/session-controller.rpc-sources.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { authorizeSessionSharingTarget } from "./session-sharing-policy.js";
import {
  allowedSessionVisibilities,
  authorizeIncognitoSessionTarget,
  authorizeResolvedSessionMutationAsync,
  createSessionListEntryFilter,
  resolveSessionSharingRole,
  resolveSessionSharingTargetAsync,
  resolveSessionVisibility,
  SessionMutationAuthorizationChangedError,
} from "./session-sharing.js";
import {
  canReceivePreparedSessionEvent,
  sharingPolicyClient as client,
  sharingPolicyTarget as target,
  roleClient,
  rolePolicyConfig,
} from "./session-sharing.test-utils.js";
import { createRpcSourceForTest } from "./test-helpers.rpc-source.js";

const authorizationReleases: Array<() => void> = [];

afterEach(() => {
  for (const release of authorizationReleases.splice(0)) {
    release();
  }
  closeOpenClawAgentDatabasesForTest();
});

function authorizationFor(context: GatewayRequestContext) {
  return async (
    requestClient: GatewayClient,
    method: string,
    requestParams: Record<string, unknown>,
    sessionScope?: Parameters<typeof resolveSessionMutationAuthorizationAsync>[0]["sessionScope"],
  ) => {
    const result = await resolveSessionMutationAuthorizationAsync({
      client: requestClient,
      method,
      requestParams,
      context,
      sessionScope,
    });
    if (result.authorization?.release) {
      authorizationReleases.push(result.authorization.release);
    }
    return result;
  };
}

function receiveEvent(
  cfg: Parameters<typeof canReceivePreparedSessionEvent>[0]["cfg"],
  requestClient: GatewayClient,
  sessionKey: string,
) {
  return canReceivePreparedSessionEvent({ cfg, client: requestClient, sessionKeys: [sessionKey] });
}

function seedSession(
  sessionKey: string,
  sessionId: string,
  fields: Parameters<typeof upsertSessionEntryCore>[1],
  agentId = "main",
) {
  return upsertSessionEntryCore({ agentId, sessionKey }, { sessionId, updatedAt: 1, ...fields });
}

type SharingTarget = Parameters<typeof resolveSessionSharingRole>[0]["target"];

function isListed(
  requestClient: GatewayClient,
  sessionKey: string,
  entry: SharingTarget["entry"],
): boolean {
  return createSessionListEntryFilter({ client: requestClient })?.(sessionKey, entry) ?? true;
}

describe("session sharing policy", () => {
  it("reserves communication changes for the direct human creator or administrator", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      const creator = roleClient("write", "communication-creator");
      const peer = roleClient("write", "communication-peer");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const creatorId = creator.authenticatedUserProfile?.profileId;
      if (!creatorId) {
        throw new Error("expected verified creator");
      }
      const scope = { agentId: "main", sessionKey: "agent:main:communication" };
      await upsertSessionEntryCore(scope, {
        sessionId: "communication-session",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: creatorId },
      });
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const authorize = authorizationFor(context);
      const communicate = (requestClient: GatewayClient, many = false) =>
        authorize(
          requestClient,
          many ? "sessions.patchMany" : "sessions.patch",
          many
            ? { targets: [{ key: scope.sessionKey }], patch: { communication: null } }
            : { key: scope.sessionKey, communication: { receive: "never" } },
        );
      for (const many of [false, true]) {
        expect((await communicate(peer, many)).error).toMatchObject({ code: "FORBIDDEN" });
        expect((await communicate(creator, many)).error).toBeNull();
      }
      const admin = roleClient("write", "communication-admin");
      admin.connect.scopes = ["operator.admin"];
      expect((await communicate(admin)).error).toBeNull();
      expect(
        (await communicate({ ...admin, internal: { syntheticClient: true } })).error,
      ).toMatchObject({
        code: "FORBIDDEN",
        message: "Session communication settings require a direct human request.",
      });
      const admitted = await communicate(creator);
      creator.authenticatedUserProfile = peer.authenticatedUserProfile;
      expect(() => admitted.authorization?.assertCurrent()).toThrow(
        SessionMutationAuthorizationChangedError,
      );
    });
  });

  it("keeps shared VIEW while limiting narrow writes to the caller's own rows", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      const owner = roleClient("view", "narrow-owner");
      const member = roleClient("view", "narrow-member");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const ownerId = owner.authenticatedUserProfile?.profileId;
      const memberId = member.authenticatedUserProfile?.profileId;
      if (!ownerId || !memberId) {
        throw new Error("expected verified fixture profiles");
      }
      const scope = { agentId: "main", sessionKey: "agent:main:narrow-owned" };
      await upsertSessionEntryCore(scope, {
        sessionId: "narrow-owned",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: ownerId },
      });
      const row = await resolveSessionSharingTargetAsync({ cfg, ...scope });
      if (!row) {
        throw new Error("expected persisted fixture session");
      }
      addSessionMember(
        { ...scope, storePath: row.storePath },
        { identityId: memberId, addedBy: ownerId, expectedSessionId: "narrow-owned" },
      );
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const authorize = authorizationFor(context);
      const mutation = async (requestClient: GatewayClient) => {
        const admission = authorizeOperatorScopesForMethod(
          "sessions.patch",
          requestClient.connect.scopes ?? [],
        );
        expect(admission.allowed).toBe(true);
        return authorize(
          requestClient,
          "sessions.patch",
          { key: scope.sessionKey, label: "updated" },
          admission.allowed ? admission.sessionScope : undefined,
        );
      };
      expect((await mutation(member)).error).toBeNull();
      member.connect.scopes = ["operator.sessions.write"];
      expect(
        createSessionListEntryFilter({ client: member, cfg })?.(scope.sessionKey, row.entry),
      ).toBe(true);
      expect((await mutation(member)).error).toMatchObject({ code: "FORBIDDEN" });
      // The generic owner must not subtract an independently admitted capability.
      expect(
        await authorizeResolvedSessionMutationAsync({ cfg, client: member, ...scope }),
      ).toBeNull();
      owner.connect.scopes = ["operator.sessions.write"];
      const owned = await mutation(owner);
      expect(owned.error).toBeNull();
      expect(owned.authorization).toBeDefined();
      expect(() => owned.authorization?.assertCurrent()).not.toThrow();

      // A later scope upgrade or account switch must not release the captured own-row boundary.
      owner.connect.scopes = ["operator.write"];
      owner.authenticatedUserProfile = member.authenticatedUserProfile;
      expect(() => owned.authorization?.assertCurrent()).toThrow(
        SessionMutationAuthorizationChangedError,
      );
      expect(() => owned.authorization?.assertTargetCurrent(scope)).toThrow(
        SessionMutationAuthorizationChangedError,
      );
    });
  });

  it("retains the original person when narrow session creation has no row yet", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const owner = roleClient("view", "narrow-create-owner");
      owner.connect.scopes = ["operator.sessions.write"];
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      const captured = await authorizationFor(
        createDirectChatContext({ getRuntimeConfig: () => cfg }),
      )(owner, "sessions.create", {}, "operator.sessions.write");
      expect(captured.error).toBeNull();
      expect(captured.authorization).toBeDefined();
      expect(() => captured.authorization?.assertCurrent()).not.toThrow();
      owner.connect.scopes = ["operator.sessions.read"];
      expect(() => captured.authorization?.assertCurrent()).toThrow(
        SessionMutationAuthorizationChangedError,
      );
    });
  });

  it("denies starting a run on an existing foreign-agent session despite foreign-session write access", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig(["guest-agent"]);
      setRuntimeConfigSnapshot(cfg);
      const writer = roleClient("write", "foreign-agent-writer");
      const owner = ensureProfileForEmail("foreign-agent-owner@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const sessionKey = "agent:main:existing-maintainer-session";
      await seedSession(sessionKey, "existing-maintainer-session", {
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: owner.id },
      });

      expect(
        await authorizeResolvedSessionMutationAsync({
          cfg,
          client: writer,
          sessionKey,
          agentId: "main",
        }),
      ).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("main") });
      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      const authorize = authorizationFor(context);
      for (const [method, requestParams] of [
        ["agent", { sessionKey }],
        ["chat.send", { sessionKey }],
        ["sessions.goal.update", { sessionKey, action: "resume" }],
        ["sessions.providerReview.continue", { sessionKey }],
        ["message.action", { sessionKey }],
        ["send", { sessionKey }],
        ["sessions.dispatch", { key: sessionKey }],
        ["sessions.send", { key: sessionKey }],
        ["sessions.steer", { key: sessionKey }],
        ["talk.client.create", { sessionKey }],
        ["talk.session.create", { sessionKey }],
        ["tools.invoke", { sessionKey }],
        ["wake", { sessionKey }],
      ] as const) {
        const denied = await authorize(writer, method, requestParams);
        expect(denied.error, method).toMatchObject({
          code: "FORBIDDEN",
          message: expect.stringContaining("main"),
        });
      }
      for (const [method, requestParams] of [
        ["sessions.patch", { key: sessionKey }],
        ["sessions.goal.update", { sessionKey, action: "pause" }],
        ["sessions.goal.clear", { sessionKey }],
      ] as const) {
        const permitted = await authorize(writer, method, requestParams);
        expect(permitted.error, method).toBeNull();
      }
    });
  });

  it("enforces closed role ceilings above shared visibility while preserving explicit membership and admin access", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      const owner = roleClient("none", "owner");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const ownerId = owner.authenticatedUserProfile?.profileId;
      const sessionKey = "agent:main:team-shared";
      await seedSession(sessionKey, "session-team-shared", {
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: ownerId! },
      });
      const sharedTarget = await resolveSessionSharingTargetAsync({ cfg, sessionKey });
      expect(sharedTarget).not.toBeNull();
      if (!sharedTarget) {
        throw new Error("expected persisted team session");
      }
      const sharing = { cfg, target: sharedTarget };

      for (const roleName of ["view", "suggest"] as const) {
        const viewer = roleClient(roleName);
        expect(resolveSessionSharingRole({ ...sharing, client: viewer, isMember: false })).toBe(
          "viewer",
        );
        expect(
          authorizeSessionSharingTarget({ ...sharing, client: viewer, isMember: false }),
        ).toMatchObject({
          details: { code: "SESSION_PARTICIPATION_REQUIRED", visibility: "shared" },
        });
        for (const method of [
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
        ]) {
          const participation = await authorizationFor({
            getRuntimeConfig: () => cfg,
          } as GatewayRequestContext)(viewer, method, { sessionKey });
          expect(participation.error, `${roleName}: ${method}`).toMatchObject({
            details: { code: "SESSION_PARTICIPATION_REQUIRED" },
          });
        }
        const assignment = await authorizationFor({
          getRuntimeConfig: () => cfg,
        } as GatewayRequestContext)(viewer, "sessions.assignOwner", { key: sessionKey });
        expect(assignment.error).toMatchObject({
          details: { code: "SESSION_PARTICIPATION_REQUIRED" },
        });
        for (const method of [
          "chat.history",
          "chat.startup",
          "chat.metadata",
          "sessions.companion.ask",
          "sessions.companion.state",
        ]) {
          const read = await authorizationFor({
            getRuntimeConfig: () => cfg,
          } as GatewayRequestContext)(viewer, method, { sessionKey });
          expect(read.error, `${roleName}: ${method}`).toBeNull();
        }

        addSessionMember(
          { agentId: "main", sessionKey },
          {
            identityId: viewer.authenticatedUserProfile!.profileId,
            addedBy: ownerId!,
            expectedSessionId: "session-team-shared",
          },
        );
        const isMember = (
          await readSessionMembersInWorker({ agentId: "main", sessionKey })
        ).members.some(
          (member) => member.identityId === viewer.authenticatedUserProfile!.profileId,
        );
        expect(resolveSessionSharingRole({ ...sharing, client: viewer, isMember })).toBe("member");
        expect(authorizeSessionSharingTarget({ ...sharing, client: viewer, isMember })).toBeNull();
      }

      const writer = roleClient("write");
      expect(resolveSessionSharingRole({ ...sharing, client: writer })).toBe("member");
      expect(authorizeSessionSharingTarget({ ...sharing, client: writer })).toBeNull();

      const unassigned = ensureProfileForEmail("unassigned@example.test");
      expect(
        authorizeSessionSharingTarget({
          ...sharing,
          client: client({ user: unassigned.id }),
          isMember: (
            await readSessionMembersInWorker({ agentId: "main", sessionKey })
          ).members.some((member) => member.identityId === unassigned.id),
        }),
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      expect(resolveSessionSharingRole({ ...sharing, client: owner })).toBe("owner");
      expect(authorizeSessionSharingTarget({ ...sharing, client: owner })).toBeNull();

      const admin = client({ user: unassigned.id, scopes: ["operator.admin"] });
      expect(resolveSessionSharingRole({ ...sharing, client: admin })).toBe("admin");
      expect(authorizeSessionSharingTarget({ ...sharing, client: admin })).toBeNull();
      expect(
        authorizeSessionSharingTarget({
          ...sharing,
          cfg: {},
          client: writer,
          isMember: (
            await readSessionMembersInWorker({ agentId: "main", sessionKey })
          ).members.some(
            (member) => member.identityId === writer.authenticatedUserProfile?.profileId,
          ),
        }),
      ).toBeNull();
      expect(authorizeSessionSharingTarget({ ...sharing, client: client({}) })).toMatchObject({
        code: "INVALID_REQUEST",
      });
      const systemOwner = client({});
      systemOwner.internal = { operatorRoleActor: { kind: "system" } };
      expect(authorizeSessionSharingTarget({ ...sharing, client: systemOwner })).toBeNull();
      expect(
        createSessionListEntryFilter({ cfg, client: client({}) })?.(sessionKey, sharedTarget.entry),
      ).toBe(false);
      expect(createSessionListEntryFilter({ cfg, client: systemOwner })).toBeUndefined();
      expect(await receiveEvent(cfg, client({}), sessionKey)).toBe(false);
    });
  });

  it("keeps draft and incognito carve-outs even for roles permitting foreign-session writes", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      const writer = roleClient("write", "draft-writer");
      const owner = ensureProfileForEmail("draft-owner@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };

      for (const visibility of ["draft", "incognito"] as const) {
        const sessionKey = `agent:main:dashboard:${visibility === "incognito" ? "incognito-" : ""}role-carveout`;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: `session-${visibility}`,
            updatedAt: 1,
            visibility: visibility === "draft" ? "draft" : "shared",
            ...(visibility === "incognito" ? { incognito: true as const } : {}),
            createdActor: { type: "human", source: "profile", id: owner.id },
          },
        );
        const restricted = await resolveSessionSharingTargetAsync({ cfg, sessionKey });
        expect(restricted).not.toBeNull();
        if (!restricted) {
          throw new Error("expected persisted restricted session");
        }
        expect(
          resolveSessionSharingRole({ cfg, client: writer, target: restricted, isMember: false }),
        ).toBe("viewer");
        const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
        const authorize = authorizationFor(context);
        const authorization = await authorize(writer, "chat.send", { sessionKey });
        expect(authorization.error).not.toBeNull();
      }
    });
  });

  it("hides foreign cron sessions with none access across listings, reads, mutations, and broadcasts", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      const creator = roleClient("none", "cron-creator");
      const creatorId = creator.authenticatedUserProfile!.profileId;
      const restricted = roleClient("none", "restricted");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const restrictedId = restricted.authenticatedUserProfile!.profileId;
      const foreignKey = "agent:main:cron:job-1:run:run-1";
      const ownKey = "agent:main:team-own";
      const foreignEntry = {
        sessionId: "session-cron-run",
        updatedAt: 1,
        createdVia: "cron" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: creatorId },
      };
      await upsertSessionEntryCore({ agentId: "main", sessionKey: foreignKey }, foreignEntry);
      await seedSession(ownKey, "session-team-own", {
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: restrictedId },
      });
      addSessionMember(
        { agentId: "main", sessionKey: foreignKey },
        { identityId: restrictedId, addedBy: creatorId, expectedSessionId: foreignEntry.sessionId },
      );

      const entryFilter = createSessionListEntryFilter({ cfg, client: restricted });
      const creatorEntryFilter = createSessionListEntryFilter({ cfg, client: creator });
      expect(entryFilter?.(foreignKey, foreignEntry)).toBe(false);
      expect(creatorEntryFilter?.(foreignKey, foreignEntry)).toBe(true);
      expect(
        entryFilter?.(ownKey, {
          createdActor: { type: "human", source: "profile", id: restrictedId },
        }),
      ).toBe(true);
      expect(await receiveEvent(cfg, restricted, foreignKey)).toBe(false);
      expect(await receiveEvent(cfg, creator, foreignKey)).toBe(true);
      expect(await receiveEvent(cfg, restricted, ownKey)).toBe(true);

      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      const authorize = authorizationFor(context);
      for (const [method, requestParams] of [
        ["chat.history", { sessionKey: foreignKey }],
        ["chat.metadata", { sessionKey: foreignKey }],
        ["chat.send", { sessionKey: foreignKey }],
        ["mcp.app.callTool", { sessionKey: foreignKey }],
        ["mcp.app.updateModelContext", { sessionKey: foreignKey }],
        ["sessions.get", { key: foreignKey }],
        ["sessions.assignOwner", { key: foreignKey }],
        ["sessions.resolve", { key: foreignKey }],
        ["sessions.preview", { keys: [foreignKey] }],
        ["sessions.search", { sessionKeys: [foreignKey] }],
        ["sessions.files.list", { sessionKey: foreignKey }],
        ["sessions.files.get", { sessionKey: foreignKey }],
        ["sessions.branches.list", { sessionKey: foreignKey }],
        ["sessions.companion.ask", { sessionKey: foreignKey }],
        ["sessions.companion.reset", { sessionKey: foreignKey }],
        ["sessions.companion.state", { sessionKey: foreignKey }],
        ["artifacts.list", { sessionKey: foreignKey }],
        ["session.suggestions.list", { sessionKey: foreignKey }],
        ["session.typing", { sessionKey: foreignKey }],
        ["talk.client.create", { sessionKey: foreignKey }],
        ["talk.client.toolCall", { sessionKey: foreignKey }],
        ["talk.client.transcript", { sessionKey: foreignKey }],
        ["talk.client.close", { sessionKey: foreignKey }],
        ["talk.client.steer", { sessionKey: foreignKey }],
        ["talk.session.create", { sessionKey: foreignKey }],
        ["talk.session.steer", { sessionKey: foreignKey }],
        ["taskSuggestions.create", { sessionKey: foreignKey }],
        ["wake", { sessionKey: foreignKey }],
      ] as const) {
        const hidden = await authorize(restricted, method, requestParams);
        expect(hidden.error, method).toMatchObject({
          code: "INVALID_REQUEST",
          message: `Session "${foreignKey}" was not found.`,
        });
      }
      for (const method of ["chat.history", "chat.send"] as const) {
        const creatorRead = await authorize(creator, method, { sessionKey: foreignKey });
        expect(creatorRead.error, `creator ${method}`).toBeNull();
      }
      const ownRead = await authorize(restricted, "chat.history", { sessionKey: ownKey });
      expect(ownRead.error).toBeNull();
      expect(
        createSessionListEntryFilter({ cfg: {}, client: restricted })?.(foreignKey, foreignEntry),
      ).toBe(true);
      const admin = client({ user: restrictedId, scopes: ["operator.admin"] });
      expect(createSessionListEntryFilter({ cfg, client: admin })).toBeUndefined();
      const adminRead = await authorize(admin, "chat.history", { sessionKey: foreignKey });
      expect(adminRead.error).toBeNull();
    });
  });

  it("returns retryable unavailability from direct session guards while profile sync is pending", async () => {
    const pending = client({ githubSyncPending: true });
    const ownedTarget = target({ type: "human", id: "profile-owner" });
    const incognitoTarget = {
      ...ownedTarget,
      canonicalKey: "agent:main:dashboard:incognito-direct-guard",
      entry: { ...ownedTarget.entry, incognito: true as const },
    };

    expect(
      authorizeIncognitoSessionTarget({
        client: pending,
        sessionKey: incognitoTarget.canonicalKey,
        target: incognitoTarget,
      }),
    ).toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
      details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
    });
    expect(
      (
        await resolveSessionMutationAuthorizationAsync({
          client: pending,
          method: "send",
          requestParams: { sessionKey: "agent:main:main" },
          context: {} as GatewayRequestContext,
        })
      ).error,
    ).toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
      details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
    });
  });

  it("requires participation for categorized adoption and message-cut lifecycle targets", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = {};
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:dashboard:categorized-adoption";
      await seedSession(sessionKey, "session-categorized-adoption", {
        visibility: "read-only",
        category: "Personal",
        createdActor: { type: "human", source: "profile", id: "owner@example.com" },
      });

      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      const authorize = authorizationFor(context);
      for (const [method, requestParams] of [
        ["sessions.create", { key: sessionKey, category: "Projects" }],
        ["sessions.fork", { sessionKey }],
        ["sessions.rewind", { sessionKey }],
        ["sessions.branches.switch", { sessionKey }],
      ] as const) {
        expect(
          await authorize(client({ user: "owner@example.com" }), method, requestParams),
          method,
        ).toMatchObject({ error: null, authorization: expect.any(Object) });
        const participation = await authorize(
          client({ user: "viewer@example.com" }),
          method,
          requestParams,
        );
        expect(participation.error, method).toMatchObject({
          details: { code: "SESSION_PARTICIPATION_REQUIRED" },
        });
      }
    });
  });

  it.each(["read-only", "suggest"] as const)(
    "preserves visibility-authorized owner assignment for %s sessions at commit",
    async (visibility) => {
      await withOpenClawTestState(
        { scenario: "minimal", prepareProfileCatalog: true },
        async () => {
          const cfg = {};
          setRuntimeConfigSnapshot(cfg);
          const sessionKey = `agent:main:assignment-${visibility}`;
          const cappedClient = roleClient("view", `assignment-${visibility}`);
          using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
          prepareGatewayRecipientProfile(cappedClient);
          await seedSession(sessionKey, `session-assignment-${visibility}`, {
            visibility,
            createdActor: { type: "human", source: "profile", id: "owner@example.com" },
          });
          const authorization = await authorizationFor({
            getRuntimeConfig: () => cfg,
          } as GatewayRequestContext)(
            client({ user: "viewer@example.com" }),
            "sessions.assignOwner",
            { key: sessionKey, owner: { type: "agent", id: "main" } },
          );

          expect(authorization.error).toBeNull();
          expect(() => authorization.authorization?.assertCurrent()).not.toThrow();

          const capped = await authorizationFor({
            getRuntimeConfig: () => rolePolicyConfig(),
          } as GatewayRequestContext)(cappedClient, "sessions.assignOwner", {
            key: sessionKey,
            owner: { type: "agent", id: "main" },
          });
          expect(capped.error).toMatchObject({
            details: { code: "SESSION_PARTICIPATION_REQUIRED" },
          });
        },
      );
    },
  );

  it("resolves sharing roles from admitted identity while preserving solo ownership", () => {
    const rawHandshakeOnly = client({});
    rawHandshakeOnly.authenticatedUserId = "viewer@example.com";
    rawHandshakeOnly.connect.device = {
      id: "viewer-device",
      publicKey: "key",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    };
    for (const [identity, requestClient, sharingTarget, role] of [
      [
        "pending profile",
        client({ githubSyncPending: true }),
        target({ type: "human", id: "profile-owner" }),
        "viewer",
      ],
      ["anonymous solo", client({}), target(), "owner"],
      ["profiled solo", client({ user: "gateway-owner" }), target(), "owner"],
      [
        "admitted owner",
        client({ user: "alice@example.com" }),
        target({ type: "human", id: "alice@example.com", label: "Alice" }),
        "owner",
      ],
      [
        "raw handshake only",
        rawHandshakeOnly,
        target({ type: "human", id: "owner@example.com", label: "Owner" }),
        "owner",
      ],
    ] as const) {
      expect(
        resolveSessionSharingRole({ client: requestClient, target: sharingTarget }),
        identity,
      ).toBe(role);
    }
  });

  it("keeps incognito admin-only while treating identityless connections as owner-equivalent", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = {};
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:dashboard:incognito-private";
      const sessionAlias = "dashboard:incognito-private";
      const entry = {
        ...target({ type: "human", id: "owner@example.com" }).entry,
        sessionId: "session-incognito",
        visibility: "shared" as const,
        incognito: true as const,
      };
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
      const owner = client({ user: "owner@example.com" });
      const viewer = client({ user: "viewer@example.com" });
      const admin = client({ user: "admin@example.com", scopes: ["operator.admin"] });
      const solo = client({});
      const profiledSolo = client({ user: "gateway-owner" });
      const context = { getRuntimeConfig: () => cfg } as never;
      const directRequests = (requestedKey: string) => [
        { method: "chat.history", requestParams: { sessionKey: requestedKey } },
        { method: "chat.metadata", requestParams: { sessionKey: requestedKey } },
        { method: "chat.send", requestParams: { sessionKey: requestedKey } },
        { method: "sessions.get", requestParams: { key: requestedKey } },
        { method: "sessions.preview", requestParams: { keys: [requestedKey] } },
        { method: "sessions.search", requestParams: { sessionKeys: [requestedKey] } },
      ];

      for (const [requestClient, visible] of [
        [admin, true],
        [solo, true],
        [profiledSolo, true],
        [owner, false],
        [viewer, false],
      ] as const) {
        expect(isListed(requestClient, sessionKey, entry)).toBe(visible);
        expect(await receiveEvent(cfg, requestClient, sessionKey)).toBe(visible);
        for (const requestedKey of [sessionKey, sessionAlias]) {
          for (const request of directRequests(requestedKey)) {
            const { error } = await authorizationFor(context)(
              requestClient,
              request.method,
              request.requestParams,
            );
            if (visible) {
              expect(error).toBeNull();
            } else {
              expect(error).toMatchObject({
                code: "INVALID_REQUEST",
                message: `Incognito session "${requestedKey}" was not found.`,
              });
            }
          }
        }
      }
    });
  });

  it("defaults legacy entries and omitted policy flags to enabled", () => {
    expect(resolveSessionVisibility({})).toBe("shared");
    expect(allowedSessionVisibilities({})).toEqual(["shared", "read-only", "suggest", "draft"]);
    expect(allowedSessionVisibilities({ session: { sharing: { suggest: false } } })).toEqual([
      "shared",
      "read-only",
      "draft",
    ]);
  });

  it("keeps agent scope for progress cards and indirect run and approval authorization", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = {
        agents: { entries: { main: {}, work: {} } },
      } as never;
      setRuntimeConfigSnapshot(cfg);
      await seedSession("global", "session-main-global", { visibility: "shared" });
      await seedSession(
        "global",
        "session-work-global",
        {
          visibility: "read-only",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
        "work",
      );
      await seedSession("agent:main:solo-draft", "session-solo-draft", { visibility: "draft" });
      const run = createRpcSourceForTest(
        {},
        {
          runId: "run-1",
          sessionKey: "global",
          sessionId: "session-work-global",
          agentId: "work",
          storeScope: resolveSessionStorePathCore(undefined, { agentId: "work" }),
        },
      );
      registerRpcSource("run-1", run);
      const context = {
        execApprovalManager: {
          lookupLocalApprovalId: () => ({ kind: "exact", id: "approval-1" }),
          getLocalSnapshot: () => ({ request: { sessionKey: "global", agentId: "work" } }),
        },
        getRuntimeConfig: () => cfg,
      } as never;
      const authorize = authorizationFor(context);
      const outsider = client({ user: "outsider@example.com" });

      for (const [method, requestParams] of [
        ["sessions.abort", { runId: "run-1" }],
        ["exec.approval.resolve", { id: "approval-1" }],
        ["progressCard.get", { sessionKey: "global", agentId: "work" }],
        ["progressCard.put", { sessionKey: "global", agentId: "work" }],
      ] as const) {
        const { error } = await authorize(outsider, method, requestParams);
        if (method === "progressCard.get") {
          expect(error).toBeNull();
        } else {
          expect(error).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
        }
      }
      for (const method of ["progressCard.get", "progressCard.put"]) {
        const read = await authorize(outsider, method, { sessionKey: "global", agentId: "main" });
        expect(read.error).toBeNull();
      }
      const soloSend = await authorize(client({}), "chat.send", {
        sessionKey: "agent:main:solo-draft",
      });
      expect(soloSend.error).toBeNull();
    });
  });

  it("fails closed when a required session mutation has no target", async () => {
    const context = { getRuntimeConfig: () => ({}) } as never;
    for (const method of ["sessions.reset", "sessions.move"]) {
      const { error } = await resolveSessionMutationAuthorizationAsync({
        client: client({}),
        method,
        requestParams: {},
        context,
      });
      expect(error, method).toHaveProperty("details.code", "SESSION_MUTATION_TARGET_REQUIRED");
    }
    const { error } = await resolveSessionMutationAuthorizationAsync({
      client: client({ scopes: ["operator.admin"] }),
      method: "sessions.reset",
      requestParams: {},
      context,
    });
    expect(error).toBeNull();
  });
});
