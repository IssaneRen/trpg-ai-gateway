import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TokenHashRecord } from "../auth/tokens.js";
import {
  resolveNpcProfileByName,
  resolvePlayerIdByName,
  resolveQqPlayerId
} from "./qq-chatbot-resolver.js";

function createNpc(root: string, id: string, displayName: string, aliases: string[] = []) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "npc.json"), JSON.stringify({ id, displayName, aliases }, null, 2));
}

const records: TokenHashRecord[] = [
  { playerId: "pl.cici", displayName: "Cici", tokenHash: "a".repeat(64) },
  { playerId: "pl.leina", displayName: "莱纳", tokenHash: "b".repeat(64) },
  { playerId: "kp", displayName: "KP", isKeeper: true, tokenHash: "c".repeat(64) }
];

describe("qq chatbot resolvers", () => {
  it("resolves mapped qq user ids to player ids", () => {
    expect(resolveQqPlayerId({ playerMap: { "123456789": "pl.cici" } }, "123456789")).toBe("pl.cici");
  });

  it("rejects unmapped qq user ids", () => {
    expect(() => resolveQqPlayerId({ playerMap: {} }, "123456789")).toThrow("未绑定");
  });

  it("resolves player ids by id or display name but not keeper records", () => {
    expect(resolvePlayerIdByName(records, "pl.cici")).toBe("pl.cici");
    expect(resolvePlayerIdByName(records, "莱纳")).toBe("pl.leina");
    expect(() => resolvePlayerIdByName(records, "KP")).toThrow("未找到");
  });

  it("resolves npc profiles by id, display name, or alias", async () => {
    const root = mkdtempSync(join(tmpdir(), "qq-chatbot-npcs-"));
    createNpc(root, "char.claire", "克莱儿", ["Claire", "小克"]);

    await expect(resolveNpcProfileByName(root, "char.claire")).resolves.toMatchObject({ id: "char.claire" });
    await expect(resolveNpcProfileByName(root, "克莱儿")).resolves.toMatchObject({ id: "char.claire" });
    await expect(resolveNpcProfileByName(root, "小克")).resolves.toMatchObject({ id: "char.claire" });
  });

  it("rejects ambiguous npc aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "qq-chatbot-npcs-"));
    createNpc(root, "char.first", "第一人", ["医生"]);
    createNpc(root, "char.second", "第二人", ["医生"]);

    await expect(resolveNpcProfileByName(root, "医生")).rejects.toThrow("匹配到多个 NPC");
  });

  it("rejects unsafe npc lookup input", async () => {
    const root = mkdtempSync(join(tmpdir(), "qq-chatbot-npcs-"));
    createNpc(root, "char.claire", "克莱儿");

    await expect(resolveNpcProfileByName(root, "../char.claire")).rejects.toThrow("不安全");
  });
});
