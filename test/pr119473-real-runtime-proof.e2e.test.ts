import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { listenLoopback } from "./helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesSse } from "./helpers/openai-responses-sse.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it(
  "persists the first turn of a fresh SQLite-backed session across gateway restart",
  { timeout: 90_000 },
  async () => {
    let envSnapshot: ReturnType<typeof captureEnv> | undefined;
    let providerServer: ReturnType<typeof createServer> | undefined;
    let first: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let second: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

    try {
      const tempHome = tempDirs.make("openclaw-pr119473-proof-");
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const configPath = path.join(stateDir, "openclaw.json");
      const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
      await Promise.all(
        [workspaceDir, bundledPluginsDir, stateDir].map((dir) =>
          fs.mkdir(dir, { recursive: true }),
        ),
      );
      const env = {
        HOME: tempHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: "pr119473-proof-token",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      envSnapshot = captureEnv(Object.keys(env));
      for (const [key, value] of Object.entries(env)) {
        setTestEnvValue(key, value);
      }

      providerServer = createServer((_request, response) => {
        const message = {
          type: "message",
          id: "pr119473-proof-message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "PR119473_RUNTIME_OK", annotations: [] }],
        };
        writeOpenAiResponsesSse(response, [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, status: "in_progress", content: [] },
          },
          { type: "response.output_item.done", output_index: 0, item: message },
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        ]);
      });
      const provider = buildMockOpenAiResponsesProvider(
        `${await listenLoopback(providerServer)}/v1`,
      );
      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            skipBootstrap: true,
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
            },
          },
          entries: { main: {} },
        },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        gateway: { auth: { mode: "token", token: "pr119473-proof-token" } },
      };
      const sessionKey = "agent:main:pr119473-fresh-runtime";
      const marker = "PR119473_FIRST_USER_MESSAGE";
      const start = (clientDisplayName: string) =>
        startGatewayWithClient({
          cfg,
          configPath,
          token: "pr119473-proof-token",
          clientDisplayName,
        });
      first = await start("pr119473-proof-first-start");
      const started = await first.client.request<{ runId?: string; status?: string }>("chat.send", {
        sessionKey,
        message: marker,
        deliver: false,
        idempotencyKey: "pr119473-proof-first-turn",
      });
      expect(started).toMatchObject({ status: "started", runId: expect.any(String) });
      await expect(
        first.client.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        ),
      ).resolves.toMatchObject({ status: "ok" });
      await disconnectGatewayClient(first.client);
      await first.server.close({ reason: "PR #119473 proof restart" });
      first = undefined;

      clearRuntimeConfigSnapshot();
      clearConfigCache();
      second = await start("pr119473-proof-after-restart");
      const history = await second.client.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey,
        limit: 20,
      });
      expect(JSON.stringify(history.messages ?? [])).toContain(marker);
    } finally {
      for (const gateway of [first, second]) {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
      }
      if (providerServer?.listening) {
        await new Promise<void>((resolve) => {
          providerServer?.close(() => resolve());
        });
      }
      envSnapshot?.restore();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();
    }
  },
);
