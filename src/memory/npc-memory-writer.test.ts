import { mkdtempSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendNpcMemory } from "./npc-memory-writer.js";

describe("appendNpcMemory", () => {
  it("appends common npc memory with a stable timestamp heading", async () => {
    const root = mkdtempSync(join(tmpdir(), "npc-memory-writer-"));
    mkdirSync(join(root, "char.claire"), { recursive: true });

    await appendNpcMemory({
      npcRootDir: root,
      npcId: "char.claire",
      text: "她记得墓园里的钟声。",
      now: new Date("2026-08-26T12:34:56.000Z")
    });

    await expect(readFile(join(root, "char.claire", "common-memory.md"), "utf-8")).resolves.toBe(
      "\n\n## 2026-08-26T12:34:56.000Z QQ追加记忆\n\n她记得墓园里的钟声。\n"
    );
  });

  it("appends player specific npc memory", async () => {
    const root = mkdtempSync(join(tmpdir(), "npc-memory-writer-"));
    mkdirSync(join(root, "char.claire"), { recursive: true });

    await appendNpcMemory({
      npcRootDir: root,
      npcId: "char.claire",
      playerId: "pl.cici",
      text: "她单独记得 Cici 的承诺。",
      now: new Date("2026-08-26T12:34:56.000Z")
    });

    await expect(readFile(join(root, "char.claire", "players", "pl.cici.memory.md"), "utf-8")).resolves.toContain(
      "她单独记得 Cici 的承诺。"
    );
  });

  it("rejects unsafe ids and oversized memory text", async () => {
    const root = mkdtempSync(join(tmpdir(), "npc-memory-writer-"));

    await expect(
      appendNpcMemory({ npcRootDir: root, npcId: "../char.claire", text: "x" })
    ).rejects.toThrow("npcId contains unsupported characters");
    await expect(
      appendNpcMemory({ npcRootDir: root, npcId: "char.claire", playerId: "../pl.cici", text: "x" })
    ).rejects.toThrow("playerId contains unsupported characters");
    await expect(
      appendNpcMemory({ npcRootDir: root, npcId: "char.claire", text: "x".repeat(4001) })
    ).rejects.toThrow("记忆文本过长");
  });
});
