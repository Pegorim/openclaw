import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatPendingInputs } from "./server-methods/chat-pending-inputs.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createMockGatewayRecoveryRuntime } from "./server-recovery-runtime.test-support.js";
import { recoverSessionSendDeliveries } from "./session-send-recovery.js";

// Row shape from openclaw@2026.10.5 (1b58cb9a1b4f): pending-input kernel:155-168,
// agent schema:878-893, user-turn transcript:215-230. No chatInputRecovery authority.
const stableRow = (state: string) => ({
  input_id: `stable-${state}`,
  session_key: "agent:main:stable-upgrade",
  session_id: "stable-upgrade-session",
  idempotency_key: `stable-${state}:user`,
  run_id: `stable-${state}`,
  request_hash: "request:stable-request-fingerprint",
  message_json: JSON.stringify({
    role: "user",
    content: "Synthetic input accepted by the stable release",
    timestamp: 1_792_281_600_000,
    idempotencyKey: `stable-${state}:user`,
  }),
  lifecycle_generation: "stable-process-generation",
  state,
  accepted_at: Date.now(),
  consumed_event_id: null,
});

it("keeps latest-stable pending rows visible without replaying missing operator authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:stable-upgrade",
      sessionId: "stable-upgrade-session",
      storePath: database.path,
      env,
    };
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    const rows = ["queued", "interrupted", "cancelled"].map(stableRow);
    const columns = Object.keys(stableRow("queued"));
    const insert = database.db.prepare(`
      INSERT INTO session_pending_inputs (${columns.join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})
    `);
    for (const row of rows) {
      insert.run(...Object.values(row));
    }
    const config = { agents: { entries: { main: {} } }, session: { store: database.path } };
    setRuntimeConfigSnapshot(config);
    const context = createContext([], () => config);
    const runtime = createMockGatewayRecoveryRuntime();
    context.recoveryRuntime = runtime;

    await recoverSessionSendDeliveries(context, new AbortController().signal);

    // Read raw rows before any history access: startup itself must reconcile SIGKILL.
    const stored = database.db
      .prepare("SELECT input_id, state, message_json FROM session_pending_inputs ORDER BY seq")
      .all();
    expect(stored).toEqual(
      rows.map((row) => ({
        input_id: row.input_id,
        state: row.state === "queued" ? "interrupted" : row.state,
        message_json: row.message_json,
      })),
    );
    expect(runtime.resumeChatInput).not.toHaveBeenCalled();
    expect(runtime.dispatchAgent).not.toHaveBeenCalled();
    const visible = await readChatPendingInputs(scope, { limit: 20, maxChars: 1_000 });
    expect(visible).toMatchObject({
      total: 3,
      items: [
        {
          id: "stable-queued",
          state: "interrupted",
          message: { content: "Synthetic input accepted by the stable release" },
        },
        { id: "stable-interrupted", state: "interrupted" },
        { id: "stable-cancelled", state: "cancelled" },
      ],
    });
  });
});
