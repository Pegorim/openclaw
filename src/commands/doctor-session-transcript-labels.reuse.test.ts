import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeUpdateDoctorHistoricalScans,
  recordUpdateDatabaseWrites,
} from "../cli/update-cli/update-command-database-receipts.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { projectExistingAgentDatabaseTargets } from "../infra/session-sqlite-migration-readers.js";
import * as tempRoot from "../infra/tmp-openclaw-dir.js";
import type { UpdateDatabaseBackup } from "../infra/update-database-backup.js";
import { readUpdatePhysicalDatabaseGenerations } from "../infra/update-database-generations.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import {
  createUpdateDoctorHistoricalScanCapture,
  UPDATE_DOCTOR_HISTORICAL_SCANS_ENV,
  type UpdateDoctorHistoricalScans,
} from "../infra/update-doctor-scan-receipts.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { ReadOnlySqliteTranscriptReader } from "./doctor-session-sqlite-transcript-readers.js";
import { noteSessionTranscriptLabelHealth } from "./doctor-session-transcript-labels.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note,
}));
const cfg = { agents: { entries: { main: {} } } };

describe("update Doctor retained transcript scan reuse", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let databasePath: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-history-reuse-"));
    env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
    databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const sessions = path.join(env.OPENCLAW_STATE_DIR!, "agents", "main", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "sessions.json"), "{}");
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();
    const db = openNodeSqliteDatabase(databasePath);
    try {
      db.exec("CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)");
      const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)");
      // Retained history without a live sessions projection must still be inspected.
      for (let seq = 0; seq < 40; seq++) {
        insert.run(
          "archived",
          seq,
          JSON.stringify({
            type: "message",
            message: { role: "user", content: "ordinary history " + seq },
          }),
        );
      }
    } finally {
      db.close();
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    note.mockClear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function pass(
    previous?: UpdateDoctorHistoricalScans | string,
    before?: () => void,
    options: {
      profile?: string;
      after?: () => void;
      incomplete?: boolean;
      shouldRepair?: boolean;
    } = {},
  ) {
    const warnings: string[] = [];
    const capture = createUpdateDoctorHistoricalScanCapture({
      env: {
        ...env,
        ...(previous !== undefined
          ? {
              [UPDATE_DOCTOR_HISTORICAL_SCANS_ENV]:
                typeof previous === "string" ? previous : JSON.stringify(previous),
              OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
            }
          : {}),
      },
      warn: (message) => warnings.push(message),
    });
    capture.observe([databasePath]);
    capture.admit(
      options.incomplete
        ? { [databasePath]: null }
        : await readUpdatePhysicalDatabaseGenerations([databasePath]),
    );
    before?.();
    const config = { ...cfg, session: { store: databasePath } };
    const targets = projectExistingAgentDatabaseTargets(
      resolveAllAgentSessionStoreTargetsSync(config, { env }),
      env,
      config,
    );
    expect(targets.map((target) => target.sqlitePath)).toContain(databasePath);
    await capture.run(() =>
      noteSessionTranscriptLabelHealth({
        cfg: config,
        env: { ...env, OPENCLAW_PROFILE: options.profile },
        shouldRepair: options.shouldRepair ?? false,
      }),
    );
    options.after?.();
    return {
      receipts: capture.settle(await readUpdatePhysicalDatabaseGenerations([databasePath])),
      warnings,
    };
  }
  function write(sql: string) {
    const db = openNodeSqliteDatabase(databasePath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  }
  it("does not scan unchanged retained history twice across update passes", async () => {
    const reads = vi.spyOn(ReadOnlySqliteTranscriptReader.prototype, "labelRepairSnapshot");
    const first = await pass();
    expect(first.receipts).toHaveLength(1);
    // The first candidate Doctor returns through the installed driver's existing IPC owner.
    // Exercise its actual serializer/parser and operation-bound single-use handoff.
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(root);
    const resultPath = createUpdatePostInstallDoctorResultPath();
    expect(path.dirname(resultPath)).toBe(root);
    const generations = await readUpdatePhysicalDatabaseGenerations([databasePath]);
    await writeUpdatePostInstallDoctorResult({
      resultPath,
      result: {
        status: "ok",
        databaseWrites: {
          unchanged: true,
          fromGenerations: generations,
          generations,
          historicalScans: first.receipts,
        },
      },
    });
    const result = await consumeUpdatePostInstallDoctorResult(resultPath);
    const backup: UpdateDatabaseBackup = {
      directory: root,
      databases: [],
      missingPaths: [],
      sourcePaths: [databasePath],
      sourceGenerations: generations,
      warnings: [],
    };
    recordUpdateDatabaseWrites(backup, result?.databaseWrites, { name: "pre-plugin Doctor" });
    const encoded = consumeUpdateDoctorHistoricalScans(backup);
    expect(encoded).toBeDefined();
    expect(consumeUpdateDoctorHistoricalScans(backup)).toBeUndefined();
    const second = await pass(encoded);
    expect(second.receipts).toEqual(first.receipts);
    expect(second.warnings).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(1);
  });
  it("drops an optional receipt rather than exceeding the child environment budget", async () => {
    const first = await pass();
    const generations = await readUpdatePhysicalDatabaseGenerations([databasePath]);
    const backup: UpdateDatabaseBackup = {
      directory: root,
      databases: [],
      missingPaths: [],
      sourcePaths: [databasePath],
      sourceGenerations: generations,
      warnings: [],
    };
    recordUpdateDatabaseWrites(
      backup,
      {
        unchanged: true,
        generations,
        historicalScans: first.receipts,
      },
      { name: "pre-plugin Doctor" },
    );
    expect(
      consumeUpdateDoctorHistoricalScans(backup, { FILLER: "x".repeat(30 * 1024) }),
    ).toBeUndefined();
    expect(consumeUpdateDoctorHistoricalScans(backup, {})).toBeUndefined();
  });
  it.each([
    [
      "append",
      "INSERT INTO transcript_events SELECT session_id, 40, event_json FROM transcript_events WHERE seq = 0",
    ],
    [
      "rewrite",
      "UPDATE transcript_events SET event_json = replace(event_json, 'ordinary', 'rewritten') WHERE seq = 0",
    ],
    ["delete", "DELETE FROM transcript_events WHERE seq = 0"],
    ["schema change", "ALTER TABLE transcript_events ADD COLUMN extra TEXT"],
  ])("rescans after a retained-history %s", async (_name, sql) => {
    const reads = vi.spyOn(ReadOnlySqliteTranscriptReader.prototype, "labelRepairSnapshot");
    const first = await pass();
    write(sql);
    await pass(first.receipts);
    expect(reads).toHaveBeenCalledTimes(2);
  });
  it("rescans writes after admission, even before the scan starts", async () => {
    const first = await pass();
    const reads = vi.spyOn(ReadOnlySqliteTranscriptReader.prototype, "labelRepairSnapshot");
    await pass(first.receipts, () => write("DELETE FROM transcript_events WHERE seq = 0"));
    expect(reads).toHaveBeenCalledOnce();
  });
  it("rescans a child-process rewrite after admission", async () => {
    const first = await pass();
    const reads = vi.spyOn(ReadOnlySqliteTranscriptReader.prototype, "labelRepairSnapshot");
    await pass(first.receipts, () => {
      expect(fs.realpathSync(databasePath).startsWith(fs.realpathSync(root) + path.sep)).toBe(true);
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          [
            "const fs = require('node:fs'), path = require('node:path');",
            "const [file, root] = process.argv.slice(1);",
            "if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw Error('not private');",
            "const db = new (require('node:sqlite').DatabaseSync)(file);",
            "db.exec(\"UPDATE transcript_events SET event_json = replace(event_json, 'ordinary', 'rewritten') WHERE seq = 0\");",
            "db.close();",
          ].join("\n"),
          databasePath,
          root,
        ],
        { timeout: 10_000, env: { HOME: root } },
      );
      expect(child.status, child.stderr.toString()).toBe(0);
    });
    expect(reads).toHaveBeenCalledOnce();
  });
  it.each(["{", "x".repeat(65537), "[]"])(
    "warns and rescans an unavailable optional receipt %#",
    async (encoded) => {
      const reads = vi.spyOn(ReadOnlySqliteTranscriptReader.prototype, "labelRepairSnapshot");
      const result = await pass(encoded);
      expect(reads).toHaveBeenCalledOnce();
      expect(result.warnings).toHaveLength(1);
    },
  );
  it("does not certify incomplete generations or writes after the scan", async () => {
    expect((await pass(undefined, undefined, { incomplete: true })).receipts).toEqual([]);
    expect(
      (
        await pass(undefined, undefined, {
          after: () => write("DELETE FROM transcript_events WHERE seq = 0"),
        })
      ).receipts,
    ).toEqual([]);
  });
  it("keeps warnings visible and does not certify a failed scan", async () => {
    write("ALTER TABLE transcript_events RENAME COLUMN event_json TO invalid_payload");
    const result = await pass();
    expect(result.receipts).toEqual([]);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read transcript"),
      "Session transcript labels",
    );
  });
  it("does not suppress repeated legacy-label findings", async () => {
    const db = openNodeSqliteDatabase(databasePath);
    db.prepare("UPDATE transcript_events SET event_json = ? WHERE seq = 0").run(
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "Context\nChat history since last reply (untrusted, for context):",
        },
      }),
    );
    db.close();
    const first = await pass();
    const second = await pass(first.receipts);
    expect(first.receipts).toEqual([]);
    expect(second.receipts).toEqual([]);
    expect(
      note.mock.calls.filter(([message]) => String(message).includes("Found 1 session")),
    ).toHaveLength(2);
  });
  it("separates profiles and repair modes", async () => {
    const first = await pass();
    const reads = vi.spyOn(ReadOnlySqliteTranscriptReader.prototype, "labelRepairSnapshot");
    await pass(first.receipts, undefined, { profile: "other" });
    await pass(first.receipts, undefined, { shouldRepair: true });
    expect(reads).toHaveBeenCalledTimes(2);
  });
  it("does not lend a clean receipt to a replacement database", async () => {
    const first = await pass();
    fs.copyFileSync(databasePath, databasePath + ".replacement");
    fs.renameSync(databasePath + ".replacement", databasePath);
    const reads = vi.spyOn(ReadOnlySqliteTranscriptReader.prototype, "labelRepairSnapshot");
    await pass(first.receipts);
    expect(reads).toHaveBeenCalledOnce();
  });
});
