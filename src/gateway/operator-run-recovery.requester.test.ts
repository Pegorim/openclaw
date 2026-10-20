import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import type { RequesterOrigin } from "../agents/requester-origin.js";
import { createRestartRecoveryRequesterSource } from "../agents/requester-run-recovery-source.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { SessionTranscriptWriterClaimReboundError } from "../config/sessions/transcript-write-context.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

const restrictedModels = [{ provider: "fixture", model: "b" }];

type RecoveryFixture = Awaited<ReturnType<typeof createOperatorRecoveryFixture>>;
function captureRequester({ target, entry }: RecoveryFixture, requesterOrigin: RequesterOrigin) {
  return expectDefined(
    createRestartRecoveryRequesterSource({ ...target, entry, requesterOrigin }),
    "host-captured requester source",
  );
}

describe("restart recovery requester custody", () => {
  it("restores only the requester bound to the current durable source claim", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("requester-custody@example.test");
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: {},
      });
      const restore = () =>
        fixture.recover("requester").then(({ requesterOrigin }) => requesterOrigin);
      await expect(restore()).resolves.toBeUndefined();
      const origin = {
        sessionKey: "agent:research:telegram:group:requesters",
        messageProvider: "telegram",
        senderId: "bob",
      };
      const source = captureRequester(fixture, origin);
      const bound = { ...fixture.entry, restartRecoveryRequesterSource: source };
      const saveSource = (restartRecoveryRequesterSource: typeof source) =>
        replaceSessionEntry(fixture.target, { ...bound, restartRecoveryRequesterSource });
      await replaceSessionEntry(fixture.target, bound);
      origin.senderId = "alice";
      origin.sessionKey = "agent:research:telegram:group:replacement";
      await expect(restore()).resolves.toMatchObject({
        senderId: "bob",
        sessionKey: "agent:research:telegram:group:requesters",
      });
      const historical = structuredClone(source);
      Object.assign(historical.requesterOrigin, {
        senderIsOwner: true,
        conversationToolPolicy: { allow: ["*"] },
      });
      await saveSource(historical);
      const restoredFacts = await restore();
      expect(restoredFacts).not.toHaveProperty("senderIsOwner");
      expect(restoredFacts).not.toHaveProperty("conversationToolPolicy");
      for (const replacement of [
        { ...source, sessionId: "copied-session" },
        { ...source, sessionKey: "agent:main:copied" },
        { ...source, sourceRunId: "copied-run" },
        { ...source, lifecycleRevision: "replacement-lifecycle" },
      ]) {
        await saveSource(replacement);
        await expect(restore()).resolves.toBeUndefined();
      }
      for (const malformed of [
        { ...source.requesterOrigin, sessionKey: "" },
        { ...source.requesterOrigin, senderId: 7 },
        { ...source.requesterOrigin, senderId: undefined },
        { ...source.requesterOrigin, messageThreadId: {} },
      ]) {
        const invalid = structuredClone(source);
        Reflect.set(invalid, "requesterOrigin", malformed);
        await saveSource(invalid);
        await expect(restore()).resolves.toBeUndefined();
      }
      await replaceSessionEntry(fixture.target, {
        ...bound,
        restartRecoveryDeliveryRunId: "replacement-run",
      });
      await expect(restore()).rejects.toThrow("no longer owns this input");
      await replaceSessionEntry(fixture.target, bound);
      const pending = restore();
      fixture.retire();
      await expect(pending).rejects.toThrow("Recovery claim retired");
    });
  });

  it("restores requester custody and current operator policy across accepted compaction", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("model@example.test");
      setUserProfileRole(profile.id, "operator");
      const operator = {
        sessions: { others: "none" },
        agents: ["main"],
        scopes: ["operator.admin"],
        sandbox: "required",
        modelPolicy: { allow: ["fixture/a", "fixture/b"] },
      } satisfies GatewayOperatorRoleDefinition;
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "fixture/a" } },
        gateway: { roles: { definitions: { operator } } },
      };
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: cfg,
      });
      const requesterOrigin = {
        sessionKey: fixture.target.sessionKey,
        messageProvider: "webchat",
        senderId: profile.id,
        operatorProfileId: profile.id,
      };
      await replaceSessionEntry(fixture.target, {
        ...fixture.entry,
        restartRecoveryRequesterSource: captureRequester(fixture, requesterOrigin),
      });
      const current = structuredClone(cfg);
      expectDefined(current.gateway?.roles?.definitions.operator, "operator role").modelPolicy = {
        allow: ["fixture/b", "fixture/c"],
      };
      let target = { ...fixture.target };
      const restore = (sourceTarget = target) => fixture.recover("both", sourceTarget);
      expect(fixture.sourceAuthority.assertCurrent).toThrow();
      // This reuses authenticated source owners without a Gateway restart or model boot.
      let recovered = await restore();
      const active = expectDefined(recovered.operator, "initial recovered operator");
      const restoredAuthorities = [active];
      const readEntry = async () =>
        expectDefined(await readSessionEntryReadOnlyInWorker(target), "current entry");
      const compact = (
        currentTarget: typeof target,
        entry: typeof fixture.entry,
        sessionId: string,
        onCommitted?: () => void,
      ) =>
        acceptCompactionSuccessor({
          currentTarget,
          expectedEntry: entry,
          assertActive: active.authority.assertCurrent,
          onCommitted,
          result: { ok: true, compacted: true, result: { sessionId, tokensBefore: 120 } },
        });
      try {
        expect(recovered.requesterOrigin).toEqual(requesterOrigin);
        for (const sessionId of ["first-successor", "second-successor"]) {
          const predecessor = await readEntry();
          const predecessorTarget = target;
          const accepted = await compact(target, predecessor, sessionId, () => {
            if (sessionId === "second-successor") {
              throw new Error("compaction fact observer failed");
            }
          });
          expect(accepted.entry.sessionId).toBe(sessionId);
          fixture.setConfig(current);
          target = { ...fixture.target, sessionId };
          await expect(restore(predecessorTarget)).rejects.toThrow("no longer owns this input");
          recovered = await restore();
          const successor = expectDefined(recovered.operator, "restored successor authority");
          restoredAuthorities.push(successor);
          expect(recovered.requesterOrigin).toEqual(requesterOrigin);
          expect(active.authority.assertCurrent).not.toThrow();
          expect(active.authority.modelPolicy?.models).toEqual(restrictedModels);
          expect(successor.authority.modelPolicy?.models).toEqual(restrictedModels);
          expect(successor.authority.profileId).toBe(profile.id);
          expect(successor.authority.assertCurrent).not.toThrow();
        }
        const restored = expectDefined(recovered.operator, "model-restricted recovery");
        await expect(compact(fixture.target, fixture.entry, "stale-successor")).rejects.toThrow(
          SessionTranscriptWriterClaimReboundError,
        );
        expect(active.authority.assertCurrent).not.toThrow();
        expect(restored.authority.assertCurrent).not.toThrow();
        expect(restored.authority.rolePolicy).toMatchObject({
          agents: ["main"],
          sandboxRequired: true,
          sessionAccessCap: "none",
        });
        const widened = structuredClone(current);
        expectDefined(widened.gateway?.roles?.definitions.operator, "operator role").modelPolicy = {
          allow: ["fixture/a", "fixture/b", "fixture/c"],
        };
        fixture.setConfig(widened);
        expect(restored.authority.modelPolicy?.models).toEqual(restrictedModels);
        setUserProfileRole(profile.id, "revoked");
        expect(active.authority.assertCurrent).toThrow("authority changed");
        expect(restored.authority.assertCurrent).toThrow("authority changed");
        await expect(restore()).rejects.toThrow(/Restart recovery operator/);
        const retainedSuccessor = await readEntry();
        await expect(compact(target, retainedSuccessor, "revoked-successor")).rejects.toThrow(
          "authority changed",
        );
        expect((await readSessionEntryReadOnlyInWorker(target))?.sessionId).toBe(
          "second-successor",
        );
      } finally {
        for (const restored of restoredAuthorities.toReversed()) {
          restored.release();
        }
      }
    });
  });
});
