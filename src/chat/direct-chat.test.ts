import { describe, expect, it } from "vitest";
import { buildDirectChatRequest } from "./direct-chat.js";

describe("buildDirectChatRequest", () => {
  it("forwards a simple message without requiring npc or player memory", () => {
    expect(
      buildDirectChatRequest({
        message: "帮我生成一个调查员问候语。",
        temperature: 0.3
      })
    ).toEqual({
      messages: [{ role: "user", content: "帮我生成一个调查员问候语。" }],
      temperature: 0.3
    });
  });

  it("forwards explicit chat messages when provided", () => {
    expect(
      buildDirectChatRequest({
        message: "ignored fallback",
        messages: [
          { role: "system", content: "你是跑团助手。" },
          { role: "user", content: "给我一句 NPC 台词。" }
        ]
      })
    ).toEqual({
      messages: [
        { role: "system", content: "你是跑团助手。" },
        { role: "user", content: "给我一句 NPC 台词。" }
      ],
      temperature: undefined
    });
  });
});
