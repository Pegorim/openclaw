import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as materialize from "../../config/materialize.js";
import * as installSurface from "../../infra/update-runner-install-surface.js";
import { defaultRuntime } from "../../runtime.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();
const { objectContaining: partial, arrayContaining: includes } = expect;
type ConfigCase = {
  kind: string;
  config: object;
  affectedKey?: string;
  dryRun?: boolean;
  failure?: "file" | "materialization" | "include" | "include-syntax";
};
const unknownKey = { kind: "unknown key", config: { unknownSetting: true }, affectedKey: "<root>" };
const cases: ConfigCase[] = [
  ...[false, true].map((dryRun) => Object.assign({ dryRun }, unknownKey)),
  { kind: "invalid port", config: { gateway: { port: "invalid" } }, affectedKey: "gateway.port" },
  ...(["file", "materialization", "include", "include-syntax"] as const).map((failure) => ({
    kind: failure,
    failure,
    config: failure.startsWith("include")
      ? { $include: "./extra.json" }
      : { gateway: { mode: "local" } },
  })),
];

it.each(cases)(
  "classifies $kind (dryRun=$dryRun) without changing its source or creating state",
  async ({ config, affectedKey, dryRun = false, failure }) => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    const schemaFailure = affectedKey !== undefined;
    const syntaxFailure = failure === "include-syntax";
    const reason = schemaFailure || syntaxFailure ? "invalid-config" : "config-read-failed";
    const check = schemaFailure || syntaxFailure ? "invalid-config" : "config";
    const code = failure === "file" ? "EISDIR" : reason;
    const original = JSON.stringify(config);
    if (failure) {
      vi.spyOn(installSurface, "resolveUpdateInstallSurface").mockRejectedValue(
        new Error("Package-manager inspection must not replace the config failure"),
      );
    }
    fs.mkdirSync(failure === "file" ? configPath : path.dirname(configPath), { recursive: true });
    if (failure !== "file") {
      fs.writeFileSync(configPath, original);
    }
    if (failure === "materialization") {
      vi.spyOn(materialize, "materializeRuntimeConfig").mockImplementation(() => {
        throw new Error("Synthetic materialization failure after reading source bytes");
      });
    } else if (syntaxFailure) {
      fs.writeFileSync(path.join(path.dirname(configPath), "extra.json"), "{");
    }
    const update = updateCommand({
      admission: "installed",
      tag: "2026.9.2",
      json: true,
      yes: true,
      restart: false,
      ...(schemaFailure ? { dryRun } : { channel: "stable" }),
    });
    if (dryRun) {
      await update;
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        partial({
          dryRun: true,
          notes: [expect.stringMatching(/configuration is invalid[\s\S]*openclaw doctor --fix/)],
        }),
      );
    } else {
      await expect(update).rejects.toMatchObject({ code: 1 });
      const fact = partial({ check, code, ...(schemaFailure ? { affectedKey } : {}) });
      const step = partial({
        ...(schemaFailure ? { name: "invalid-config", exitCode: 1 } : {}),
        failureFacts: [fact],
      });
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        partial({
          status: "error",
          reason,
          ...(schemaFailure ? { failedStep: step } : {}),
          steps: schemaFailure ? includes([step]) : [step],
        }),
      );
    }
    if (failure === "file") {
      expect(fs.statSync(configPath).isDirectory()).toBe(true);
    } else {
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    }
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
  },
);
