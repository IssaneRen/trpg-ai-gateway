import { readNpcCommonMemory, readNpcPlayerMemory, readNpcProfile } from "../memory/npc-memory.js";
import { readWikiMemoryByFileName } from "../memory/wiki-memory.js";
import type { PromptBuildResult } from "../types.js";

export interface BuildNpcPromptOptions {
  npcId: string;
  playerId: string;
  userMessage: string;
  wikiEntriesDir: string;
  npcRootDir: string;
}

function section(title: string, content: string): string {
  const trimmed = content.trim();
  return trimmed ? `\n\n## ${title}\n${trimmed}` : "";
}

export async function buildNpcPrompt(options: BuildNpcPromptOptions): Promise<PromptBuildResult> {
  const profile = await readNpcProfile(options.npcRootDir, options.npcId);
  const commonMemory = await readNpcCommonMemory(options.npcRootDir, options.npcId);
  const playerMemory = await readNpcPlayerMemory(
    options.npcRootDir,
    options.npcId,
    options.playerId
  );
  const wikiMemories = await Promise.all(
    (profile.wikiFileNames ?? []).map((fileName) =>
      readWikiMemoryByFileName(options.wikiEntriesDir, fileName, options.playerId)
    )
  );

  const system = [
    "你是 TRPG 跑团辅助服务中的 NPC 对话代理。",
    "只根据已提供的记忆、档案和当前对话回答；不知道的内容要承认不确定，不要主动编造幕后真相。",
    "保持角色口吻，但不要越权泄露未出现在上下文中的秘密。",
    `当前 NPC：${profile.displayName} (${profile.id})`,
    profile.role ? `身份：${profile.role}` : "",
    profile.tone ? `口吻：${profile.tone}` : "",
    `当前 PL：${options.playerId}`,
    section("Wiki 通用记忆", wikiMemories.join("\n\n---\n\n")),
    section("NPC 通用记忆", commonMemory),
    section("当前 PL 对该 NPC 的单独记忆", playerMemory)
  ]
    .filter(Boolean)
    .join("\n");

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: options.userMessage }
    ]
  };
}
