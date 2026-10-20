import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexProviderWebSearchSupport } from "./provider-capabilities.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";

const appServer = {
  start: {},
  requestTimeoutMs: 1_000,
} as CodexAppServerRuntimeOptions;

function createClientFactory(webSearch: boolean | boolean[]) {
  const values = Array.isArray(webSearch) ? [...webSearch] : [webSearch];
  const request = vi.fn(async () => ({ webSearch: values.shift() ?? false }));
  const client = { request } as unknown as CodexAppServerClient;
  const clientFactory = vi.fn<CodexAppServerClientFactory>(async () => client);
  return { clientFactory, request };
}

function resolveSupport(
  clientFactory: CodexAppServerClientFactory,
  overrides: Partial<Parameters<typeof resolveCodexProviderWebSearchSupport>[0]> = {},
) {
  return resolveCodexProviderWebSearchSupport({
    clientFactory,
    appServer,
    authProfileId: undefined,
    agentDir: "/tmp/agent",
    config: undefined,
    modelProviderOverride: undefined,
    signal: new AbortController().signal,
    ...overrides,
  });
}

describe("resolveCodexProviderWebSearchSupport", () => {
  it("reads the latest configured provider capability for each attempt", async () => {
    const { clientFactory, request } = createClientFactory([true, false]);

    await expect(resolveSupport(clientFactory)).resolves.toBe("supported");
    await expect(resolveSupport(clientFactory)).resolves.toBe("unsupported");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "modelProvider/capabilities/read",
      {},
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
  });

  it("does not use default OpenAI capabilities for a copilot thread", async () => {
    const request = vi.fn(async (method: string) =>
      method === "config/read" ? { config: { model_provider: undefined } } : { webSearch: true },
    );
    const client = { request } as unknown as CodexAppServerClient;
    const clientFactory = vi.fn(async () => client);
    const result = await resolveSupport(clientFactory, {
      expectedNativeModelProvider: "copilot",
    });
    expect(result).toBe("unknown");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["config/read"]);
  });

  it("forwards one prepared auth handoff to capability startup", async () => {
    const { clientFactory } = createClientFactory(true);
    const preparedAuth = {
      kind: "api-key" as const,
      apiKey: "prepared-platform-key",
    };

    await expect(
      resolveSupport(clientFactory, {
        authProfileId: "openai:decoy",
        preparedAuth,
      }),
    ).resolves.toBe("supported");

    expect(clientFactory.mock.calls[0]?.[0]?.preparedAuth).toBe(preparedAuth);
    expect(clientFactory).not.toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: expect.anything() }),
    );
  });

  it("reports unknown support when app-server startup fails", async () => {
    const clientFactory = vi.fn(async () => {
      throw new Error("old app-server");
    }) as unknown as CodexAppServerClientFactory;

    await expect(resolveSupport(clientFactory)).resolves.toBe("unknown");
  });

  it("reports unknown support when the capability read fails", async () => {
    const { clientFactory, request } = createClientFactory(false);
    request.mockRejectedValueOnce(new Error("transient rpc failure"));

    await expect(resolveSupport(clientFactory)).resolves.toBe("unknown");
    expect(request).toHaveBeenCalledOnce();
  });

  it("uses hosted search for the built-in OpenAI provider override", async () => {
    const { clientFactory, request } = createClientFactory(false);

    await expect(
      resolveSupport(clientFactory, { modelProviderOverride: " OpenAI " }),
    ).resolves.toBe("supported");
    expect(clientFactory).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps managed search for provider overrides the capability RPC cannot target", async () => {
    const { clientFactory, request } = createClientFactory(true);

    for (const modelProviderOverride of ["amazon-bedrock", "custom-provider", "lmstudio"]) {
      await expect(resolveSupport(clientFactory, { modelProviderOverride })).resolves.toBe(
        "unsupported",
      );
    }
    expect(clientFactory).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
