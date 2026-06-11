import { readCurrentContext, readRuntimeStatus } from "../memory/chat-memory.js";
import {
  readNpcAiContext,
  readNpcCommonMemory,
  readNpcPlayerMemory,
  readNpcProfile
} from "../memory/npc-memory.js";
import { readWikiMemoryByFileName } from "../memory/wiki-memory.js";
import type { PromptBuildResult } from "../types.js";
import { CORE_NPC_PROMPT_RULES } from "./core-npc-prompt.js";

export interface BuildNpcPromptOptions {
  npcId: string;
  playerId: string;
  userMessage: string;
  wikiEntriesDir: string;
  npcRootDir: string;
  chatMemoryRootDir: string;
}

function section(title: string, content: string): string {
  const trimmed = content.trim();
  return trimmed ? `\n\n## ${title}\n${trimmed}` : "";
}

export async function buildNpcPrompt(options: BuildNpcPromptOptions): Promise<PromptBuildResult> {
  const profile = await readNpcProfile(options.npcRootDir, options.npcId);
  const aiContext = await readNpcAiContext(options.npcRootDir, options.npcId);
  const commonMemory = await readNpcCommonMemory(options.npcRootDir, options.npcId);
  const playerMemory = await readNpcPlayerMemory(
    options.npcRootDir,
    options.npcId,
    options.playerId
  );
  const runtimeStatus = await readRuntimeStatus(
    options.chatMemoryRootDir,
    options.npcId,
    options.playerId
  );
  const currentContext = await readCurrentContext(
    options.chatMemoryRootDir,
    options.npcId,
    options.playerId
  );
  const wikiMemories = await Promise.all(
    (profile.wikiFileNames ?? []).map((fileName) =>
      readWikiMemoryByFileName(options.wikiEntriesDir, fileName, options.playerId)
    )
  );
  const npcProfile = [
    `当前 NPC：${profile.displayName} (${profile.id})`,
    profile.role ? `身份：${profile.role}` : "",
    profile.tone ? `口吻：${profile.tone}` : "",
    `当前 PL：${options.playerId}`
  ]
    .filter(Boolean)
    .join("\n");

  const system = [
    ...CORE_NPC_PROMPT_RULES,
    section("NPC 基础信息", npcProfile),
    section("NPC AI Context", aiContext),
    section("运行时状态 status.md", runtimeStatus),
    section("当前上下文 current_context.md", currentContext),
    section("当前输入", options.userMessage),
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
