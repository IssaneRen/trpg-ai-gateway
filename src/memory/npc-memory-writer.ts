import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeSegment } from "./safe-path.js";

const MAX_MEMORY_TEXT_LENGTH = 4000;

export interface AppendNpcMemoryOptions {
  npcRootDir: string;
  npcId: string;
  text: string;
  playerId?: string;
  now?: Date;
}

export async function appendNpcMemory(options: AppendNpcMemoryOptions): Promise<void> {
  const safeNpcId = assertSafeSegment(options.npcId, "npcId");
  const text = options.text.trim();
  if (!text) throw new Error("记忆文本不能为空");
  if (text.length > MAX_MEMORY_TEXT_LENGTH) throw new Error("记忆文本过长");

  const timestamp = (options.now ?? new Date()).toISOString();
  const entry = `\n\n## ${timestamp} QQ追加记忆\n\n${text}\n`;

  if (options.playerId) {
    const safePlayerId = assertSafeSegment(options.playerId, "playerId");
    const dir = join(options.npcRootDir, safeNpcId, "players");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${safePlayerId}.memory.md`), entry, "utf-8");
    return;
  }

  const dir = join(options.npcRootDir, safeNpcId);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "common-memory.md"), entry, "utf-8");
}
