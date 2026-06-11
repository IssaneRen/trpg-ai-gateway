import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_NPC_PROMPT_RULES } from "./core-npc-prompt.js";
import { buildNpcPrompt } from "./prompt-builder.js";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "trpg-ai-gateway-"));
  const wikiEntriesDir = join(root, "wiki");
  const npcRootDir = join(root, "npcs");
  const chatMemoryRootDir = join(root, "chat-memory");
  const npcDir = join(npcRootDir, "char.claire");
  const runtimePlayerDir = join(chatMemoryRootDir, "char.claire", "players", "pl.cici");
  mkdirSync(wikiEntriesDir, { recursive: true });
  mkdirSync(join(npcDir, "players"), { recursive: true });
  mkdirSync(runtimePlayerDir, { recursive: true });

  writeFileSync(
    join(wikiEntriesDir, "char.claire.json"),
    JSON.stringify(
      {
        id: "char.claire",
        displayName: "克莱儿",
        summary: "枫糖生意的代表人物。",
        content: [
          {
            type: "paragraph",
            tokens: [{ type: "text", text: "公开记忆：她经营旧式枫糖铺。" }]
          },
          {
            type: "secret-panel",
            playerIds: ["pl.cici"],
            blocks: [
              {
                type: "paragraph",
                tokens: [{ type: "text", text: "Cici 解锁记忆：她见过湖边黑影。" }]
              }
            ]
          }
        ]
      },
      null,
      2
    )
  );

  writeFileSync(
    join(npcDir, "npc.json"),
    JSON.stringify(
      {
        id: "char.claire",
        displayName: "克莱儿",
        role: "NPC",
        tone: "克制、谨慎、乡镇口吻",
        wikiFileNames: ["char.claire.json"]
      },
      null,
      2
    )
  );
  writeFileSync(
    join(npcDir, "ai-context.json"),
    JSON.stringify({ longTermSecret: "AI 上下文：她正在隐瞒账本。" }, null, 2)
  );
  writeFileSync(join(npcDir, "common-memory.md"), "NPC 通用记忆：不轻易相信外乡人。\n");
  writeFileSync(join(npcDir, "players", "pl.cici.memory.md"), "PL 私有记忆：Cici 曾帮她修过门。\n");
  writeFileSync(join(runtimePlayerDir, "status.md"), "运行时状态：她对 Cici 保持戒备。\n");
  writeFileSync(join(runtimePlayerDir, "current_context.md"), "当前上下文：刚刚谈到湖边。\n");

  return { wikiEntriesDir, npcRootDir, chatMemoryRootDir };
}

describe("buildNpcPrompt", () => {
  it("assembles npc, wiki, and player memory for the selected player", async () => {
    const fixture = createFixture();

    const prompt = await buildNpcPrompt({
      npcId: "char.claire",
      playerId: "pl.cici",
      userMessage: "你还记得湖边的事吗？",
      wikiEntriesDir: fixture.wikiEntriesDir,
      npcRootDir: fixture.npcRootDir,
      chatMemoryRootDir: fixture.chatMemoryRootDir
    });

    expect(prompt.messages[0].role).toBe("system");
    expect(prompt.messages[0].content).toContain("克莱儿");
    expect(prompt.messages[0].content).toContain("公开记忆");
    expect(prompt.messages[0].content).toContain("Cici 解锁记忆");
    expect(prompt.messages[0].content).toContain("NPC 通用记忆");
    expect(prompt.messages[0].content).toContain("PL 私有记忆");
    expect(prompt.messages[0].content).toContain("AI 上下文");
    expect(prompt.messages[0].content).toContain("运行时状态");
    expect(prompt.messages[0].content).toContain("当前上下文");
    expect(prompt.messages[1]).toEqual({
      role: "user",
      content: "你还记得湖边的事吗？"
    });
  });

  it("does not include another player's locked wiki memory or private npc memory", async () => {
    const fixture = createFixture();

    const prompt = await buildNpcPrompt({
      npcId: "char.claire",
      playerId: "pl.leina",
      userMessage: "告诉我你知道的事。",
      wikiEntriesDir: fixture.wikiEntriesDir,
      npcRootDir: fixture.npcRootDir,
      chatMemoryRootDir: fixture.chatMemoryRootDir
    });

    expect(prompt.messages[0].content).toContain("公开记忆");
    expect(prompt.messages[0].content).not.toContain("Cici 解锁记忆");
    expect(prompt.messages[0].content).not.toContain("PL 私有记忆");
  });

  it("places the four core npc rules at the very beginning of the system prompt", async () => {
    const fixture = createFixture();

    const prompt = await buildNpcPrompt({
      npcId: "char.claire",
      playerId: "pl.cici",
      userMessage: "当前输入应该出现在后续上下文。",
      wikiEntriesDir: fixture.wikiEntriesDir,
      npcRootDir: fixture.npcRootDir,
      chatMemoryRootDir: fixture.chatMemoryRootDir
    });

    const system = prompt.messages[0].content;
    expect(system.startsWith(CORE_NPC_PROMPT_RULES.join("\n"))).toBe(true);
    expect(system.indexOf(CORE_NPC_PROMPT_RULES[3])).toBeLessThan(system.indexOf("AI 上下文"));
    expect(system.indexOf("AI 上下文")).toBeLessThan(system.indexOf("运行时状态"));
    expect(system.indexOf("运行时状态")).toBeLessThan(system.indexOf("当前上下文"));
    expect(system.indexOf("当前上下文")).toBeLessThan(system.indexOf("当前输入应该出现在后续上下文。"));
  });
});
