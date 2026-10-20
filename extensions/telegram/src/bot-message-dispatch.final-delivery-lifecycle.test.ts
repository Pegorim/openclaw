import { Bot } from "grammy";
import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { dispatchReplyWithBufferedBlockDispatcher as dispatchThroughSharedOwner } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  createDirectSessionPayload,
  createStatusReactionController as createReactions,
  createTelegramDraftStream as createDraftStream,
  deliverInboundReplyWithMessageSendContext as deliverInbound,
  deliverReplies,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher as dispatchReplyMock,
  dispatchWithContext,
  editMessageTelegram,
  emitToolStart,
  telegramDepsForTest,
  type DispatchReplyWithBufferedBlockDispatcherArgs,
  editMessageReplyMarkupTelegram,
  emitTelegramMessageSentHooks,
} from "./bot-message-dispatch.test-harness.js";
import type * as DeliveryRepliesModule from "./bot/delivery.replies.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import type * as DraftStreamModule from "./draft-stream.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import type * as SendEditModule from "./send-edit.js";

function retiredPluginError() {
  return Object.assign(
    new Error("Plugin telegram was reloaded or disabled; use its current tools."),
    { name: "PluginInstanceUnavailableError" },
  );
}

function resolveReply(
  replyResolver: NonNullable<DispatchReplyWithBufferedBlockDispatcherArgs["replyResolver"]>,
) {
  dispatchReplyMock.mockImplementationOnce((params) =>
    dispatchThroughSharedOwner({ ...params, replyResolver }),
  );
}

async function installRealDelivery() {
  const [draft, delivery, edit] = await Promise.all([
    vi.importActual<typeof DraftStreamModule>("./draft-stream.js"),
    vi.importActual<typeof DeliveryRepliesModule>("./bot/delivery.replies.js"),
    vi.importActual<typeof SendEditModule>("./send-edit.js"),
  ]);
  createDraftStream.mockImplementation(draft.createTelegramDraftStream);
  deliverReplies.mockImplementation(delivery.deliverStructuredReplies);
  editMessageTelegram.mockImplementation(edit.editMessageTelegram);
  return { draft, delivery, edit };
}

async function setupObservedProgressTransport() {
  const { delivery } = await installRealDelivery();
  const bot = createBot();
  const messages = new Map<number, string>();
  let nextMessageId = 1000;
  const sendMessage = vi.spyOn(bot.api, "sendMessage").mockImplementation(async (chatId, text) => {
    const message_id = ++nextMessageId;
    messages.set(message_id, text);
    return {
      message_id,
      date: 0,
      chat: { id: Number(chatId), type: "private", first_name: "Test" },
      text,
    };
  });
  const editMessageText = vi
    .spyOn(bot.api, "editMessageText")
    .mockImplementation(async (_chatId, messageId, text) => {
      if (typeof text !== "string") {
        throw new Error("This transport fixture expects legacy Telegram text.");
      }
      if (!messages.has(messageId)) {
        throw new Error("Bad Request: message to edit not found");
      }
      messages.set(messageId, text);
      return true;
    });
  const deleteMessage = vi
    .spyOn(bot.api, "deleteMessage")
    .mockImplementation(async (_chatId, messageId) => {
      messages.delete(messageId);
      return true;
    });
  return {
    bot,
    messages,
    sendMessage,
    editMessageText,
    deleteMessage,
    deliver: delivery.deliverStructuredReplies,
  };
}

let inboundSequence = 0;

function progressContext(statusReactionController = createReactions()) {
  const messageId = 456 + inboundSequence++;
  return createContext({
    ctxPayload: {
      ...createDirectSessionPayload(),
      Provider: "telegram",
      Surface: "telegram",
      MessageSid: String(messageId),
    },
    threadSpec: { id: undefined, scope: "none" },
    replyThreadId: undefined,
    msg: {
      chat: { id: 123, type: "private", first_name: "Test" },
      message_id: messageId,
      date: 0,
    },
    statusReactionController,
  });
}

const progressConfig = {
  streaming: { mode: "progress", progress: { toolProgress: true } },
} as const;

function dispatchTurn(
  bot: Bot,
  options: Omit<Parameters<typeof dispatchWithContext>[0], "bot" | "context" | "telegramCfg"> & {
    status?: ReturnType<typeof createReactions>;
  } = {},
) {
  const { status, streamMode = "partial", ...rest } = options;
  return dispatchWithContext({
    bot,
    context: progressContext(status),
    streamMode,
    telegramCfg: streamMode === "progress" ? progressConfig : { streaming: { mode: streamMode } },
    ...rest,
  });
}

describeTelegramDispatch("dispatchTelegramMessage final-delivery-lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    { failure: "retired instance", mode: "progress" },
    { failure: "definite no-send", mode: "progress" },
    { failure: "rejected tail", mode: "off" },
    { failure: "network failure", mode: "off" },
    { failure: "opaque fetch failure", mode: "off" },
  ] as const)(
    "preserves accepted content and reports $failure with streaming $mode",
    async ({ failure, mode }) => {
      const { bot, messages, sendMessage, deleteMessage } = await setupObservedProgressTransport();
      const failedStatus = createReactions();
      const prefix = "Accepted final prefix";
      const tail = "Rejected final tail";
      const partial = failure === "rejected tail";
      const finalText = partial
        ? `${prefix}\n\n${tail}`
        : "The answer whose delivery cannot be confirmed";
      if (partial) {
        deliverInbound.mockImplementationOnce(async () => {
          const accepted = await bot.api.sendMessage(123, prefix);
          sendMessage.mockRejectedValueOnce(new Error("final tail rejected"));
          try {
            await bot.api.sendMessage(123, tail);
          } catch (error) {
            throw createChannelPartialDeliveryError(
              error,
              createAcceptedChannelDeliveryResult({
                results: [{ messageId: String(accepted.message_id) }],
                content: prefix,
              }),
            );
          }
          throw new Error("Expected the final tail send to reject");
        });
      } else if (failure === "retired instance") {
        deliverInbound.mockRejectedValueOnce(retiredPluginError());
      } else if (failure === "network failure" || failure === "opaque fetch failure") {
        const error = new Error("fetch failed");
        if (failure === "network failure") {
          error.cause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
        }
        deliverInbound.mockRejectedValueOnce(error);
      } else {
        // A confirmed non-send may be retried without rerunning the model.
        deliverInbound.mockResolvedValue({ status: "handled_no_send" });
      }
      const replyResolver = vi.fn<
        NonNullable<DispatchReplyWithBufferedBlockDispatcherArgs["replyResolver"]>
      >(async (_ctx, options) => {
        if (mode === "progress") {
          await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "failed-1" });
          expect([...messages.values()]).toEqual([expect.stringContaining("Exec")]);
        }
        return { text: finalText };
      });
      resolveReply(replyResolver);
      const result = await dispatchTurn(bot, {
        status: failedStatus,
        streamMode: mode,
        retryDispatchErrors: true,
        suppressFailureFallback: true,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(replyResolver).toHaveBeenCalledOnce();
      await expect(replyResolver.mock.results[0]?.value).resolves.toEqual({ text: finalText });

      expect([...messages.values()]).toEqual([
        ...(partial ? [prefix] : []),
        mode === "progress"
          ? expect.stringMatching(/Exec|I couldn't deliver my reply/i)
          : failure === "network failure"
            ? "I couldn't deliver my reply because of a network problem. Please ask again."
            : "I couldn't deliver my reply. Please ask again.",
      ]);
      expect(sendMessage.mock.calls.some(([, text]) => text === finalText)).toBe(false);
      expect(failedStatus.setError).toHaveBeenCalledOnce();
      expect(failedStatus.setDone).not.toHaveBeenCalled();
      if (failure !== "definite no-send") {
        expect(deliverInbound).toHaveBeenCalledOnce();
        expect(result).toEqual({ kind: "completed" });
      }
      if (mode === "progress") {
        expect(deliverReplies).not.toHaveBeenCalled();
        expect(deleteMessage).not.toHaveBeenCalled();
      }
      if (partial) {
        expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
          prefix,
          tail,
          "I couldn't deliver my reply. Please ask again.",
        ]);
        return;
      }

      const retainedFailure = [...messages.entries()];
      const nextStatus = createReactions();
      deliverInbound.mockResolvedValue({
        status: "unsupported",
        reason: "missing_outbound_handler",
      });
      const nextText = "The next turn succeeds";
      resolveReply(async (_ctx, options) => {
        await emitToolStart(options, { name: "read", phase: "start", toolCallId: "next-1" });
        return { text: nextText };
      });
      await dispatchTurn(bot, {
        status: nextStatus,
        streamMode: mode,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect([...messages.entries()]).toEqual([...retainedFailure, [expect.any(Number), nextText]]);
      expect(sendMessage.mock.calls.filter(([, text]) => text === nextText)).toHaveLength(1);
      expect(nextStatus.setDone).toHaveBeenCalledOnce();
      expect(nextStatus.setError).not.toHaveBeenCalled();
      expect(failedStatus.setDone).not.toHaveBeenCalled();
    },
  );

  it("keeps a confirmed streamed answer when prompt-context recording fails", async () => {
    const { bot, messages, sendMessage } = await setupObservedProgressTransport();
    const status = createReactions();
    const preview = "Answer in progress while checking the completed result";
    const final = "Complete answer already accepted by Telegram";
    const contextFailure = new Error("prompt context recording failed");
    const recordContext = vi.fn(async () => {
      throw contextFailure;
    });
    dispatchReplyMock.mockImplementationOnce(async (params) => {
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: preview });
      await createDraftStream.mock.results[0]?.value?.flush();
      expect([...messages.values()]).toEqual([preview]);
      return dispatchThroughSharedOwner({
        ...params,
        replyResolver: async () => ({ text: final }),
      });
    });

    const result = await dispatchTurn(bot, {
      status,
      cfg: { channels: { telegram: { botToken: "synthetic-test-token" } } },
      moduleMocks: {
        ...telegramDepsForTest,
        recordOutboundMessageForPromptContext: recordContext,
      },
      retryDispatchErrors: true,
      suppressFailureFallback: true,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(result).toEqual({ kind: "completed" });
    expect([...messages.values()]).toEqual([final]);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(recordContext).toHaveBeenCalledWith(
      expect.objectContaining({ text: final, messageId: [...messages.keys()][0] }),
    );
  });

  it("retires a repositioned preview after a rejected replacement once the final lands", async () => {
    const { bot, messages, sendMessage } = await setupObservedProgressTransport();
    const preTool = "Let me check the workspace first";
    const final = "The workspace has three projects";
    dispatchReplyMock.mockImplementationOnce(async (params) => {
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: preTool });
      await createDraftStream.mock.results[0]?.value?.flush();
      expect([...messages.values()]).toEqual([preTool]);
      return dispatchThroughSharedOwner({
        ...params,
        replyResolver: async (_ctx, options) => {
          sendMessage.mockRejectedValueOnce(new Error("replacement preview rejected"));
          await emitToolStart(options, { name: "read", phase: "start", toolCallId: "read-1" });
          return { text: final };
        },
      });
    });

    const result = await dispatchTurn(bot);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      preTool,
      expect.stringContaining("Read"),
      final,
    ]);
    expect(result).toEqual({ kind: "completed" });
    expect([...messages.values()]).toEqual([final]);
  });

  it("does not retry or erase an accepted final after late cancellation", async () => {
    const { bot, messages, sendMessage, deliver } = await setupObservedProgressTransport();
    const status = createReactions();
    const abortController = new AbortController();
    deliverReplies.mockImplementationOnce(async (params) => {
      const result = await deliver(params);
      abortController.abort(new Error("turn cancelled after final acceptance"));
      return result;
    });
    resolveReply(async (_ctx, options) => {
      await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "cleanup-1" });
      return { text: "Accepted final survives cleanup" };
    });

    await dispatchTurn(bot, {
      status,
      streamMode: "progress",
      retryDispatchErrors: true,
      turnAdoptionLifecycle: {
        abortSignal: abortController.signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(
      [...messages.values()].filter((text) => text === "Accepted final survives cleanup"),
    ).toEqual(["Accepted final survives cleanup"]);
    expect(
      sendMessage.mock.calls.filter(([, text]) => text === "Accepted final survives cleanup"),
    ).toHaveLength(1);
    expect(deliverReplies).toHaveBeenCalledOnce();
    expect(status.setError).not.toHaveBeenCalled();
  });

  it("uses the second assistant preview as the current final when delivery is rejected", async () => {
    const { bot, messages, sendMessage, editMessageText } = await setupObservedProgressTransport();
    const status = createReactions();
    const first = "First accepted answer";
    const partial = "Second answer in progress while inspecting the result";
    const second = "Second complete answer";
    dispatchReplyMock.mockImplementationOnce(async (params) => {
      await params.dispatcherOptions.deliver({ text: first }, { kind: "final" });
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: partial });
      await createDraftStream.mock.results[0]?.value?.flush();
      expect([...messages.values()]).toEqual([first, partial]);
      editMessageText.mockRejectedValueOnce(new Error("second final edit rejected"));
      sendMessage.mockRejectedValueOnce(new Error("second final send rejected"));
      return dispatchThroughSharedOwner({
        ...params,
        replyResolver: async () => ({ text: second }),
      });
    });
    await dispatchTurn(bot, {
      status,
      cfg: { channels: { telegram: { botToken: "synthetic-test-token" } } },
      retryDispatchErrors: true,
      suppressFailureFallback: true,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    const visible = [...messages.entries()];
    expect(visible[0]?.[1]).toBe(first);
    expect(sendMessage.mock.calls.filter(([, text]) => text === first)).toHaveLength(1);
    expect(visible.some(([, text]) => text === second)).toBe(false);
    expect(
      visible.some(([, text]) => text === "I couldn't deliver my reply. Please ask again."),
    ).toBe(true);
    expect(sendMessage.mock.calls.filter(([, text]) => text === second)).toHaveLength(1);
    expect(status.setError).toHaveBeenCalledOnce();
    expect(status.setDone).not.toHaveBeenCalled();
  });
});

const question = {
  text: "Should this harmless check continue?",
  channelData: { askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" } },
};

describeTelegramDispatch("dispatchTelegramMessage native questions", () => {
  it.each([
    { streamMode: "progress", controls: "buttonless", rejectControls: false },
    { streamMode: "partial", controls: "buttons", rejectControls: true },
  ] as const)(
    "keeps the accepted $controls question on the $streamMode stream (controls rejected: $rejectControls)",
    async ({ streamMode, controls, rejectControls }) => {
      vi.useFakeTimers();
      let draft: TelegramDraftStream | undefined;
      const register = vi
        .spyOn(questionGatewayRuntime, "registerChannelDelivery")
        .mockImplementation(() => {});
      const statusReactionController = createReactions();
      try {
        const {
          draft: actualDraft,
          delivery: actualDelivery,
          edit: actualEdit,
        } = await installRealDelivery();
        createDraftStream.mockImplementation((params) => {
          const stream = actualDraft.createTelegramDraftStream(params);
          draft ??= stream;
          return stream;
        });
        deliverReplies.mockImplementation(actualDelivery.deliverReplies);
        editMessageTelegram.mockImplementation(actualEdit.editMessageTelegram);
        editMessageReplyMarkupTelegram.mockImplementation(
          actualEdit.editMessageReplyMarkupTelegram,
        );
        const visible = new Map<number, string>();
        const keyboards = new Map<number, unknown>();
        let nextMessageId = 1001;
        let rejectedControlEdits = 0;
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const method = new URL(input instanceof Request ? input.url : String(input)).pathname
            .split("/")
            .at(-1);
          if (typeof init?.body !== "string") {
            throw new Error("Expected a JSON Telegram request");
          }
          const payload = asNonArrayRecord(JSON.parse(init.body));
          const messageId =
            typeof payload.message_id === "number" ? payload.message_id : nextMessageId++;
          if (method === "deleteMessage") {
            visible.delete(messageId);
            keyboards.delete(messageId);
            return Response.json({ ok: true, result: true });
          }
          if (method === "editMessageText" && payload.reply_markup && rejectControls) {
            rejectedControlEdits += 1;
            return Response.json({
              ok: false,
              error_code: 400,
              description: "Bad Request: BUTTON_DATA_INVALID",
            });
          }
          if (method === "editMessageReplyMarkup") {
            keyboards.set(messageId, payload.reply_markup);
            return Response.json({ ok: true, result: true });
          }
          if (method !== "sendMessage" && method !== "editMessageText") {
            throw new Error(`Unexpected Telegram method: ${method}`);
          }
          if (typeof payload.text !== "string") {
            throw new Error("Expected Telegram message text");
          }
          visible.set(messageId, payload.text);
          if (payload.reply_markup !== undefined) {
            keyboards.set(messageId, payload.reply_markup);
          }
          return Response.json({
            ok: true,
            result: {
              message_id: messageId,
              date: 0,
              chat: { id: 123, type: "private", first_name: "Fixture" },
              text: payload.text,
            },
          });
        };
        const bot = new Bot("123456:question-fixture", {
          client: { fetch: asTelegramClientFetch(fetch) },
        });
        let questionMessageId: number | undefined;
        dispatchReplyMock.mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          await emitToolStart(replyOptions, {
            name: "exec",
            toolCallId: "check",
            phase: "start",
          });
          await vi.advanceTimersByTimeAsync(1500);
          await draft?.flush();
          expect([...visible.values()].some((text) => text.includes("Exec"))).toBe(true);
          await dispatcherOptions.deliver(
            {
              ...question,
              channelData: {
                ...question.channelData,
                ...(controls === "buttons"
                  ? {
                      telegram: {
                        buttons: [[{ text: "Continue", callback_data: "ask:continue" }]],
                      },
                    }
                  : {}),
              },
            },
            { kind: "tool" },
          );
          questionMessageId = draft?.messageId();
          expect(visible.get(questionMessageId ?? -1)).toBe("Should this harmless check continue?");
          await emitToolStart(replyOptions, { name: "wait", toolCallId: "wait", phase: "start" });
          await vi.advanceTimersByTimeAsync(1500);
          await draft?.flush();
          expect(visible.get(questionMessageId ?? -1)).toBe("Should this harmless check continue?");
          if (controls === "buttons") {
            expect(keyboards.get(questionMessageId ?? -1)).toEqual({
              inline_keyboard: [[{ text: "Continue", callback_data: "ask:continue" }]],
            });
          }
          await dispatcherOptions.deliver({ text: "The question has settled." }, { kind: "final" });
          return { queuedFinal: true };
        });
        await dispatchWithContext({
          bot,
          cfg: { channels: { telegram: { botToken: "123456:question-fixture" } } },
          context: createContext({
            ctxPayload: createDirectSessionPayload(),
            threadSpec: { id: undefined, scope: "none" },
            replyThreadId: undefined,
            statusReactionController,
          }),
          streamMode,
          telegramCfg: { streaming: { mode: streamMode, progress: { toolProgress: true } } },
        });
        await vi.runOnlyPendingTimersAsync();
        if (rejectControls) {
          expect(rejectedControlEdits).toBe(1);
          expect(register).not.toHaveBeenCalled();
          expect([...visible.values()]).toEqual(["Should this harmless check continue?"]);
          expect([...keyboards.values()]).toEqual([]);
          expect(statusReactionController.setError).toHaveBeenCalledOnce();
          expect(emitTelegramMessageSentHooks).toHaveBeenCalledWith(
            expect.objectContaining({ success: false, messageId: [...visible.keys()][0] }),
          );
        } else {
          expect([...visible.values()]).toEqual([
            "Should this harmless check continue?",
            "The question has settled.",
          ]);
          expect(register).toHaveBeenCalledOnce();
          const registration = register.mock.calls[0]?.[0];
          expect(registration?.questionId).toBe("ask_0123456789abcdef0123456789abcdef");
          expect(registration?.deliveryId).toBe(`telegram:default:123:${questionMessageId}`);
          await registration?.finalize("Answered: continue");
          expect(visible.get(questionMessageId ?? -1)).toContain("Answered: continue");
          expect(keyboards.get(questionMessageId ?? -1)).toEqual({ inline_keyboard: [] });
          expect([...visible.values()]).toContain("The question has settled.");
        }
      } finally {
        await draft?.discard();
        register.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
