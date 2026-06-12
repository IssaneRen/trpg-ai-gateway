import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeSegment } from "./safe-path.js";

export interface NpcProfile {
  id: string;
  displayName: string;
  role?: string;
  tone?: string;
  summary?: string;
  avatarUrl?: string;
  wikiEntryId?: string;
  wikiFileNames?: string[];
  supportedPlayerIds?: string[];
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function readNpcProfile(npcRootDir: string, npcId: string): Promise<NpcProfile> {
  const safeNpcId = assertSafeSegment(npcId, "npcId");
  const raw = await readFile(join(npcRootDir, safeNpcId, "npc.json"), "utf-8");
  return JSON.parse(raw) as NpcProfile;
}

export async function listNpcProfiles(npcRootDir: string): Promise<NpcProfile[]> {
  const entries = await readdir(npcRootDir, { withFileTypes: true });
  const profiles = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readNpcProfile(npcRootDir, entry.name))
  );
  return profiles.sort((left, right) => left.id.localeCompare(right.id));
}

export async function readNpcAiContext(npcRootDir: string, npcId: string): Promise<string> {
  const safeNpcId = assertSafeSegment(npcId, "npcId");
  return readOptionalText(join(npcRootDir, safeNpcId, "ai-context.json"));
}

export async function readNpcCommonMemory(npcRootDir: string, npcId: string): Promise<string> {
  const safeNpcId = assertSafeSegment(npcId, "npcId");
  return readOptionalText(join(npcRootDir, safeNpcId, "common-memory.md"));
}

export async function readNpcPlayerMemory(
  npcRootDir: string,
  npcId: string,
  playerId: string
): Promise<string> {
  const safeNpcId = assertSafeSegment(npcId, "npcId");
  const safePlayerId = assertSafeSegment(playerId, "playerId");
  return readOptionalText(join(npcRootDir, safeNpcId, "players", `${safePlayerId}.memory.md`));
}
