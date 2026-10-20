import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";

afterEach(() => vi.restoreAllMocks());
const receiverUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.includeDelegated);
const read = (file: string) => fs.readFileSync(file, "utf8");

it.each(["healthy", "original-owner-replaced", "include-parent-replaced"] as const)(
  "delegated candidate include effect retains original owner and directory: %s",
  async (fault) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const control = state.path("control");
      const root = state.path("install");
      fs.mkdirSync(control);
      fs.mkdirSync(root);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      await state.writeConfig({
        plugins: { enabled: false },
        update: { $include: "./fragments/channel.json" },
      });
      const fragmentDir = state.statePath("fragments");
      fs.mkdirSync(fragmentDir);
      const fragment = path.join(fragmentDir, "channel.json");
      const original = '{"channel":"stable"}\n';
      fs.writeFileSync(fragment, original);
      const rootRaw = read(state.configPath);
      const proceed = state.path("proceed");
      const ready = createDeferred<{
        pid: number;
        parentPid: number;
        parentOwner: string;
        candidate: string;
      }>();
      let stdout = "";
      let boundPid: number | undefined;
      const work = withUpdateCommandExecutor(randomUUID(), async (owner) => {
        const fence = await owner.enter(root);
        const pending = withUpdateCommandExecutorChild(fence, root, async (grant, bindChild) => {
          return runUtf8CommandWithTimeout(
            [process.execPath, ...resolveRuntimeWorkerArgv(receiverUrl)],
            {
              input: JSON.stringify({ grant, proceed }),
              env: state.env,
              beforeInput: (pid) => {
                boundPid = pid;
                bindChild(pid);
              },
              timeoutMs: 30_000,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
              onOutputChunk: (chunk) => {
                stdout += String(chunk);
                const line = stdout.split("\n").find((value) => value.startsWith('{"ready":true'));
                if (line) {
                  ready.resolve(JSON.parse(line));
                }
              },
            },
          );
        });
        try {
          const binding = await Promise.race([
            ready.promise,
            pending.then((result) => {
              throw new Error(result.stderr || stdout || "child exited before include preparation");
            }),
          ]);
          expect(binding).toMatchObject({
            pid: boundPid,
            parentPid: process.pid,
            candidate: receiverUrl.href,
          });
          expect(binding.pid).not.toBe(process.pid);
          expect(binding.parentOwner.length).toBeGreaterThan(0);
          if (fault === "original-owner-replaced") {
            using db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
            db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
              "replacement",
              root,
            );
          }
          if (fault === "include-parent-replaced") {
            fs.renameSync(fragmentDir, `${fragmentDir}-old`);
            fs.mkdirSync(fragmentDir);
            fs.writeFileSync(fragment, original);
          }
        } finally {
          fs.writeFileSync(proceed, "go");
        }
        return await pending;
      });
      const outcome = await work.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (fault === "healthy") {
        expect(outcome, stdout).toMatchObject({ value: { code: 0 } });
        expect(JSON.parse(read(fragment))).toMatchObject({ channel: "beta" });
        expect(read(`${fragment}.bak`)).toBe(original);
      } else {
        expect(stdout).toContain('"result":"refused"');
        expect(read(fragment)).toBe(original);
        expect(fs.existsSync(`${fragment}.bak`)).toBe(false);
        if (fault === "include-parent-replaced") {
          expect(read(path.join(`${fragmentDir}-old`, "channel.json"))).toBe(original);
        }
      }
      expect(read(state.configPath)).toBe(rootRaw);
    });
  },
);
