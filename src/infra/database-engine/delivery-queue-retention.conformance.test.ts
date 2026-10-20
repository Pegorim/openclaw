import { describe, expect, it, vi } from "vitest";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadDeliveryQueueEntryInDatabase as loadEntry } from "../delivery-queue-sqlite-bound.js";
import {
  prepareDeliveryQueueTerminalEntry as prepareTerminal,
  pruneExpiredDeliveryQueueTombstonesInDatabase as prune,
  terminalizePendingDeliveryQueueEntryInDatabase as terminalize,
  upsertDeliveryQueueEntryInDatabase as upsert,
} from "../delivery-queue-sqlite.kernel.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { runSqliteImmediateTransactionSync as transaction } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const QUEUE = "retention-conformance";
const NOW = 4_000_000_000;
const ORDINARY_AGE = 30 * 86_400_000;

function pruneAt(database: OpenClawStateDatabase, time = NOW) {
  vi.mocked(Date.now).mockReturnValue(time);
  prune(database);
}

const contracts: Array<{
  name: string;
  check: (database: OpenClawStateDatabase) => void;
}> = [
  {
    name: "orders mixed receipt deadlines and preserves large bounded ages",
    check(database) {
      transaction(database.db, () => {
        for (const [id, enqueuedAt, maxAgeMs] of [
          ["ordinary", NOW - ORDINARY_AGE + 10, undefined],
          ["bounded-sooner", NOW - 100, 105],
          ["bounded-huge", NOW, Number.MAX_SAFE_INTEGER],
        ] as const) {
          upsert(
            {
              queueName: QUEUE,
              status: "completed",
              entry: {
                id,
                enqueuedAt,
                retryCount: 0,
                ...(maxAgeMs === undefined
                  ? {}
                  : {
                      recoveryState: "completed_bounded",
                      completionRetention: { idPrefix: "bounded-", maxAgeMs, maxEntries: 10 },
                    }),
              },
            },
            database,
          );
        }
      });
      pruneAt(database);
      pruneAt(database, NOW + 6);
      expect(loadEntry(database, QUEUE, "bounded-sooner")).toBeNull();
      expect(loadEntry(database, QUEUE, "ordinary")).not.toBeNull();
      pruneAt(database, NOW + 10);
      expect(loadEntry(database, QUEUE, "ordinary")).not.toBeNull();
      pruneAt(database, NOW + 11);
      expect(loadEntry(database, QUEUE, "ordinary")).toBeNull();
      expect(loadEntry(database, QUEUE, "bounded-huge")).not.toBeNull();
      prune(database);
      expect(loadEntry(database, QUEUE, "bounded-huge")).not.toBeNull();
    },
  },
  {
    name: "expires a new terminal receipt after an empty inventory at its exact boundary",
    check(database) {
      prune(database);
      const entry = {
        id: "terminal-bounded",
        enqueuedAt: NOW,
        retryCount: 0,
        completionRetention: { idPrefix: "terminal-", maxAgeMs: 60_000, maxEntries: 10 },
      };
      transaction(database.db, () => upsert({ queueName: QUEUE, entry }, database));
      expect(
        transaction(database.db, () =>
          terminalize(database, prepareTerminal({ queueName: QUEUE, id: entry.id, entry })),
        ),
      ).toEqual({ status: "terminalized", retained: true });
      pruneAt(database, NOW + 60_000);
      expect(loadEntry(database, QUEUE, entry.id)).not.toBeNull();
      pruneAt(database, NOW + 60_001);
      expect(loadEntry(database, QUEUE, entry.id)).toBeNull();
    },
  },
  {
    name: "discards an empty expiry published by rolled-back pruning",
    check(database) {
      const entry = { id: "rollback", enqueuedAt: NOW - ORDINARY_AGE - 1, retryCount: 0 };
      transaction(database.db, () =>
        upsert({ queueName: QUEUE, entry, status: "completed" }, database),
      );
      expect(() =>
        transaction(database.db, () => {
          prune(database);
          prune(database);
          throw new Error("rollback retention");
        }),
      ).toThrow("rollback retention");
      expect(loadEntry(database, QUEUE, entry.id)).not.toBeNull();
      prune(database);
      expect(loadEntry(database, QUEUE, entry.id)).toBeNull();
    },
  },
];

describe.skipIf(!mixedAgentConnection).each(contracts)(
  "PostgreSQL retention: $name",
  ({ check }) => {
    useMixedAgentPair("postgres", "sqlite");

    it("preserves the delivery queue retention contract", () => {
      withEngineStoreAdmission(() => {
        const database = openOpenClawStateDatabase();
        expect(isPostgresSqlConnection(database.db)).toBe(true);
        const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
        try {
          check(database);
        } finally {
          now.mockRestore();
        }
      });
    });
  },
);
