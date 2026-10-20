import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatDatabaseStoreDiagnostic } from "../infra/database-engine/diagnostics-format.js";
import type { DatabaseStoreDiagnostic } from "../infra/database-engine/diagnostics.js";
import type { PortDescriptor } from "../infra/database-engine/port-descriptor.js";
import {
  createDiagnosticStores,
  admittedStatusOutput,
  diagnosticConfig,
  diagnosticPaths,
  matrixRoot,
  retainedAgentRoot,
  normalizeDiagnosticOutput,
  portDiagnosticStore,
} from "./doctor-database-diagnostics.test-support.js";
import { inspectDoctorDatabaseEngines } from "./doctor-database-engine-inspection.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("Doctor physical PostgreSQL output", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  let sqliteRoot: string;
  let postgresRoot: string;
  let descriptors: Map<string, PortDescriptor>;

  function port(root: string, relative: string, family: string) {
    return portDiagnosticStore({
      file: path.join(root, relative),
      descriptor: descriptors.get(family)!,
      client,
      connection: connection!,
      namespaces,
    });
  }

  async function expectOutput(
    root: string,
    config: OpenClawConfig,
    stores: DatabaseStoreDiagnostic[],
    normalizedConnection = connection,
  ) {
    expect(
      normalizeDiagnosticOutput(
        {
          text: stores.map(formatDatabaseStoreDiagnostic),
          json: stores,
          status: await admittedStatusOutput(root, config, descriptors, connection),
        },
        root,
        normalizedConnection,
      ),
    ).toMatchSnapshot();
  }

  beforeAll(async () => {
    await client.connect();
    sqliteRoot = tempDirs.make("doctor-output-sqlite-");
    descriptors = await createDiagnosticStores(sqliteRoot);
    postgresRoot = tempDirs.make("doctor-output-postgres-");
    fs.cpSync(sqliteRoot, postgresRoot, { recursive: true });
    for (const [family, relative] of Object.entries(diagnosticPaths)) {
      await port(postgresRoot, relative, family);
    }
    await port(postgresRoot, matrixRoot, "state");
    await port(postgresRoot, retainedAgentRoot, "agent");
  });

  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  async function inspect(root: string, config: OpenClawConfig) {
    return (
      await inspectDoctorDatabaseEngines({
        config,
        stateDir: root,
        env: { OPENCLAW_STATE_DIR: root, HOME: path.join(root, "home") },
      })
    ).stores!;
  }

  function createdStores(stores: DatabaseStoreDiagnostic[], root: string) {
    const expectedPaths = new Set(
      [...Object.values(diagnosticPaths), matrixRoot, retainedAgentRoot].map((relative) =>
        path.join(root, relative),
      ),
    );
    const physical = stores.filter((store) => store.path !== null && expectedPaths.has(store.path));
    expect(physical).toHaveLength(expectedPaths.size);
    return physical;
  }

  it("reports each PostgreSQL family and Matrix namespace while safety stores stay local", async () => {
    const stores = await inspect(postgresRoot, diagnosticConfig(connection));
    const physical = createdStores(stores, postgresRoot);
    // Snapshots retain every store field; namespace uniqueness is lost during normalization.
    for (const store of physical) {
      expect(store.namespace).toMatch(/^doctor_proof_/);
    }
    expect(new Set(physical.map((store) => store.namespace)).size).toBe(physical.length);
    expect(stores.filter((store) => store.configured.fixedLocal)).toHaveLength(4);
    await expectOutput(postgresRoot, diagnosticConfig(connection), stores);
  });

  it.each(["state", "agent"] as const)(
    "reports mixed mode with only %s on PostgreSQL",
    async (postgresFamily) => {
      const root = tempDirs.make(`doctor-output-mixed-${postgresFamily}-`);
      fs.cpSync(sqliteRoot, root, { recursive: true });
      const relatives =
        postgresFamily === "state"
          ? [diagnosticPaths.state, matrixRoot]
          : [diagnosticPaths.agent, retainedAgentRoot];
      for (const relative of relatives) {
        fs.copyFileSync(path.join(postgresRoot, relative), path.join(root, relative));
      }
      const config = diagnosticConfig();
      config.database = {
        engine: "sqlite",
        families: { [postgresFamily]: { engine: "postgres" } },
        postgres: { connection },
      };
      const stores = await inspect(root, config);
      await expectOutput(root, config, stores);
    },
  );

  it("preserves physical identity but reports unknown schema and ownership when PostgreSQL is unreachable", async () => {
    const unreachableConnection =
      "postgresql://synthetic-user:synthetic-password@127.0.0.1:1/unreachable";
    const config = diagnosticConfig(unreachableConnection);
    const stores = await inspect(postgresRoot, config);
    await expectOutput(postgresRoot, config, stores, unreachableConnection);
  });

  it("reports keyword-only capability and the administrator grant when pgvector is missing", async () => {
    const database = `doctor_no_vector_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE DATABASE "${database}"`);
    const url = new URL(connection!);
    url.pathname = `/${database}`;
    const isolatedConnection = url.toString();
    const isolated = new Client({ connectionString: isolatedConnection });
    try {
      await isolated.connect();
      await isolated.query("CREATE EXTENSION unaccent; CREATE EXTENSION pg_trgm");
      const root = tempDirs.make("doctor-output-no-vector-");
      fs.cpSync(sqliteRoot, root, { recursive: true });
      await portDiagnosticStore({
        file: path.join(root, diagnosticPaths.agent),
        descriptor: descriptors.get("agent")!,
        client: isolated,
        connection: isolatedConnection,
        namespaces: new Set(),
      });
      const config = diagnosticConfig();
      config.database = {
        engine: "sqlite",
        families: { agent: { engine: "postgres" } },
        postgres: { connection: isolatedConnection },
      };
      const stores = await inspect(root, config);
      const agent = stores.find((store) => store.family === "agent")!;
      const output = normalizeDiagnosticOutput(
        {
          text: formatDatabaseStoreDiagnostic(agent),
          json: agent,
          status: await admittedStatusOutput(root, config, descriptors, isolatedConnection),
        },
        root,
        isolatedConnection,
      );
      expect(output).toMatchSnapshot();
    } finally {
      await isolated.end();
      await client.query(`DROP DATABASE "${database}"`);
    }
  });
});
