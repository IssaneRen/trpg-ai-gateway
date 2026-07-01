import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TokenHashRecord } from "./auth/tokens.js";

export interface RuntimeConfig {
  port: number;
  allowedOrigin: string;
  wikiEntriesDir: string;
  npcRootDir: string;
  chatMemoryRootDir: string;
  tokenHashPepper: string;
  supportedPlayerIds: string[];
  tokenHashRecords: TokenHashRecord[];
  ai: {
    baseUrl: string;
    model: string;
    apiKey: string;
  };
}

interface LocalConfigFile {
  port?: number;
  allowedOrigin?: string;
  wikiEntriesDir?: string;
  npcRootDir?: string;
  chatMemoryRootDir?: string;
  tokenHashFile?: string;
  supportedPlayerIds?: string[];
  ai?: {
    baseUrl?: string;
    model?: string;
    apiKeyEnv?: string;
  };
}

function readLocalConfig(path = "config.local.json"): LocalConfigFile {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as LocalConfigFile;
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing required config: ${label}`);
  return value;
}

function readTokenHashRecords(path: string): TokenHashRecord[] {
  return JSON.parse(readFileSync(path, "utf-8")) as TokenHashRecord[];
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadRuntimeConfig(): RuntimeConfig {
  const local = readLocalConfig();
  const apiKeyEnv = requireValue(local.ai?.apiKeyEnv ?? process.env.AI_API_KEY_ENV, "AI_API_KEY_ENV");
  const localPort = local.port === undefined ? undefined : String(local.port);
  const tokenHashFile = resolve(
    process.env.TOKEN_HASH_FILE ?? local.tokenHashFile ?? "data/auth/token-hashes.json"
  );
  const tokenHashRecords = readTokenHashRecords(tokenHashFile);
  const supportedPlayerIds =
    splitCsv(process.env.SUPPORTED_PLAYER_IDS).length > 0
      ? splitCsv(process.env.SUPPORTED_PLAYER_IDS)
      : local.supportedPlayerIds ?? tokenHashRecords.filter((record) => !record.isKeeper).map((record) => record.playerId);

  return {
    port: Number(requireValue(process.env.PORT ?? localPort, "PORT")),
    allowedOrigin: requireValue(process.env.ALLOWED_ORIGIN ?? local.allowedOrigin, "ALLOWED_ORIGIN"),
    wikiEntriesDir: resolve(requireValue(process.env.WIKI_ENTRIES_DIR ?? local.wikiEntriesDir, "WIKI_ENTRIES_DIR")),
    npcRootDir: resolve(requireValue(process.env.NPC_ROOT_DIR ?? local.npcRootDir, "NPC_ROOT_DIR")),
    chatMemoryRootDir: resolve(
      requireValue(
        process.env.CHAT_MEMORY_ROOT_DIR ?? local.chatMemoryRootDir,
        "CHAT_MEMORY_ROOT_DIR"
      )
    ),
    tokenHashPepper: requireValue(process.env.TOKEN_HASH_PEPPER, "TOKEN_HASH_PEPPER"),
    supportedPlayerIds,
    tokenHashRecords,
    ai: {
      baseUrl: requireValue(process.env.AI_BASE_URL ?? local.ai?.baseUrl, "AI_BASE_URL"),
      model: requireValue(process.env.AI_MODEL ?? local.ai?.model, "AI_MODEL"),
      apiKey: requireValue(process.env[apiKeyEnv], apiKeyEnv)
    }
  };
}
