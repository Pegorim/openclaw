import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sha256Hex } from "./crypto-digest.js";
import { formatErrorMessage } from "./errors.js";
import {
  prepareSqliteDatabaseAdmission,
  readSqliteDatabaseWriteTokenForPath,
  retainSqliteDatabaseWriteScopesForPath,
} from "./sqlite-database-admission.js";
import type { UpdateDatabaseGenerations } from "./update-database-generations.js";

// Optional, operation-local IPC through the existing Doctor invocation/result channel.
export const UPDATE_DOCTOR_HISTORICAL_SCANS_ENV = "OPENCLAW_UPDATE_DOCTOR_HISTORICAL_SCANS";
export const UpdateDoctorHistoricalScansSchema = z
  .array(
    z.object({
      key: z.string().regex(/^[0-9a-f]{64}$/u),
      databasePath: z
        .string()
        .max(4096)
        .refine((value) => path.isAbsolute(value)),
      generation: z.string().max(256),
    }),
  )
  .max(128);
export type UpdateDoctorHistoricalScans = z.infer<typeof UpdateDoctorHistoricalScansSchema>;

// Only an interval guard, never a durable generation or a substitute for the owner's
// full content fingerprint. stat does not open/close raw descriptors beside SQLite.
function observeFileFamily(pathname: string): string {
  return JSON.stringify(
    ["", "-wal", "-journal"].map((suffix) => {
      const file = fs.statSync(pathname + suffix, { bigint: true, throwIfNoEntry: false });
      if (!file) {
        return null;
      }
      if (!file.isFile()) {
        throw new Error("SQLite scan source is not a regular file: " + pathname + suffix);
      }
      return [file.dev, file.ino, file.birthtimeNs, file.ctimeNs, file.mtimeNs, file.size].map(
        String,
      );
    }),
  );
}

type Scan = { reused: boolean; complete(): void };
const scans = new AsyncLocalStorage<(pathname: string, key: string) => Scan | undefined>();

/** Call complete only for an exhaustive, clean result, never a warning or partial scan.
 * Implementation IDs belong to the frozen migration and must change with its semantics. */
export function beginUpdateDoctorHistoricalScan(pathname: string, identity: readonly unknown[]) {
  return scans.getStore()?.(pathname, sha256Hex(JSON.stringify(identity)));
}

/** Piggyback on the update owner's existing full physical generations; never hash history again.
 * Native write receipts cover the interval between those observations, including workers, DDL,
 * rewrites and deletes. Retain their existing admission generation across reader handle closes. */
export function createUpdateDoctorHistoricalScanCapture(options: {
  env: NodeJS.ProcessEnv;
  warn(message: string): void;
}) {
  const retained = new Map<string, { token: string; release(): void }>();
  const completed = new Map<string, { databasePath: string; token: string }>();
  const observed = new Map<string, string>();
  let admitted: UpdateDatabaseGenerations = {};
  let previous: UpdateDoctorHistoricalScans = [];
  let warned = false;
  const fallback = (reason: string) => {
    if (!warned) {
      warned = true;
      options.warn(
        "Historical Doctor scan reuse is unavailable (" + reason + "); rescanning retained state.",
      );
    }
  };
  const token = (pathname: string) => {
    // Replacements must not borrow the old pathname admission, even within maintenance.
    prepareSqliteDatabaseAdmission(pathname);
    return readSqliteDatabaseWriteTokenForPath(pathname);
  };
  const release = () => {
    for (const entry of retained.values()) {
      try {
        entry.release();
      } catch (error) {
        fallback(formatErrorMessage(error));
      }
    }
    retained.clear();
  };
  const begin = (pathname: string, key: string): Scan | undefined => {
    try {
      const admission = retained.get(pathname);
      if (!admission) {
        if (options.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE === "1") {
          fallback("no complete database generation");
        }
        return undefined;
      }
      const current = token(pathname);
      const reused =
        current === admission.token &&
        observed.get(pathname) === observeFileFamily(pathname) &&
        previous.some(
          (entry) =>
            entry.key === key &&
            entry.databasePath === pathname &&
            entry.generation === admitted[pathname],
        );
      if (!reused && options.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE === "1") {
        fallback("no current clean receipt");
      }
      return {
        reused,
        complete() {
          try {
            const completedToken = token(pathname);
            if (completedToken) {
              completed.set(key, { databasePath: pathname, token: completedToken });
            }
          } catch (error) {
            fallback(formatErrorMessage(error));
          }
        },
      };
    } catch (error) {
      fallback(formatErrorMessage(error));
      return undefined;
    }
  };
  return {
    run<T>(operation: () => T): T {
      return scans.run(begin, operation);
    },
    observe(paths: readonly string[]) {
      observed.clear();
      for (const pathname of paths) {
        try {
          // Bracket the existing full generation read, not just the later scan.
          // Child processes do not publish this process's native write token.
          observed.set(pathname, observeFileFamily(pathname));
        } catch (error) {
          fallback(formatErrorMessage(error));
        }
      }
    },
    admit(generations: UpdateDatabaseGenerations) {
      release();
      completed.clear();
      admitted = generations;
      const encoded = options.env[UPDATE_DOCTOR_HISTORICAL_SCANS_ENV];
      try {
        previous =
          encoded && encoded.length <= 64 * 1024
            ? UpdateDoctorHistoricalScansSchema.parse(JSON.parse(encoded))
            : [];
        if (encoded && previous.length === 0) {
          fallback("missing or oversized receipt");
        }
        for (const [pathname, generation] of Object.entries(generations)) {
          if (generation === null) {
            continue;
          }
          prepareSqliteDatabaseAdmission(pathname);
          const dispose = retainSqliteDatabaseWriteScopesForPath(pathname, []);
          if (!dispose) {
            continue;
          }
          try {
            const current = token(pathname);
            if (current) {
              retained.set(pathname, { token: current, release: dispose });
            } else {
              dispose();
            }
          } catch (error) {
            dispose();
            throw error;
          }
        }
      } catch (error) {
        previous = [];
        fallback(formatErrorMessage(error));
      }
    },
    settle(generations: UpdateDatabaseGenerations | undefined): UpdateDoctorHistoricalScans {
      try {
        return [...completed]
          .flatMap(([key, entry]) => {
            const generation = generations?.[entry.databasePath];
            // Deliberately reuse only an entirely unchanged maintenance interval.
            // Child-process writes may not publish this process's native token.
            return typeof generation === "string" &&
              generation === admitted[entry.databasePath] &&
              entry.token === retained.get(entry.databasePath)?.token &&
              token(entry.databasePath) === entry.token
              ? [{ key, databasePath: entry.databasePath, generation }]
              : [];
          })
          .slice(0, 128);
      } catch (error) {
        fallback(formatErrorMessage(error));
        return [];
      } finally {
        release();
        completed.clear();
        observed.clear();
      }
    },
  };
}
