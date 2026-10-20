import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { assignSessionOwner, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { receiveEvent, seedSession } from "./session-sharing.fixture.test-support.js";
import {
  createSessionListEntryFilter,
  resolveSessionSharingRole,
  resolveSessionSharingTargetAsync,
} from "./session-sharing.js";
import { rolePolicyConfig } from "./session-sharing.test-utils.js";

it("reuses caller alias facts across rows and refreshes them after a real merge", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const caller = ensureProfileForEmail("cached-caller@example.test");
    const other = ensureProfileForEmail("cached-other@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const actor = { type: "human", source: "profile", id: other.id } as const;
    const db = openOpenClawStateDatabase().db;
    const prepare = vi.spyOn(db, "prepare");
    try {
      expect(isSessionCreatorProfile({ ...actor, source: "channel" }, caller.id)).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      for (let row = 0; row < 100; row++) {
        expect(isSessionCreatorProfile(actor, caller.id)).toBe(false);
      }
      expect(prepare).not.toHaveBeenCalled();
      linkEmail("cached-other@example.test", caller.id);
      prepare.mockClear();
      expect(isSessionCreatorProfile(actor, caller.id)).toBe(true);
      expect(isSessionCreatorProfile({ ...actor, source: "unknown" }, caller.id)).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });
});

it("never turns matching attribution or responsibility into a profile creator grant", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const profile = ensureProfileForEmail("creator@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const client = {
      connect: { scopes: ["operator.read", "operator.write"] },
      authenticatedUserProfile: { profileId: profile.id },
    } as GatewayClient;
    const cfg = rolePolicyConfig();
    cfg.gateway!.roles!.default = "none";
    setRuntimeConfigSnapshot(cfg);
    const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
    const actors = [
      { type: "human", source: "profile" },
      { type: "human", source: "channel" },
      { type: "human", source: "unknown" },
      { type: "agent" },
      { type: "system" },
    ] as const;
    for (const actor of actors) {
      const sessionKey = `agent:main:creator-${actor.type}-${"source" in actor ? actor.source : "native"}`;
      const scope = { agentId: "main", sessionKey };
      const entry = {
        sessionId: sessionKey,
        updatedAt: 1,
        createdVia: "cron" as const,
        createdActor: { ...actor, id: profile.id },
        visibility: "draft" as const,
      };
      await upsertSessionEntryCore(scope, entry);
      const owner = { type: "human", id: profile.id } as const;
      assignSessionOwner(scope, { owner, assignedBy: owner });
      const target = await resolveSessionSharingTargetAsync({ cfg, sessionKey });
      assert(target, "missing persisted session");
      const isCreator = actor.type === "human" && actor.source === "profile";
      expect
        .soft(resolveSessionSharingRole({ cfg, client, target, isMember: false }), sessionKey)
        .toBe(isCreator ? "owner" : "viewer");
      const listed = createSessionListEntryFilter({ cfg, client })?.(sessionKey, target.entry);
      expect.soft(listed, sessionKey).toBe(isCreator);
      for (let pass = 0; pass < 2; pass++) {
        const received = await receiveEvent(cfg, client, sessionKey);
        expect.soft(received, sessionKey).toBe(isCreator);
      }
      for (const method of ["sessions.get", "sessions.patch"]) {
        const result = await resolveSessionMutationAuthorizationAsync({
          client,
          method,
          requestParams: { key: sessionKey },
          context,
        });
        expect.soft(result.error === null, `${sessionKey}: ${method}`).toBe(isCreator);
      }
    }
  });
});

it("resolves profile tombstones after warming event snapshots without rewriting creators", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    setRuntimeConfigSnapshot({});
    const old = ensureProfileForEmail("old@example.test");
    const current = ensureProfileForEmail("current@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const client = {
      connect: { scopes: ["operator.read"] },
      authenticatedUserProfile: { profileId: current.id },
    } as GatewayClient;
    const sessionKey = "agent:main:merged-creator";
    await seedSession(sessionKey, "merged-creator", {
      visibility: "draft",
      createdVia: "operator",
      createdActor: { type: "human", source: "profile", id: old.id },
    });
    const receive = () => receiveEvent({}, client, sessionKey);
    expect(await receive()).toBe(false);
    linkEmail("old@example.test", current.id);
    expect(await receive()).toBe(true);
    const target = await resolveSessionSharingTargetAsync({ cfg: {}, sessionKey });
    assert(target, "missing merged creator session");
    expect(target.entry.createdActor?.id).toBe(old.id);
    expect(resolveSessionSharingRole({ client, target, isMember: false })).toBe("owner");
    expect(createSessionListEntryFilter({ client })?.(sessionKey, target.entry)).toBe(true);
  });
});
