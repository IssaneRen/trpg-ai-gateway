import { mkdir, readFile, rename, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeSegment } from "./safe-path.js";
import type { AiProvider, ChatRole } from "../types.js";

export interface ChatHistoryEntry {
  timestamp: string;
  role: ChatRole;
  content: string;
}

const CONTEXT_COMPRESSION_THRESHOLD_BYTES = 10 * 1024 * 1024;

function runtimePlayerDir(rootDir: string, npcId: string, playerId: string): string {
  const safeNpcId = assertSafeSegment(npcId, "npcId");
  const safePlayerId = assertSafeSegment(playerId, "playerId");
  return join(rootDir, safeNpcId, "players", safePlayerId);
}

function timestampForFileName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    String(date.getFullYear()).slice(-2),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function readRuntimeStatus(
  rootDir: string,
  npcId: string,
  playerId: string
): Promise<string> {
  return readOptionalText(join(runtimePlayerDir(rootDir, npcId, playerId), "status.md"));
}

export async function readCurrentContext(
  rootDir: string,
  npcId: string,
  playerId: string
): Promise<string> {
  return readOptionalText(join(runtimePlayerDir(rootDir, npcId, playerId), "current_context.md"));
}

export async function readChatHistory(
  rootDir: string,
  npcId: string,
  playerId: string,
  limit = 100
): Promise<ChatHistoryEntry[]> {
  const cappedLimit = Math.max(1, Math.min(limit, 200));
  const raw = await readOptionalText(join(runtimePlayerDir(rootDir, npcId, playerId), "full_log.log"));
  const entries = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChatHistoryEntry)
    .filter(
      (entry) =>
        typeof entry.timestamp === "string" &&
        (entry.role === "user" || entry.role === "assistant" || entry.role === "system") &&
        typeof entry.content === "string"
    );
  return entries.slice(-cappedLimit);
}

export async function appendChatTurn(
  rootDir: string,
  npcId: string,
  playerId: string,
  userMessage: string,
  assistantMessage: string,
  now = new Date()
): Promise<void> {
  const dir = runtimePlayerDir(rootDir, npcId, playerId);
  await mkdir(dir, { recursive: true });
  const timestamp = now.toISOString();
  const lines = [
    { timestamp, role: "user" as const, content: userMessage },
    { timestamp, role: "assistant" as const, content: assistantMessage }
  ];
  await appendFile(join(dir, "full_log.log"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  await appendFile(
    join(dir, "current_context.md"),
    `\n\n[${timestamp}] PL: ${userMessage}\n[${timestamp}] NPC: ${assistantMessage}\n`
  );
}

export async function deleteChatHistory(
  rootDir: string,
  npcId: string,
  playerId: string,
  now = new Date()
): Promise<{ backupFileName?: string }> {
  const dir = runtimePlayerDir(rootDir, npcId, playerId);
  await mkdir(dir, { recursive: true });
  const backupFileName = `full_log_backup_${timestampForFileName(now)}.log`;
  try {
    await rename(join(dir, "full_log.log"), join(dir, backupFileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await removeIfExists(join(dir, "current_context.md"));
    return {};
  }
  await removeIfExists(join(dir, "current_context.md"));
  return { backupFileName };
}

export async function compressCurrentContextIfNeeded(
  rootDir: string,
  npcId: string,
  playerId: string,
  provider: AiProvider
): Promise<boolean> {
  const dir = runtimePlayerDir(rootDir, npcId, playerId);
  const contextPath = join(dir, "current_context.md");
  let size = 0;
  try {
    size = (await stat(contextPath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (size <= CONTEXT_COMPRESSION_THRESHOLD_BYTES) return false;

  const context = await readFile(contextPath, "utf-8");
  const result = await provider.chat({
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "请压缩以下 NPC 与 PL 的运行时上下文，保留事实、承诺、情绪变化、未解决问题和重要线索，删除重复寒暄。"
      },
      { role: "user", content: context }
    ]
  });
  await writeFile(contextPath, result.content, "utf-8");
  return true;
}
