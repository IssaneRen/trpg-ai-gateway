import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TokenHashRecord } from "./auth/tokens.js";
import type { QqChatbotPlayerMap } from "./qq/qq-chatbot-types.js";

export interface RuntimeConfig {
  port: number;
  allowedOrigin: string;
  wikiEntriesDir: string;
  npcRootDir: string;
  chatMemoryRootDir: string;
  analyticsRootDir: string;
  analyticsMaxEvents: number;
  contentRootDir: string;
  contentUploadRootDir: string;
  contentUploadBaseUrl: string;
  contentMaxUploadBytes: number;
  contentMaxImportBytes: number;
  moduleClueContentRootDir: string;
  moduleClueVisibilityRootDir: string;
  tokenHashPepper: string;
  supportedPlayerIds: string[];
  tokenHashRecords: TokenHashRecord[];
  qqChatbot: {
    internalToken?: string;
    playerMapFile?: string;
    playerMap: QqChatbotPlayerMap;
    adminQqIds: string[];
  };
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
  analyticsRootDir?: string;
  analyticsMaxEvents?: number;
  contentRootDir?: string;
  contentUploadRootDir?: string;
  contentUploadBaseUrl?: string;
  contentMaxUploadBytes?: number;
  contentMaxImportBytes?: number;
  moduleClueRootDir?: string;
  moduleClueContentRootDir?: string;
  moduleClueVisibilityRootDir?: string;
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

function readQqChatbotPlayerMap(path: string | undefined): QqChatbotPlayerMap {
  if (!path) return {};
  const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("QQ_CHATBOT_PLAYER_MAP_FILE must contain an object");
  }
  const map: QqChatbotPlayerMap = {};
  for (const [qqUserId, playerId] of Object.entries(raw)) {
    if (typeof playerId !== "string" || !playerId.trim()) {
      throw new Error("QQ_CHATBOT_PLAYER_MAP_FILE values must be player ids");
    }
    map[qqUserId] = playerId;
  }
  return map;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalPositiveInteger(value: string | number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function isDevAuthBypassEnabled(): boolean {
  return process.env.DEV_AUTH_BYPASS === "1" && process.env.NODE_ENV !== "production";
}

export function loadRuntimeConfig(): RuntimeConfig {
  const local = readLocalConfig();
  const devAuthBypassEnabled = isDevAuthBypassEnabled();
  const apiKeyEnv = requireValue(local.ai?.apiKeyEnv ?? process.env.AI_API_KEY_ENV, "AI_API_KEY_ENV");
  const localPort = local.port === undefined ? undefined : String(local.port);
  const tokenHashFile = resolve(
    process.env.TOKEN_HASH_FILE ?? local.tokenHashFile ?? "data/auth/token-hashes.json"
  );
  const tokenHashRecords = readTokenHashRecords(tokenHashFile);
  const qqChatbotPlayerMapFile = process.env.QQ_CHATBOT_PLAYER_MAP_FILE
    ? resolve(process.env.QQ_CHATBOT_PLAYER_MAP_FILE)
    : undefined;
  const legacyModuleClueRootDir = process.env.MODULE_CLUE_ROOT_DIR ?? local.moduleClueRootDir;
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
    analyticsRootDir: resolve(process.env.ANALYTICS_ROOT_DIR ?? local.analyticsRootDir ?? ".local/analytics"),
    analyticsMaxEvents: optionalPositiveInteger(
      process.env.ANALYTICS_MAX_EVENTS ?? local.analyticsMaxEvents,
      20000,
      "ANALYTICS_MAX_EVENTS"
    ),
    contentRootDir: resolve(process.env.CONTENT_ROOT_DIR ?? local.contentRootDir ?? ".local/content"),
    contentUploadRootDir: resolve(
      process.env.CONTENT_UPLOAD_ROOT_DIR ?? local.contentUploadRootDir ?? ".local/content-uploads"
    ),
    contentUploadBaseUrl:
      process.env.CONTENT_UPLOAD_BASE_URL ?? local.contentUploadBaseUrl ?? "/content-assets",
    contentMaxUploadBytes: optionalPositiveInteger(
      process.env.CONTENT_MAX_UPLOAD_BYTES ?? local.contentMaxUploadBytes,
      10 * 1024 * 1024,
      "CONTENT_MAX_UPLOAD_BYTES"
    ),
    contentMaxImportBytes: optionalPositiveInteger(
      process.env.CONTENT_MAX_IMPORT_BYTES ?? local.contentMaxImportBytes,
      256 * 1024 * 1024,
      "CONTENT_MAX_IMPORT_BYTES"
    ),
    moduleClueContentRootDir: resolve(
      requireValue(
        process.env.MODULE_CLUE_CONTENT_ROOT_DIR ?? local.moduleClueContentRootDir ?? legacyModuleClueRootDir,
        "MODULE_CLUE_CONTENT_ROOT_DIR"
      )
    ),
    moduleClueVisibilityRootDir: resolve(
      requireValue(
        process.env.MODULE_CLUE_VISIBILITY_ROOT_DIR ?? local.moduleClueVisibilityRootDir ?? legacyModuleClueRootDir,
        "MODULE_CLUE_VISIBILITY_ROOT_DIR"
      )
    ),
    tokenHashPepper: devAuthBypassEnabled
      ? process.env.TOKEN_HASH_PEPPER ?? "dev-auth-bypass-pepper"
      : requireValue(process.env.TOKEN_HASH_PEPPER, "TOKEN_HASH_PEPPER"),
    supportedPlayerIds,
    tokenHashRecords,
    qqChatbot: {
      internalToken: process.env.QQ_CHATBOT_INTERNAL_TOKEN,
      playerMapFile: qqChatbotPlayerMapFile,
      playerMap: readQqChatbotPlayerMap(qqChatbotPlayerMapFile),
      adminQqIds: splitCsv(process.env.QQ_CHATBOT_ADMIN_QQ_IDS)
    },
    ai: {
      baseUrl: requireValue(process.env.AI_BASE_URL ?? local.ai?.baseUrl, "AI_BASE_URL"),
      model: requireValue(process.env.AI_MODEL ?? local.ai?.model, "AI_MODEL"),
      apiKey: devAuthBypassEnabled
        ? process.env[apiKeyEnv] ?? "dev-auth-bypass-api-key"
        : requireValue(process.env[apiKeyEnv], apiKeyEnv)
    }
  };
}
