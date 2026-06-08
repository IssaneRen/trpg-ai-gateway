import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNpcPrompt } from "./prompt-builder.js";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "trpg-ai-gateway-"));
  const wikiEntriesDir = join(root, "wiki");
  const npcRootDir = join(root, "npcs");
  const npcDir = join(npcRootDir, "char.claire");
  mkdirSync(wikiEntriesDir, { recursive: true });
  mkdirSync(join(npcDir, "players"), { recursive: true });

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
  writeFileSync(join(npcDir, "common-memory.md"), "NPC 通用记忆：不轻易相信外乡人。\n");
  writeFileSync(join(npcDir, "players", "pl.cici.memory.md"), "PL 私有记忆：Cici 曾帮她修过门。\n");

  return { wikiEntriesDir, npcRootDir };
}

describe("buildNpcPrompt", () => {
  it("assembles npc, wiki, and player memory for the selected player", async () => {
    const fixture = createFixture();

    const prompt = await buildNpcPrompt({
      npcId: "char.claire",
      playerId: "pl.cici",
      userMessage: "你还记得湖边的事吗？",
      wikiEntriesDir: fixture.wikiEntriesDir,
      npcRootDir: fixture.npcRootDir
    });

    expect(prompt.messages[0].role).toBe("system");
    expect(prompt.messages[0].content).toContain("克莱儿");
    expect(prompt.messages[0].content).toContain("公开记忆");
    expect(prompt.messages[0].content).toContain("Cici 解锁记忆");
    expect(prompt.messages[0].content).toContain("NPC 通用记忆");
    expect(prompt.messages[0].content).toContain("PL 私有记忆");
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
      npcRootDir: fixture.npcRootDir
    });

    expect(prompt.messages[0].content).toContain("公开记忆");
    expect(prompt.messages[0].content).not.toContain("Cici 解锁记忆");
    expect(prompt.messages[0].content).not.toContain("PL 私有记忆");
  });
});
