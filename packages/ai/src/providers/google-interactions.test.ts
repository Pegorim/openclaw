import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { configureAiTransportHost } from "../host.js";
import type { AssistantMessage, AssistantMessageEvent, Context, ToolCall } from "../types.js";
import { streamGoogleInteractions, streamSimpleGoogleInteractions } from "./google-interactions.js";
import { makeProviderModel } from "./provider-model.test-support.js";

const completedSse = ({
  status = "completed",
  usage = { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 },
}: { status?: string; usage?: Record<string, number> | null } = {}): string =>
  `data: ${JSON.stringify({
    event_type: "interaction.completed",
    interaction: { status, ...(usage === null ? {} : { usage }) },
  })}\n\n`;

const makeInteractionsModel = (provider = "google") =>
  makeProviderModel("google-interactions", provider, "gemini-3-flash-preview", {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
  });

const expectedToolCall = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

const sseResponse = (body: BodyInit): Response =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });

function mockSse(body: BodyInit, onRequest?: (init?: RequestInit) => void): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      onRequest?.(init);
      return sseResponse(body);
    }),
  );
}

function enqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  ...frames: string[]
): void {
  controller.enqueue(new TextEncoder().encode(frames.join("")));
}

describe("google-interactions provider", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    configureAiTransportHost({});
  });
  const basicContext: Context = {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  };
  const runInteractions = (apiKey = "test-api-key") =>
    streamGoogleInteractions(makeInteractionsModel(), basicContext, { apiKey }).result();
  it("streams cumulative tool input before completion", async ({ onTestFinished }) => {
    const gate = createDeferred();
    onTestFinished(() => gate.resolve());
    mockSse(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          enqueue(
            controller,
            'data: {"event_type":"step.start","step":{"type":"function_call","id":"progress","name":"write","arguments":{}}}\n\n',
            'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"{\\"content\\":\\"line"}}\n\n',
          );
          await gate.promise;
          enqueue(
            controller,
            'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":" end\\"}"}}\n\n',
            'data: {"event_type":"step.stop"}\n\n',
            completedSse({ status: "requires_action" }),
          );
          controller.close();
        },
      }),
    );
    const stream = streamGoogleInteractions(makeInteractionsModel(), basicContext, {
      apiKey: crypto.randomUUID(),
    });
    let firstInput: unknown;
    try {
      for await (const event of stream) {
        if (event.type === "toolcall_delta" && firstInput === undefined) {
          firstInput = structuredClone(event.partial.content[event.contentIndex]);
          gate.resolve();
        }
      }
    } finally {
      gate.resolve();
    }
    expect(firstInput).toMatchObject({ partialJson: '{"content":"line' });
    expect((await stream.result()).content).toEqual([
      { type: "toolCall", id: "progress", name: "write", arguments: { content: "line end" } },
    ]);
  });

  it("stops at [DONE] and cancels the open reader", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueue(
          controller,
          'data: {"event_type":"step.delta","delta":{"type":"text","text":"Hello world"}}\n\n',
          completedSse(),
          "data: [DONE]\n\n",
        );
      },
      cancel,
    });

    mockSse(stream);
    const eventStream = streamGoogleInteractions(makeInteractionsModel(), basicContext, {
      apiKey: "test-api-key",
    });
    const events: AssistantMessageEvent[] = [];
    for await (const event of eventStream) {
      events.push(event);
      if (event.type === "start" || event.type === "text_end" || event.type === "text_delta") {
        expect(event.partial.api).toBe("google-interactions");
      } else if (event.type === "done") {
        expect(event.message.api).toBe("google-interactions");
      }
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(events[0]?.type).toBe("start");
    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent?.message.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it.each([
    { provider: "google", geminiKey: "env-resolved-gemini-key", simple: false },
    { provider: "google-interactions", geminiKey: "env-resolved-gemini-key", simple: false },
    { provider: "google-interactions", geminiKey: "", simple: true },
  ])(
    "resolves environment auth for $provider (simple=$simple)",
    async ({ provider, geminiKey, simple }) => {
      vi.stubEnv("GEMINI_API_KEY", geminiKey);
      vi.stubEnv("GOOGLE_API_KEY", "google-fallback-key");
      let capturedHeaders: HeadersInit | undefined;
      mockSse(completedSse() + "data: [DONE]\n\n", (init) => {
        capturedHeaders = init?.headers;
      });
      await (
        simple
          ? streamSimpleGoogleInteractions(makeInteractionsModel(provider), basicContext)
          : streamGoogleInteractions(makeInteractionsModel(provider), basicContext, {})
      ).result();
      expect(capturedHeaders).toBeDefined();
      expect(new Headers(capturedHeaders).get("x-goog-api-key")).toBe(
        geminiKey || "google-fallback-key",
      );
    },
  );

  it("preserves streamed text, thought signatures, and tool arguments", async () => {
    const cases: Array<[string, AssistantMessage["content"], boolean?]> = [
      [
        'data: {"event_type":"step.start","step":{"type":"thought","summary":[{"type":"text","text":"Reasoning about tool..."}]}}\n\n' +
          'data: {"event_type":"step.delta","delta":{"type":"thought_signature","signature":"sig_stream_thought=="}}\n\n' +
          'data: {"event_type":"step.stop"}\n\n' +
          'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_99","name":"search","arguments":{"q":"gemini"}}}\n\n',
        [
          {
            type: "thinking",
            thinking: "Reasoning about tool...",
            thinkingSignature: "sig_stream_thought==",
          },
          expectedToolCall("call_99", "search", { q: "gemini" }),
        ],
        true,
      ],
      [
        'data: {"event_type":"step.start","step":{"type":"model_output","content":[{"type":"text","text":"Hello"}]}}\n\n' +
          'data: {"event_type":"step.delta","delta":{"type":"text","text":" world"}}\n\n',
        [{ type: "text", text: "Hello world" }],
      ],
      [
        'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_exec_1","name":"exec","arguments":{}}}\n\n' +
          'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"{\\"command\\":\\"ls "}}\n\n' +
          'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"-la\\"}"}}\n\n',
        [expectedToolCall("call_exec_1", "exec", { command: "ls -la" })],
        true,
      ],
      [
        'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_exec_1","name":"exec","arguments":{}}}\n\n' +
          'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"{\\"target\\":9223372036854775807}"}}\n\n',
        [expectedToolCall("call_exec_1", "exec", { target: "9223372036854775807" })],
        true,
      ],
      [
        'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_exec_1","name":"exec","arguments":{"target":9223372036854775807}}}\n\n',
        [expectedToolCall("call_exec_1", "exec", { target: "9223372036854775807" })],
        true,
      ],
    ];
    for (const [frames, content, toolUse] of cases) {
      mockSse(
        frames +
          'data: {"event_type":"step.stop"}\n\n' +
          completedSse({ status: toolUse ? "requires_action" : "completed" }) +
          "data: [DONE]\n\n",
      );
      const result = await runInteractions("test-key");
      expect(result.content).toEqual(content);
      expect(result.stopReason).toBe(toolUse ? "toolUse" : "stop");
      const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
      expect(toolCall?.thoughtSignature).toBeUndefined();
    }
  });

  it.each(["resolved", "rejected", "pending"])(
    "retires malformed tool streams when cancellation is %s",
    async (cancellationState) => {
      const ssePayload = [
        'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_exec_1","name":"exec","arguments":{}}}\n\n',
        'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"{\\"command\\":\\"ls"}}\n\n',
        'data: {"event_type":"step.stop"}\n\n',
      ].join("");
      const cancellation = createDeferred();
      const pendingWork: Promise<unknown>[] = [];
      configureAiTransportHost({
        observePendingProviderWork: (pending) => {
          pendingWork.push(pending);
        },
      });
      const cancel = vi.fn(() => {
        if (cancellationState === "resolved") {
          cancellation.resolve();
        } else if (cancellationState === "rejected") {
          cancellation.reject(new Error("cancel failed"));
        }
        return cancellation.promise;
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          enqueue(controller, ssePayload);
        },
        cancel,
      });
      mockSse(body);
      try {
        const result = await runInteractions("test-key");
        expect(result).toMatchObject({
          stopReason: "error",
          errorCode: "malformed_tool_call_arguments",
          errorMessage: "Provider completed tool call with malformed JSON arguments",
        });
        expect(result.content[0]).not.toHaveProperty("partialJson");
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
        expect(pendingWork).toHaveLength(1);
      } finally {
        cancellation.resolve();
        await Promise.all(pendingWork);
      }
    },
  );

  it("resolves sentinels before guarded egress and keeps request diagnostics secret-free", async () => {
    const sentinel = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    const diagnostics: unknown[] = [];
    const guardedFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        "x-goog-api-key": "resolved-secret",
        Authorization: "Bearer resolved-secret",
        "X-Option-Auth": "resolved-secret",
      });
      return sseResponse(completedSse() + "data: [DONE]\n\n");
    });
    configureAiTransportHost({
      buildModelFetch: () => guardedFetch as typeof fetch,
      resolveSecretSentinel: (value) => value.replaceAll(sentinel, "resolved-secret"),
      logDebug: (_subsystem, build) => diagnostics.push(build()),
    });
    const result = await streamGoogleInteractions(
      { ...makeInteractionsModel(), headers: { Authorization: `Bearer ${sentinel}` } },
      basicContext,
      { apiKey: sentinel, headers: { "X-Option-Auth": sentinel } },
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(guardedFetch).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(diagnostics);
    for (const secret of ["resolved-secret", sentinel, "Authorization", "Hello"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('"message":"request"');
  });

  it.each([
    { name: "LF", newline: "\n", blankLine: "\n" },
    { name: "CRLF", newline: "\r\n", blankLine: "\r\n" },
    { name: "CR", newline: "\r", blankLine: "\r" },
    { name: "mixed", newline: "\r\n", blankLine: "\n" },
  ])("parses fragmented multiline $name events", async ({ newline, blankLine }) => {
    const data = JSON.stringify(
      { event_type: "step.delta", delta: { type: "text", text: "Hello" } },
      null,
      2,
    )
      .split("\n")
      .map((line) => `data: ${line}`)
      .join(newline);
    const body =
      `: heartbeat${newline}${blankLine}data:${newline}${blankLine}` +
      `event: step.delta${newline}${data}${newline}${blankLine}` +
      completedSse().replaceAll("\n", newline);
    mockSse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const character of body) {
            enqueue(controller, character);
          }
          controller.close();
        },
      }),
    );
    const result = await runInteractions();
    expect(result).toMatchObject({ stopReason: "stop" });
    expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("keeps a newline-terminated final event at EOF", async () => {
    mockSse(completedSse().trimEnd() + "\n");
    expect((await runInteractions()).stopReason).toBe("stop");
  });

  it("surfaces malformed complete data without exposing payloads in output or diagnostics", async () => {
    const diagnostics: unknown[] = [];
    configureAiTransportHost({ logWarn: (...args) => diagnostics.push(args) });
    mockSse(
      'data: {"event_type":"step.delta","delta":{"text":"private-broken-payload"\n\n' +
        completedSse(),
    );
    const result = await runInteractions();
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "OpenClaw transport error: malformed_streaming_fragment",
    });
    expect(result).not.toHaveProperty("cause");
    expect(result).not.toHaveProperty("errorBody");
    expect(diagnostics).toContainEqual([
      "provider-error",
      "Model request failed",
      expect.objectContaining({ provider: "google" }),
    ]);
    expect(JSON.stringify({ result, diagnostics })).not.toContain("private-broken-payload");
  });

  it("surfaces a streamed provider error instead of completing successfully", async () => {
    mockSse(
      'data: {"event_type":"error","error":{"message":"deadline expired","code":"gateway_timeout"}}\n\n',
    );
    const result = await runInteractions();
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("deadline expired"),
      errorCode: "gateway_timeout",
    });
  });

  it.each(["completion", "step.stop"])("maps cumulative %s usage and costs", async (source) => {
    const cumulativeUsage = {
      total_input_tokens: 100,
      total_cached_tokens: 40,
      total_output_tokens: 20,
      total_thought_tokens: 30,
      total_tool_use_tokens: 5,
      total_tokens: 155,
    };
    mockSse(
      (source === "step.stop"
        ? `data: ${JSON.stringify({ event_type: "step.stop", usage: cumulativeUsage })}\n\n` +
          completedSse({ usage: null })
        : completedSse({ usage: cumulativeUsage })) + "data: [DONE]\n\n",
    );
    const model = {
      ...makeInteractionsModel(),
      cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 },
    };
    const result = await streamGoogleInteractions(model, basicContext, {
      apiKey: "test-api-key",
    }).result();
    expect(result.usage).toMatchObject({
      input: 65,
      output: 50,
      cacheRead: 40,
      totalTokens: 155,
      cacheTelemetry: { state: "available" },
      cost: { input: 0.000065, output: 0.0001, cacheRead: 0.00001, total: 0.000175 },
    });
  });

  it.each([
    ["gemini-2.5-flash", "low", { thinking_level: "low", thinking_summaries: "auto" }],
    ["gemini-2.5-flash", "xhigh", { thinking_level: "high", thinking_summaries: "auto" }],
    ["gemini-2.5-flash", "max", { thinking_level: "high", thinking_summaries: "auto" }],
    ["gemini-3-flash-preview", "off", { thinking_level: "minimal", thinking_summaries: "none" }],
    ["gemini-3-flash-preview", "adaptive" as never, { thinking_summaries: "auto" }],
  ] as const)("maps %s reasoning=%s into the request", async (modelId, reasoning, expected) => {
    let requestBody: Record<string, unknown> | undefined;
    mockSse(completedSse() + "data: [DONE]\n\n", (init) => {
      if (typeof init?.body !== "string") {
        throw new Error("expected serialized Interactions request body");
      }
      requestBody = JSON.parse(init.body);
    });
    await streamSimpleGoogleInteractions(
      {
        ...makeInteractionsModel(),
        id: modelId,
        reasoning: true,
        thinkingLevelMap: { xhigh: "high", max: "high" },
      },
      basicContext,
      { apiKey: "test-api-key", reasoning },
    ).result();
    expect(requestBody?.generation_config).toEqual(expected);
  });
});
