import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest as build } from "./bot-message-context.test-harness.js";

const { vision } = vi.hoisted(() => ({ vision: vi.fn(async () => false) }));
vi.mock("./sticker-vision.runtime.js", () => ({ resolveStickerVisionSupportRuntime: vision }));

const directChat = { id: 42, type: "private", first_name: "Ada" };
const groupChat = { id: -1001, type: "supergroup", title: "Ops" };
const sender = { id: 1, is_bot: false, first_name: "Ada" };
const bot = { id: 7, is_bot: true, first_name: "Bot" };
const stickerIds = { file_id: "sticker-1", file_unique_id: "sticker-u1" };
const reply = (chat: { id: number; type: string }, media: Record<string, unknown>) => ({
  message_id: 10,
  date: 1_699_999_999,
  chat,
  from: bot,
  ...media,
});

describe("buildTelegramMessageContext media carriers", () => {
  it("preserves direct conversation facts for policy admission after a topic-bound message", async () => {
    const context = await build({
      message: {
        chat: directChat,
        from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
        message_thread_id: 7,
        is_topic_message: true,
        text: "hello",
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          tools: { deny: ["write"] },
          toolsBySender: { "channel:telegram:42": { deny: ["exec"] } },
        },
        topicConfig: { agentId: "support" },
      }),
    });
    expect(context?.ctxPayload).toMatchObject({
      ChatId: "42",
      ChatType: "direct",
      SenderId: "42",
      MessageThreadId: 7,
    });
    expect(context?.ctxPayload.ConversationToolPolicy).toBeUndefined();
  });

  it("keeps immediate native sticker kind ahead of MIME and deeper reply media", async () => {
    const context = await build({
      message: { chat: directChat, text: "What was that?" },
      replyChain: [
        {
          messageId: "10",
          sender: "Pat",
          mediaKind: "sticker",
          mediaType: "image/webp",
          replyToId: "9",
        },
        { messageId: "9", sender: "Sam", mediaType: "document" },
      ],
    });
    expect(context?.ctxPayload.ReplyToBody).toBe("<media:sticker>");
    expect(context?.ctxPayload.Body).toContain("[Reply chain - nearest first]");
    expect(context?.ctxPayload.Body).toContain("<media:sticker>");
    expect(context?.ctxPayload.Body).toContain("<media:document>");
  });

  it("keeps the native reply kind when a cached chain is filtered out", async () => {
    const context = await build({
      message: {
        chat: groupChat,
        from: sender,
        text: "What was that?",
        reply_to_message: reply(groupChat, {
          from: sender,
          photo: [{ file_id: "photo-1", file_unique_id: "photo-u1", width: 1, height: 1 }],
        }),
      },
      cfg: { channels: { telegram: { groupPolicy: "allowlist", contextVisibility: "allowlist" } } },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false, allowFrom: ["1"], tools: { deny: ["exec"] } },
        topicConfig: undefined,
      }),
      replyChain: [{ messageId: "10", sender: "Hidden", senderId: "999", mediaType: "image" }],
    });
    expect(context?.ctxPayload.ConversationToolPolicy).toBeUndefined();
    expect(context?.ctxPayload.ReplyToBody).toBe("<media:image>");
    expect(context?.ctxPayload.media?.map((fact) => fact.kind)).toEqual(["image"]);
  });

  it.each([
    { fileName: "chart.jpg", kind: "image", contentType: "image/jpeg" },
    { fileName: "report.pdf", kind: "document", contentType: "application/pdf" },
  ] as const)(
    "preserves hydrated $contentType reply media and Telegram's selected quote",
    async ({ fileName, kind, contentType }) => {
      const mediaPath = `/tmp/openclaw/media/inbound/${fileName}`;
      const context = await build({
        message: {
          chat: directChat,
          text: "What does it show?",
          reply_to_message: reply(directChat, {
            caption: "Weekly chart",
            document: {
              file_id: "doc-1",
              file_unique_id: "doc-u1",
              file_name: fileName,
              mime_type: contentType,
            },
          }),
          quote: { text: "Weekly", position: 0 },
        },
        replyChain: [
          {
            messageId: "10",
            sender: "self",
            senderId: "7",
            body: "Weekly chart",
            mediaPath,
            mediaKind: kind,
            mediaType: contentType,
          },
        ],
      });
      expect(context?.ctxPayload.media).toEqual([
        expect.objectContaining({ path: mediaPath, kind, contentType }),
      ]);
      expect(context?.ctxPayload.ReplyToBody).toBe("Weekly");
      expect(context?.ctxPayload.ReplyChain?.[0]).toMatchObject({
        sender: "self",
        body: "Weekly",
        isQuote: true,
      });
    },
  );

  it("keeps mixed aggregate media out of command text and preserves voice modality", async () => {
    const context = await build({
      message: {
        chat: groupChat,
        text: undefined,
        voice: { file_id: "audio-1", file_unique_id: "audio-u1", duration: 1 },
      },
      allMedia: [{ kind: "audio" }, { kind: "image" }, { kind: "document" }],
      historyLimit: 5,
    });
    expect(context?.ctxPayload).toMatchObject({
      RawBody: "",
      BodyForAgent: "",
      CommandBody: "",
      SourceModality: "voice",
    });
    expect(context?.ctxPayload.CommandSource).toBeUndefined();
    expect(context?.ctxPayload.media?.map((fact) => fact.kind)).toEqual([
      "audio",
      "image",
      "document",
    ]);
  });

  it.each([
    [false, true, "😭", false, "😭"],
    [true, false, undefined, false, "<media:sticker>"],
    [false, false, undefined, true, "[Sticker] A waving sticker"],
  ] as const)(
    "keeps stickers meaningful without visual understanding (animated %s, video %s, emoji %s, cached %s)",
    async (animated, video, emoji, cached, expected) => {
      const context = await build({
        message: {
          chat: { ...groupChat, id: cached ? -1002 : groupChat.id },
          text: undefined,
          ...(!cached && {
            reply_to_message: reply(groupChat, { text: "No Sunday-only tickets yet." }),
          }),
          sticker: {
            ...stickerIds,
            type: "regular",
            width: 1,
            height: 1,
            is_animated: animated,
            is_video: video,
            emoji,
          },
        },
        allMedia: cached
          ? [
              {
                kind: "sticker",
                path: "/tmp/sticker.webp",
                contentType: "image/webp",
                stickerMetadata: {
                  fileId: stickerIds.file_id,
                  fileUniqueId: stickerIds.file_unique_id,
                  cachedDescription: "A waving sticker",
                },
              },
            ]
          : [{ kind: "sticker" }],
        resolveTelegramGroupConfig: () => ({
          groupConfig: { requireMention: !cached },
          topicConfig: undefined,
        }),
        historyLimit: cached ? 5 : 0,
      });
      expect(context?.ctxPayload.BodyForAgent).toBe(expected);
      if (cached) {
        expect(context?.ctxPayload.media).toEqual([
          expect.objectContaining({ path: "/tmp/sticker.webp", contentType: "image/webp" }),
        ]);
        expect(context?.ctxPayload).toMatchObject({
          StickerMediaIncluded: true,
          SkipStickerMediaUnderstanding: true,
        });
      } else {
        expect(context?.ctxPayload).toMatchObject({
          ReplyToBody: "No Sunday-only tickets yet.",
          WasMentioned: true,
        });
      }
    },
  );
});
