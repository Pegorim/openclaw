// Preserve the same package/Git entry fixture and its external service boundaries.
import "./update-command-execution.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateCommandOptions } from "./shared.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { updateGitInstall } from "./update-command-git.js";
import type { PackageInstallUpdateParams } from "./update-command-package.js";

const { bindExecutionGuards, executionParams, mocks, successfulUpdate } =
  await import("./update-command-execution.test-support.js");
const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let env: NodeJS.ProcessEnv;

function updateParams(kind: "git" | "package" = "package") {
  const params = { ...executionParams(kind), root, shouldRestart: false };
  const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
  const run: NonNullable<UpdateCommandOptions["run"]> = { runId, env };
  params.opts.run = run;
  return { params, run };
}

beforeEach(() => {
  root = fs.realpathSync(dirs.make("update-initial-admission-"));
  for (const dir of ["tmp", "state", "dist"]) {
    fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
  }
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"1.0.1"}');
  fs.writeFileSync(path.join(root, "dist", "index.js"), "");
  fs.writeFileSync(path.join(root, "state", "openclaw.json"), "{}\n");
  env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
  };
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(path.join(root, "tmp"));
  const offline = { stopped: false, inspected: true, runtimeInspected: true, running: false };
  const ready = { status: "ok", phase: "readiness", steps: [], durationMs: 1, logTail: [] };
  mocks.maybeStopService.mockResolvedValue(offline);
  mocks.validateCanary.mockResolvedValue({ ...ready, doctorConfigWrites: true });
});
afterEach(() => vi.restoreAllMocks());

it.each(["package", "artifact", "git"] as const)(
  "admits the acquired owner at the real %s preparation boundary through activation and Doctor",
  async (kind) => {
    const { params, run } = updateParams(kind === "git" ? "git" : "package");
    if (kind === "artifact") {
      params.packageInstallSpec = path.join(root, "candidate.tgz");
      params.tag = params.packageInstallSpec;
    }
    let admitted: UpdateRecoveryFence | undefined;
    let doctorAdmitted = false;
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
        const fence = await executor.enter(root);
        admitExecutor(fence);
        admitted = fence;
        expect(run.executorFence).toBe(fence);
      });
      const doctor = (
        context: ReturnType<NonNullable<PackageInstallUpdateParams["getDoctorContext"]>>,
      ) => {
        expect(context?.executorFence).toBe(admitted);
        context?.assertCurrent?.();
        expect(context).toBeDefined();
        doctorAdmitted = true;
      };
      mocks.runPackageUpdate.mockImplementation(async (options: PackageInstallUpdateParams) => {
        await options.validateCandidate(root);
        await options.beforeActivate();
        doctor(options.getDoctorContext?.());
        return successfulUpdate;
      });
      vi.mocked(updateGitInstall).mockImplementation(async (options) => {
        await options.inspectGitTarget?.({ schemaVersions: { state: 15, agent: 19 } });
        await options.validateCandidate?.(root);
        await options.beforeGitMutation?.({ schemaVersions: { state: 15, agent: 19 } });
        doctor(options.getDoctorContext?.());
        return { ...successfulUpdate, mode: "git" };
      });
      const result = await executeMutableUpdate(await bindExecutionGuards(params));
      expect(result).toMatchObject({ result: { status: "ok" }, mutationStarted: true });
      expect(doctorAdmitted).toBe(true);
      expect(admitted).toBeDefined();
      admitted?.assertCurrent();
    });
  },
);

it.each([
  "unregistered-fence",
  "wrong-run",
  "wrong-root",
  "requester-revoked",
  "recovery-pending",
] as const)(
  "refuses %s instead of adopting an arbitrary first or replacement owner",
  async (change) => {
    const { params, run } = updateParams();
    let current = true;
    run.requesterAuthority = {
      requester: { channel: "test", senderId: "owner" },
      isCurrent: () => current,
    };
    const wrongRoot = path.join(root, "other");
    fs.mkdirSync(wrongRoot);
    let admitted = false;
    await withUpdateCommandExecutor(
      change === "wrong-run" ? randomUUID() : run.runId,
      async (executor) => {
        mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
          const fence = await executor.enter(change === "wrong-root" ? wrongRoot : root);
          current = change !== "requester-revoked";
          if (change === "recovery-pending") {
            params.opts.recovery = {};
          }
          admitExecutor(change === "unregistered-fence" ? { assertCurrent() {} } : fence);
          admitted = true;
        });
        const result = await executeMutableUpdate(await bindExecutionGuards(params));
        expect(result).toMatchObject({ result: { status: "error" }, mutationStarted: false });
        expect(admitted).toBe(false);
        expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
        expect(mocks.serviceStopped).toBe(false);
      },
    );
  },
);
