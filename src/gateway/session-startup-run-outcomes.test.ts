import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayStartupSessions } from "./server-startup-session-migration.js";

it("settles legacy liveness once before startup returns, preserving recovery claims and history", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async ({ env, stateDir }) => {
    const databaseOptions = { agentId: "main", env };
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const log = { info: vi.fn(), warn: vi.fn() };
    const recovery: Partial<InternalSessionEntry> = {
      mainRestartRecovery: { cycleId: "original-cycle", revision: 3, chargedAttempts: 1 },
      restartRecoveryRuns: [{ runId: "original-run", lifecycleGeneration: "predecessor" }],
      restartRecoveryBeforeAgentReplyState: "admitted",
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryRunId: "delivery-run",
      restartRecoveryDeliverySourceRunId: "source-run",
    };
    const makeFixture = (
      key: string,
      status: "running" | "queued" | "done" | "failed",
      fields = recovery,
    ) => ({ sessionKey: `agent:main:${key}`, sessionId: key, status, fields });
    const legacy = [
      makeFixture("main", "running"),
      makeFixture("dashboard:unclaimed-queued", "queued", {}),
      ...["dashboard:work", "subagent:child"].flatMap((kind) =>
        (["running", "queued"] as const).map((status) => makeFixture(`${kind}:${status}`, status)),
      ),
      makeFixture("dashboard:spawned", "running", { spawnDepth: 1 }),
      makeFixture("dashboard:role-spawned", "running", { subagentRole: "leaf" }),
      makeFixture("dashboard:abort-only", "running", {
        abortedLastRun: true,
        restartRecoveryForceSafeTools: true,
      }),
      makeFixture("dashboard:archived-unclaimed", "running", { archivedAt: 15 }),
      makeFixture("dashboard:archived", "running", {
        ...recovery,
        archivedAt: 15,
        endedAt: 15,
        pendingFinalDelivery: { kind: "replayable", text: "Retained final", createdAt: 15 },
      }),
    ];
    const controls = (["done", "failed"] as const).map((status) =>
      makeFixture(`dashboard:${status}`, status),
    );
    const fixtures = [...legacy, ...controls];
    const before = new Map<string, InternalSessionEntry>();
    const history = new Map<string, Awaited<ReturnType<typeof loadTranscriptEvents>>>();
    for (const fixture of fixtures) {
      const scope = { ...databaseOptions, ...fixture };
      replaceSessionEntrySync(scope, {
        sessionId: fixture.sessionId,
        updatedAt: 20,
        startedAt: 10,
        status: fixture.status === "failed" ? "failed" : "done",
        lifecycleRevision: "original-revision",
        lifecycleRunId: "original-run",
        ...fixture.fields,
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          { eventId: "retained-message", message: { role: "user", content: "retained history" } },
        ],
        touchSessionEntry: false,
      });
      before.set(fixture.sessionKey, loadSessionEntryReadOnly(scope)!);
      history.set(fixture.sessionKey, await loadTranscriptEvents(scope));
    }
    const database = openOpenClawAgentDatabase(databaseOptions);
    // Keep legacy outcomes certified: startup, not the row loader, must discover them.
    const update = database.db.prepare(
      "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.status', ?) WHERE session_key = ?",
    );
    const certify = database.db.prepare(
      "UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?",
    );
    for (const fixture of legacy) {
      update.run(fixture.status, fixture.sessionKey);
      certify.run(fixture.sessionKey);
    }
    await closeOpenClawAgentDatabasesAsync(stateDir);

    await prepareGatewayStartupSessions({ cfg, env, log });

    const first = new Map<string, InternalSessionEntry>();
    for (const fixture of fixtures) {
      const scope = { ...databaseOptions, ...fixture };
      const entry = loadSessionEntryReadOnly(scope)!;
      first.set(fixture.sessionKey, entry);
      if (fixture.status === "running" || fixture.status === "queued") {
        expect(entry).toEqual({
          ...before.get(fixture.sessionKey),
          status: "interrupted",
          abortedLastRun: true,
          endedAt: before.get(fixture.sessionKey)?.endedAt ?? 20,
          lastRunError: expect.stringMatching(/interrupt|restart|Gateway/i),
          ...(fixture.sessionId === "dashboard:abort-only"
            ? {
                mainRestartRecovery: {
                  cycleId: expect.any(String),
                  revision: 1,
                  chargedAttempts: 0,
                },
              }
            : {}),
        });
      } else {
        expect(entry).toEqual(before.get(fixture.sessionKey));
      }
      expect(await loadTranscriptEvents(scope)).toEqual(history.get(fixture.sessionKey));
    }
    const notices = log.info.mock.calls.filter(([message]) => /interrupt/i.test(message));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.[0]).toMatch(/\b11\b/);

    log.info.mockClear();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    await prepareGatewayStartupSessions({ cfg, env, log });

    for (const fixture of fixtures) {
      expect(loadSessionEntryReadOnly({ ...databaseOptions, ...fixture })).toEqual(
        first.get(fixture.sessionKey),
      );
    }
    expect(log.info.mock.calls.filter(([message]) => /interrupt/i.test(message))).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
