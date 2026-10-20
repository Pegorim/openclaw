// Persistent operator approval store tests cover terminal CAS, expiry, replay, and recovery.
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { withSqliteWriteAdmissionService } from "../infra/sqlite-transaction.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  consumeOperatorApprovalAllowOnce,
  forceDenyOperatorApproval,
  getOperatorApprovalDetailed,
  insertOperatorApproval,
  listPendingOperatorApprovals,
  listTerminalOperatorApprovals,
  OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS,
  OperatorApprovalHistoryCursorError,
  prepareOperatorApprovalReplay,
  recoverOperatorApprovalsOnStartup,
  resolveOperatorApproval,
} from "./operator-approval-store.js";
import { operatorApprovalOperations } from "./operator-approval-store.worker.js";

type OperatorApprovalDatabase = Pick<OpenClawStateKyselyDatabase, "operator_approvals">;
type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];
const OPERATOR_APPROVAL_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;

async function getOperatorApproval(params: Parameters<typeof getOperatorApprovalDetailed>[0]) {
  const result = await getOperatorApprovalDetailed(params);
  return result.outcome === "found" ? result.record : null;
}

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
let suiteDatabaseOptions: OpenClawStateDatabaseOptions | undefined;

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = tempDirs.make("openclaw-operator-approval-");
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function getSuiteDatabaseOptions(): OpenClawStateDatabaseOptions {
  return (suiteDatabaseOptions ??= createDatabaseOptions());
}

function approval(id: string, overrides: Partial<NewOperatorApproval> = {}): NewOperatorApproval {
  const kind = overrides.kind ?? overrides.presentation?.kind ?? "exec";
  const presentation: NewOperatorApproval["presentation"] =
    overrides.presentation ??
    (kind === "exec"
      ? {
          kind: "exec" as const,
          commandText: `echo ${id}`,
          commandPreview: `echo ${id}`,
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        }
      : {
          kind: "plugin" as const,
          title: "Approve plugin action",
          description: `Allow the plugin action for ${id}.`,
          severity: "warning" as const,
          pluginId: "test-plugin",
          toolName: "test-tool",
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        });
  return {
    id,
    kind,
    presentation,
    requester: {
      deviceId: "request-device",
      clientId: "request-client",
      deviceTokenAuth: true,
    },
    reviewerDeviceIds: ["reviewer-b", "reviewer-a", "reviewer-b"],
    source: {
      agentId: "main",
      sessionKey: "agent:main:child",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-call-1",
      toolName: "exec",
    },
    audienceSessionKeys: ["agent:main:child", "agent:main:parent"],
    runtimeEpoch: "runtime-a",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    ...overrides,
  };
}

function rawApprovalRow(options: OpenClawStateDatabaseOptions, id: string) {
  const database = openOpenClawStateDatabase(options);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("operator_approvals").selectAll().where("approval_id", "=", id),
  );
}

function createStore(databaseOptions = getSuiteDatabaseOptions()) {
  return {
    databaseOptions,
    insert: (id: string, overrides: Partial<NewOperatorApproval> = {}) =>
      insertOperatorApproval({ approval: approval(id, overrides), databaseOptions }),
    resolve: (
      id: string,
      decision: Parameters<typeof resolveOperatorApproval>[0]["decision"],
      params: Omit<Parameters<typeof resolveOperatorApproval>[0], "id" | "decision">,
    ) => resolveOperatorApproval({ ...params, id, decision, databaseOptions }),
    deny: (
      id: string,
      reason: Parameters<typeof forceDenyOperatorApproval>[0]["reason"],
      params: Omit<Parameters<typeof forceDenyOperatorApproval>[0], "id" | "reason">,
    ) => forceDenyOperatorApproval({ ...params, id, reason, databaseOptions }),
    consume: (
      id: string,
      consumerId: string,
      params: Omit<Parameters<typeof consumeOperatorApprovalAllowOnce>[0], "id" | "consumerId">,
    ) => consumeOperatorApprovalAllowOnce({ ...params, id, consumerId, databaseOptions }),
    getDetailed: (params: Parameters<typeof getOperatorApprovalDetailed>[0]) =>
      getOperatorApprovalDetailed({ ...params, databaseOptions }),
    get: (params: Parameters<typeof getOperatorApproval>[0]) =>
      getOperatorApproval({ ...params, databaseOptions }),
    pending: (params: Parameters<typeof listPendingOperatorApprovals>[0]) =>
      listPendingOperatorApprovals({ ...params, databaseOptions }),
    history: (params: Parameters<typeof listTerminalOperatorApprovals>[0]) =>
      listTerminalOperatorApprovals({ ...params, databaseOptions }),
    replay: (params: Parameters<typeof prepareOperatorApprovalReplay>[0]) =>
      prepareOperatorApprovalReplay({ ...params, databaseOptions }),
    recover: (params: Parameters<typeof recoverOperatorApprovalsOnStartup>[0]) =>
      recoverOperatorApprovalsOnStartup({ ...params, databaseOptions }),
    raw: (id: string) => rawApprovalRow(databaseOptions, id),
    corrupt: (
      id: string,
      fields: { presentation_json?: string; terminal_reason?: string; decision?: string },
    ) => {
      const { db } = openOpenClawStateDatabase(databaseOptions);
      const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(db);
      executeSqliteQuerySync(
        db,
        stateDb.updateTable("operator_approvals").set(fields).where("approval_id", "=", id),
      );
    },
  };
}

async function expectFilteredReplay(
  unrelated: Partial<NewOperatorApproval>,
  target: Partial<NewOperatorApproval>,
  selection: Parameters<typeof listPendingOperatorApprovals>[0],
) {
  const store = createStore();
  for (let index = 0; index < 256; index += 1) {
    await expect(
      store.insert(`unrelated-${String(index).padStart(3, "0")}`, {
        ...unrelated,
        createdAtMs: 1_000 + index,
      }),
    ).resolves.toMatchObject({ outcome: "inserted" });
  }
  await expect(
    store.insert("target-after-first-page", {
      ...target,
      createdAtMs: 2_000,
    }),
  ).resolves.toMatchObject({ outcome: "inserted" });
  await expect(store.pending({ ...selection, limit: 1, nowMs: 3_000 })).resolves.toMatchObject([
    { id: "target-after-first-page" },
  ]);
}

describe("operator approval store", () => {
  beforeEach(() => {
    if (!suiteDatabaseOptions) {
      return;
    }
    // Completed cases leave workers reusable; only their approval rows are isolated.
    runOpenClawStateWriteTransaction((database) => {
      const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
      executeSqliteQuerySync(database.db, stateDb.deleteFrom("operator_approvals"));
    }, suiteDatabaseOptions);
  });

  it("lists terminal history newest-first with kind filtering and keyset pagination", async () => {
    const store = createStore();
    const entries: NewOperatorApproval[] = [
      approval("exec-old", { createdAtMs: 1_000 }),
      approval("plugin-new", { kind: "plugin", createdAtMs: 1_001 }),
      approval("system-middle", {
        kind: "system-agent",
        presentation: {
          kind: "system-agent",
          title: "Approve system change",
          description: "Apply the proposed system-agent change.",
          proposalHash: "a".repeat(64),
          agentId: "main",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1_002,
      }),
      approval("still-pending", { createdAtMs: 1_003 }),
    ];
    for (const entry of entries) {
      await expect(store.insert(entry.id, entry)).resolves.toMatchObject({
        outcome: "inserted",
      });
    }
    for (const [id, nowMs] of [
      ["exec-old", 2_000],
      ["system-middle", 3_000],
      ["plugin-new", 3_000],
    ] as const) {
      await expect(
        store.resolve(id, "deny", {
          resolver: { kind: "device", id: "reviewer-device" },
          nowMs,
        }),
      ).resolves.toMatchObject({ outcome: "resolved" });
    }

    const firstPage = await store.history({ limit: 2, nowMs: 3_000 });
    expect(firstPage.records.map((record) => record.id)).toEqual(["system-middle", "plugin-new"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    if (!firstPage.nextCursor) {
      throw new Error("expected terminal history cursor");
    }

    const cursorPayload = JSON.parse(
      Buffer.from(firstPage.nextCursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const nonEmittedCursor = Buffer.from(
      JSON.stringify({ ...cursorPayload, extra: true }),
      "utf8",
    ).toString("base64url");
    for (const cursor of [
      `${firstPage.nextCursor}!`,
      `${firstPage.nextCursor}=`,
      nonEmittedCursor,
    ]) {
      await expect(store.history({ cursor, nowMs: 3_000 })).rejects.toThrow(
        OperatorApprovalHistoryCursorError,
      );
    }

    const secondPage = await store.history({
      cursor: firstPage.nextCursor,
      limit: 2,
      nowMs: 3_000,
    });
    expect(secondPage.records.map((record) => record.id)).toEqual(["exec-old"]);
    expect(secondPage.nextCursor).toBeUndefined();

    expect(
      (await store.history({ kind: "plugin", nowMs: 3_000 })).records.map((record) => record.id),
    ).toEqual(["plugin-new"]);
  });

  it("filters an audience before applying the replay limit", async () => {
    await expectFilteredReplay(
      { audienceSessionKeys: ["agent:main:other"] },
      { audienceSessionKeys: ["agent:main:target"] },
      { audienceSessionKey: "agent:main:target" },
    );
  });

  it("filters reviewers before the replay limit", async () => {
    await expectFilteredReplay(
      { reviewerDeviceIds: ["unrelated-device"] },
      { reviewerDeviceIds: ["authorized-device"] },
      { reviewerDeviceId: "authorized-device" },
    );
  });

  it.each([
    ["pending", undefined],
    ["pending", "agent:main:child"],
    ["replay", undefined],
    ["replay", "agent:main:child"],
  ] as const)(
    "repairs corrupt pending rows before later decisions (%s, audience=%s)",
    async (operation, audienceSessionKey) => {
      const store = createStore();
      const list =
        operation === "pending"
          ? store.pending
          : async (params: Parameters<typeof listPendingOperatorApprovals>[0]) => {
              const prepared = await store.replay(params);
              expect(prepared.outcome).toBe("pending");
              return prepared.records;
            };
      for (const id of ["a-corrupt", "b-match", "c-match"]) {
        await store.insert(id);
      }
      store.corrupt("a-corrupt", { presentation_json: "{not-json" });

      const listing = list({
        audienceSessionKey,
        limit: 1,
        nowMs: 2_000,
      });
      // A later decision must not overtake the list's corrupt-row repair.
      const denying = store.deny("b-match", "no-route", {
        resolver: { kind: "system", id: null },
        nowMs: 2_000,
      });
      const records = await listing;
      await denying;
      expect(records.map((record) => record.id)).toEqual(audienceSessionKey ? ["b-match"] : []);
      expect(store.raw("a-corrupt")).toMatchObject({
        status: "denied",
        terminal_reason: "storage-corrupt",
      });
      expect(
        (
          await list({
            audienceSessionKey,
            limit: 1,
            nowMs: 2_000,
          })
        ).map((record) => record.id),
      ).toEqual(["c-match"]);
    },
  );

  it("reads the default clock after waiting for the SQLite write lock", async () => {
    const store = createStore(createDatabaseOptions());
    const createdAtMs = 1_000;
    const expiresAtMs = 2_000;
    await store.insert("lock-delayed-clock", { createdAtMs, expiresAtMs });
    const database = openOpenClawStateDatabase(store.databaseOptions);
    const writer = new DatabaseSync(database.path);
    using clock = vi.spyOn(Date, "now").mockReturnValue(createdAtMs);
    // Run the real worker transaction locally so its clock is controlled; transport authority
    // is covered separately by the worker integration tests.
    using _ = vi
      .spyOn(workerAdmission, "requestSqliteWorkerOperationAdmission")
      .mockImplementation(() => {});
    const receiptTransport = vi
      .spyOn(workerAdmission, "deferSqliteWorkerCommitReceipt")
      .mockImplementation(() => {});
    const releaseWriter = vi.fn(() => {
      writer.exec("COMMIT");
      // Retain the getter's exact-deadline boundary after the real lock wait.
      clock.mockReturnValue(expiresAtMs);
    });
    try {
      writer.exec("BEGIN IMMEDIATE");
      expect(Date.now()).toBeLessThan(expiresAtMs);
      const result = await withSqliteWriteAdmissionService(
        requireNativeSqliteDatabase(database.db),
        releaseWriter,
        async () =>
          operatorApprovalOperations["operatorApprovals.get"](
            { id: "lock-delayed-clock" },
            {
              open: () => database,
              stateOptions: () => ({
                path: database.path,
                env: store.databaseOptions.env ?? process.env,
              }),
            },
          ),
      );

      expect(releaseWriter).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        outcome: "found",
        record: { status: "expired", terminalReason: "timeout" },
      });
    } finally {
      writer.close();
      receiptTransport.mockRestore();
    }
  });

  it("rejects presentations outside the canonical safe protocol schema", async () => {
    const store = createStore();
    const base = approval("unsafe-presentation");
    const unsafePresentation = {
      ...base.presentation,
      env: { SECRET_TOKEN: "must-not-persist" },
    } as unknown as NewOperatorApproval["presentation"];

    await expect(
      store.insert(base.id, { ...base, presentation: unsafePresentation }),
    ).rejects.toThrow(/safe protocol schema/);
    expect(store.raw(base.id)).toBeUndefined();
  });

  it("rejects approval ids that cannot form stable deep-link path segments", async () => {
    const store = createStore();
    for (const id of ["\ud800", "\udc00", ".", ".."]) {
      await expect(store.insert(id)).rejects.toThrow(/approval id/);
      await expect(store.get({ id })).rejects.toThrow(/approval id/);
      await expect(
        store.resolve(id, "deny", {
          resolver: { kind: "system", id: null },
        }),
      ).rejects.toThrow(/approval id/);
    }
  });

  it("keeps canonical ids and transport references in disjoint lookup namespaces", async () => {
    const store = createStore();
    const inserted = await store.insert("namespace-owner");
    if (inserted.outcome !== "inserted") {
      throw new Error("expected approval insert");
    }

    await expect(
      store.insert(inserted.record.resolutionRef, { createdAtMs: 1_001 }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      store.getDetailed({
        id: inserted.record.resolutionRef,
        allowTransportRef: true,
        nowMs: 2_000,
      }),
    ).resolves.toEqual({ outcome: "found", record: inserted.record });

    const futureId = "namespace-future-owner";
    const futureRef = buildApprovalResolutionRef({ approvalId: futureId, approvalKind: "exec" });
    await expect(store.insert(futureRef, { createdAtMs: 1_002 })).resolves.toMatchObject({
      outcome: "inserted",
    });
    await expect(store.insert(futureId, { createdAtMs: 1_003 })).resolves.toEqual({
      outcome: "conflict",
    });
  });

  it("returns the first terminal answer and distinguishes same and conflicting retries", async () => {
    const store = createStore();
    const inserted = await Promise.all([store.insert("first-wins"), store.insert("first-wins")]);
    expect(inserted.map((result) => result.outcome)).toEqual(["inserted", "existing"]);
    for (const result of inserted) {
      expect(result).toMatchObject({ record: { id: "first-wins", status: "pending" } });
    }

    const winnerPending = store.resolve("first-wins", "allow-once", {
      resolver: { kind: "device", id: "winner-device" },
      nowMs: 2_000,
    });
    const sameRetryPending = store.resolve("first-wins", "allow-once", {
      resolver: { kind: "channel", id: "telegram:loser" },
      nowMs: 2_001,
    });
    const conflictingRetryPending = store.resolve("first-wins", "deny", {
      resolver: { kind: "channel", id: "telegram:loser" },
      nowMs: 2_002,
    });

    const denialPending = store.deny("first-wins", "run-aborted", {
      resolver: { kind: "system", id: "late-denial" },
      nowMs: 2_003,
    });
    const [winner, sameRetry, conflictingRetry, denial] = await Promise.all([
      winnerPending,
      sameRetryPending,
      conflictingRetryPending,
      denialPending,
    ]);

    expect(winner).toMatchObject({
      outcome: "resolved",
      record: {
        status: "allowed",
        decision: "allow-once",
        resolver: { kind: "device", id: "winner-device" },
      },
    });
    expect(sameRetry).toMatchObject({
      outcome: "already-resolved",
      retry: "same",
      record: { resolver: { kind: "device", id: "winner-device" } },
    });
    expect(conflictingRetry).toMatchObject({
      outcome: "already-resolved",
      retry: "conflict",
      record: { decision: "allow-once" },
    });
    expect(denial).toMatchObject({
      outcome: "already-terminal",
      record: { decision: "allow-once", resolver: { id: "winner-device" } },
    });
  });

  it("expires at the exact deadline and never accepts a late allow", async () => {
    const store = createStore();
    await store.insert("deadline", { expiresAtMs: 2_000 });

    const deadlineResult = await store.resolve("deadline", "allow-always", {
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_000,
    });
    const lateResult = await store.resolve("deadline", "allow-always", {
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_001,
    });

    expect(deadlineResult).toMatchObject({
      outcome: "expired",
      record: { status: "expired", decision: "deny", terminalReason: "timeout" },
    });
    expect(lateResult).toMatchObject({
      outcome: "already-resolved",
      retry: "conflict",
      record: { status: "expired", decision: "deny" },
    });
  });

  it("hides approvals from resolvers with the wrong kind or runtime epoch", async () => {
    const store = createStore();
    await store.insert("guarded");

    await expect(
      store.resolve("guarded", "allow-once", {
        resolver: { kind: "runtime", id: "runtime" },
        expectedKind: "plugin",
        runtimeEpoch: "runtime-a",
        nowMs: 2_000,
      }),
    ).resolves.toEqual({ outcome: "not-found" });
    await expect(
      store.deny("guarded", "run-aborted", {
        resolver: { kind: "runtime", id: "runtime" },
        expectedKind: "exec",
        runtimeEpoch: "runtime-b",
        nowMs: 2_000,
      }),
    ).resolves.toEqual({ outcome: "not-found" });
    await expect(store.get({ id: "guarded", nowMs: 2_000 })).resolves.toMatchObject({
      status: "pending",
    });

    await store.resolve("guarded", "allow-once", {
      resolver: { kind: "runtime", id: "runtime" },
      expectedKind: "exec",
      runtimeEpoch: "runtime-a",
      nowMs: 2_000,
    });
    await expect(
      store.consume("guarded", "run-1:tool-call-1", {
        expectedKind: "plugin",
        runtimeEpoch: "runtime-a",
        nowMs: 2_001,
      }),
    ).resolves.toEqual({ outcome: "not-found" });
    await expect(
      store.consume("guarded", "run-1:tool-call-1", {
        expectedKind: "exec",
        runtimeEpoch: "runtime-b",
        nowMs: 2_001,
      }),
    ).resolves.toEqual({ outcome: "not-found" });
    await expect(
      store.consume("guarded", "run-1:tool-call-1", {
        expectedKind: "exec",
        runtimeEpoch: "runtime-a",
        nowMs: 2_001,
      }),
    ).resolves.toMatchObject({ outcome: "consumed" });
  });

  it("consumes allow-once exactly once without erasing the terminal decision", async () => {
    const store = createStore();
    await store.insert("consume", { createdAtMs: 5_000 });
    const resolved = await store.resolve("consume", "allow-once", {
      resolver: { kind: "runtime", id: "approval-runtime" },
      nowMs: 2_000,
    });
    expect(resolved).toMatchObject({
      outcome: "resolved",
      record: { resolvedAtMs: 5_000, updatedAtMs: 5_000 },
    });

    const firstPending = store.consume("consume", "run-1:tool-call-1", {
      redemptionWindowMs: 15_000,
      nowMs: 3_000,
    });
    const replayPending = store.consume("consume", "run-2:tool-call-2", {
      redemptionWindowMs: 15_000,
      nowMs: 3_001,
    });

    const [first, replay] = await Promise.all([firstPending, replayPending]);

    expect(first).toMatchObject({
      outcome: "consumed",
      record: {
        status: "allowed",
        decision: "allow-once",
        consumedAtMs: 5_000,
        consumedBy: "run-1:tool-call-1",
      },
    });
    expect(replay).toMatchObject({
      outcome: "already-consumed",
      record: { decision: "allow-once", consumedAtMs: 5_000, consumedBy: "run-1:tool-call-1" },
    });
  });

  it("rejects allow-once redemption at the exact grace boundary", async () => {
    const store = createStore();
    await store.insert("stale-redemption");
    await store.resolve("stale-redemption", "allow-once", {
      resolver: { kind: "runtime", id: "approval-runtime" },
      nowMs: 2_000,
    });

    await expect(
      store.consume("stale-redemption", "run-1:tool-call-1", {
        redemptionWindowMs: 1_000,
        nowMs: 3_000,
      }),
    ).resolves.toMatchObject({
      outcome: "redemption-expired",
      record: { resolvedAtMs: 2_000, consumedAtMs: null },
    });
  });

  it("cancels pending rows from older runtime epochs after reopen", async () => {
    const store = createStore(createDatabaseOptions());
    await store.insert("orphan", { createdAtMs: 5_000 });
    await store.insert("current", { runtimeEpoch: "runtime-b" });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    const result = await store.recover({ runtimeEpoch: "runtime-b", nowMs: 2_000 });

    expect(result).toMatchObject({
      affected: 1,
      pruned: 0,
      records: [
        {
          id: "orphan",
          status: "cancelled",
          decision: "deny",
          terminalReason: "gateway-restart",
          resolvedAtMs: 5_000,
          updatedAtMs: 5_000,
        },
      ],
    });
    await expect(store.get({ id: "orphan", nowMs: 2_000 })).resolves.toMatchObject({
      status: "cancelled",
      terminalReason: "gateway-restart",
    });
    await expect(store.get({ id: "current", nowMs: 2_000 })).resolves.toMatchObject({
      status: "pending",
    });
    expect((await store.replay({ nowMs: 2_000 })).records.map((record) => record.id)).toEqual([
      "current",
    ]);
    await expect(
      store.consume("orphan", "restarted-consumer", { nowMs: 2_000 }),
    ).resolves.toMatchObject({ outcome: "not-allow-once" });
  });

  it("terminalizes a corrupt pending row and never returns it as approvable", async () => {
    const store = createStore();
    await store.insert("corrupt", { createdAtMs: 5_000 });
    store.corrupt("corrupt", { presentation_json: "{not-json" });

    await expect(store.getDetailed({ id: "corrupt", nowMs: 2_000 })).resolves.toEqual({
      outcome: "corrupt",
    });
    await expect(store.get({ id: "corrupt", nowMs: 2_000 })).resolves.toBeNull();
    expect(store.raw("corrupt")).toMatchObject({
      status: "denied",
      decision: "deny",
      terminal_reason: "storage-corrupt",
      resolver_kind: "system",
      resolved_at_ms: 5_000,
      updated_at_ms: 5_000,
    });
  });

  it("fails closed for forged terminal status tuples", async () => {
    const store = createStore(createDatabaseOptions());
    await store.insert("forged-allowed");
    await store.insert("forged-denied");
    await store.resolve("forged-allowed", "allow-once", {
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_000,
    });
    await store.resolve("forged-denied", "deny", {
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_000,
    });
    const database = openOpenClawStateDatabase(store.databaseOptions);
    // Simulate external corruption that bypassed SQLite CHECK constraints; the
    // decoder must independently reject these approval-granting tuples.
    database.db.exec("PRAGMA ignore_check_constraints = ON");
    store.corrupt("forged-allowed", { terminal_reason: "storage-corrupt" });
    store.corrupt("forged-denied", { decision: "allow-once" });
    database.db.exec("PRAGMA ignore_check_constraints = OFF");

    await expect(store.getDetailed({ id: "forged-allowed", nowMs: 2_001 })).resolves.toEqual({
      outcome: "corrupt",
    });
    await expect(store.getDetailed({ id: "forged-denied", nowMs: 2_001 })).resolves.toEqual({
      outcome: "corrupt",
    });
  });

  it("prunes only terminal rows outside the 30-day retention window", async () => {
    const store = createStore();
    const nowMs = OPERATOR_APPROVAL_TERMINAL_RETENTION_MS + 10_000;
    await store.insert("old-terminal", { createdAtMs: 5_000 });
    await store.insert("recent-terminal");
    await store.insert("still-pending");
    await store.deny({
      id: "old-terminal",
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: 4_000,
    });
    expect(store.raw("old-terminal")).toMatchObject({
      resolved_at_ms: 5_000,
      updated_at_ms: 5_000,
    });
    await store.deny({
      id: "recent-terminal",
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: nowMs - 100,
    });

    await expect(
      store.recover({
        runtimeEpoch: "runtime-a",
        nowMs,
      }),
    ).resolves.toMatchObject({ pruned: 1 });
    expect(store.raw("old-terminal")).toBeUndefined();
    expect(store.raw("recent-terminal")).toBeDefined();
    expect(store.raw("still-pending")).toBeDefined();
  });

  it("rejects an unbounded ancestor audience", async () => {
    const store = createStore();
    const audienceSessionKeys = Array.from(
      { length: OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS + 1 },
      (_, index) => `agent:main:${index}`,
    );

    await expect(store.insert("large-audience", { audienceSessionKeys })).rejects.toThrow(
      /audience exceeds/,
    );
  });
});
