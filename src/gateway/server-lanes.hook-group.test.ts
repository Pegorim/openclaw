import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";

function publish(config: OpenClawConfig): void {
  applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(config));
}

const HOOKS_ON = {
  hooks: { enabled: true, token: "t" },
} as unknown as OpenClawConfig;
const HOOKS_OFF = {} as OpenClawConfig;

function holdCronBudget() {
  const gates = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () => createDeferred());
  const runs = gates.map((gate) =>
    enqueueCommandInLane(CommandLane.CronNested, async () => await gate.promise, {
      warnAfterMs: 10_000,
    }),
  );
  return async () => {
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.all(runs);
  };
}

const cronSnapshot = () => getCommandLaneSnapshot(CommandLane.CronNested);
const hookSnapshot = () => getCommandLaneSnapshot(CommandLane.HookDispatch);

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await delay(0);
  }
}

afterEach(async () => {
  const { resetSessionSuspensionStateForTest } =
    await import("../agents/session-suspension.test-support.js");
  resetSessionSuspensionStateForTest();
  resetCommandQueueStateForTest();
});

it("hooks-off immediately drains cron work released by the teardown", async () => {
  // Teardown must wake queued work, not merely delete idle-lane membership.
  publish(HOOKS_ON);

  const finishCron = holdCronBudget();
  await settle();

  expect(cronSnapshot()).toMatchObject({
    activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1,
    queuedCount: 1,
    blockedBy: "sibling-reservation",
  });

  publish(HOOKS_OFF);
  await settle();

  expect(cronSnapshot()).toMatchObject({
    group: undefined,
    activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    queuedCount: 0,
  });

  await finishCron();
  expect(cronSnapshot().blockedBy).toBeNull();
});

it("keeps in-flight hooks inside the aggregate budget while disabling hooks", async () => {
  publish(HOOKS_ON);

  const hookGate = createDeferred();
  const hookRun = enqueueCommandInLane(
    CommandLane.HookDispatch,
    async () => await hookGate.promise,
    { warnAfterMs: 10_000 },
  );
  const finishCron = holdCronBudget();
  await settle();

  expect(cronSnapshot().activeCount).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1);
  expect(hookSnapshot().groupActive).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);

  publish(HOOKS_OFF);
  await settle();

  // Closing the lane must keep its running hook in the aggregate budget.
  expect(hookSnapshot()).toMatchObject({
    maxConcurrent: 0,
    group: "cron-hooks",
    reservedForLane: 0,
    activeCount: 1,
  });
  expect(cronSnapshot()).toMatchObject({
    activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1,
    queuedCount: 1,
    groupActive: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
  });

  let lateHookStarted = false;
  const lateHook = enqueueCommandInLane(CommandLane.HookDispatch, async () => {
    lateHookStarted = true;
  });
  await settle();
  expect(lateHookStarted).toBe(false);
  expect(hookSnapshot().queuedCount).toBe(1);

  hookGate.resolve();
  await hookRun;
  await settle();

  // Hand the slot to cron, not the closed hook lane.
  expect(cronSnapshot()).toMatchObject({
    activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    queuedCount: 0,
    groupActive: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
  });
  expect(lateHookStarted).toBe(false);

  await finishCron();

  publish(HOOKS_ON);
  await lateHook;
  expect(lateHookStarted).toBe(true);
});
