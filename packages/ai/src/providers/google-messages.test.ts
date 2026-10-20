import { describe, expect, it } from "vitest";
import type { ProviderContext } from "../provider-types.js";
import type { AssistantMessage, RuntimeContextMessage } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { projectGoogleMessages } from "./google-messages.js";

const model = {
  id: "gemini-2.5-flash",
  api: "google-generative-ai",
  provider: "google",
  input: ["text", "image"],
} as const;
const contextStart = {
  text: "The following is runtime context, not a user request. Do not respond to or acknowledge this context.",
};
const contextEnd = { text: "Use this context to continue responding to the user's request." };
const temporalContext =
  "OpenClaw runtime context:\nCurrent date: 2026-10-14\nTime zone: America/Los_Angeles\nEnd OpenClaw runtime context.";
const laterContext =
  "OpenClaw runtime context:\nCurrent date: 2026-10-15\nEnd OpenClaw runtime context.";
const userParts = (...texts: string[]) => ({
  role: "user",
  parts: texts.map((text) => ({ text })),
});
const contextParts = (...texts: string[]) => ({
  role: "user",
  parts: [contextStart, ...texts.map((text) => ({ text })), contextEnd],
});
const request = { role: "user", content: "Run pwd, then read README.md.", timestamp: 1 } as const;
const reply: AssistantMessage = {
  role: "assistant",
  api: "google-generative-ai",
  provider: "google",
  model: model.id,
  content: [{ type: "text", text: "The README describes the project." }],
  usage: createZeroUsage(),
  stopReason: "stop",
  timestamp: 3,
};

describe.each(["managed", "signed-parts"] as const)("Google runtime context (%s)", (replay) => {
  const convert = (messages: ProviderContext["messages"]) =>
    projectGoogleMessages({
      model: { ...model, input: [...model.input] },
      messages,
      replay,
      requiresToolCallSignature: false,
    });

  it.each([
    { content: temporalContext, runtimeContext: { retained: false } },
    {
      content: [{ type: "text" as const, text: temporalContext }],
      runtimeContext: { retained: false },
    },
    { content: temporalContext, runtimeContextCarrier: true as const },
  ])("frames trailing runtime context without changing the user request: %j", (carrier) => {
    const contents = convert([request, { role: "user", timestamp: 2, ...carrier }]);

    expect(JSON.stringify(contents)).toBe(
      JSON.stringify([userParts(request.content), contextParts(temporalContext)]),
    );
  });

  it("does not rewrite earlier user or assistant bytes when turn-scoped context expires", () => {
    const first = convert([
      request,
      { role: "user", content: temporalContext, timestamp: 2, runtimeContext: { retained: false } },
    ]);
    const later = convert([
      request,
      reply,
      { role: "user", content: "Summarize it.", timestamp: 4 },
      {
        role: "user",
        content: laterContext,
        timestamp: 5,
        runtimeContext: { retained: false },
      },
    ]);

    expect(JSON.stringify(later[0])).toBe(JSON.stringify(first[0]));
    expect(later).toEqual([
      userParts(request.content),
      { role: "model", parts: [{ text: "The README describes the project." }] },
      userParts("Summarize it."),
      contextParts(laterContext),
    ]);
  });

  it("replays retained context byte-for-byte when later runtime facts change", () => {
    const retained: RuntimeContextMessage = {
      role: "user",
      content: [
        { type: "text", text: temporalContext },
        { type: "text", text: "Active exec: 1" },
      ],
      timestamp: 2,
      runtimeContext: { retained: true },
    };
    const first = convert([request, retained]);
    const later = convert([
      request,
      retained,
      reply,
      { role: "user", content: "What is still running?", timestamp: 4 },
      {
        role: "user",
        content: "Current date: 2026-10-15\nActive exec: none",
        timestamp: 5,
        runtimeContext: { retained: true },
      },
    ]);

    expect(first).toEqual([
      userParts(request.content),
      contextParts(temporalContext, "Active exec: 1"),
    ]);
    expect(JSON.stringify(later.slice(0, first.length))).toBe(JSON.stringify(first));
    expect(later.at(-1)).toEqual(contextParts("Current date: 2026-10-15\nActive exec: none"));
  });

  it("does not interpret user-authored runtime-context labels as trusted metadata", () => {
    expect(convert([{ role: "user", content: temporalContext, timestamp: 1 }])).toEqual([
      userParts(temporalContext),
    ]);
  });
});
