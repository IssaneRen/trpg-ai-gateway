import type { TokenHashRecord } from "../auth/tokens.js";
import { listNpcProfiles, type NpcProfile } from "../memory/npc-memory.js";
import type { QqChatbotOptions } from "./qq-chatbot-types.js";

function normalizeLookup(value: string): string {
  return value.trim();
}

function assertSafeLookup(value: string, label: string): string {
  const trimmed = normalizeLookup(value);
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new Error(`${label} 不安全`);
  }
  return trimmed;
}

export function resolveQqPlayerId(options: QqChatbotOptions, qqUserId: string): string {
  const safeQqUserId = assertSafeLookup(qqUserId, "QQ 用户");
  const playerId = options.playerMap[safeQqUserId];
  if (!playerId) throw new Error(`QQ 用户未绑定 PL：${safeQqUserId}`);
  return playerId;
}

export function resolvePlayerIdByName(records: TokenHashRecord[], input: string): string {
  const lookup = assertSafeLookup(input, "PL");
  const record = records.find(
    (item) => !item.isKeeper && (item.playerId === lookup || item.displayName === lookup)
  );
  if (!record) throw new Error(`未找到 PL：${lookup}`);
  return record.playerId;
}

function npcMatches(profile: NpcProfile, lookup: string): boolean {
  return profile.id === lookup || profile.displayName === lookup || Boolean(profile.aliases?.includes(lookup));
}

export async function resolveNpcProfileByName(npcRootDir: string, input: string): Promise<NpcProfile> {
  const lookup = assertSafeLookup(input, "NPC");
  const matches = (await listNpcProfiles(npcRootDir)).filter((profile) => npcMatches(profile, lookup));
  if (matches.length === 0) throw new Error(`未找到 NPC：${lookup}`);
  if (matches.length > 1) {
    throw new Error(`匹配到多个 NPC：${matches.map((profile) => profile.id).join(", ")}`);
  }
  return matches[0]!;
}
