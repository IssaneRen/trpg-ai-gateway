import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RuntimeConfig {
  port: number;
  wikiEntriesDir: string;
  npcRootDir: string;
  ai: {
    baseUrl: string;
    model: string;
    apiKey: string;
  };
}

interface LocalConfigFile {
  port?: number;
  wikiEntriesDir?: string;
  npcRootDir?: string;
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

export function loadRuntimeConfig(): RuntimeConfig {
  const local = readLocalConfig();
  const apiKeyEnv = local.ai?.apiKeyEnv ?? process.env.AI_API_KEY_ENV ?? "DEEPSEEK_API_KEY";

  return {
    port: Number(process.env.PORT ?? local.port ?? 3001),
    wikiEntriesDir: resolve(
      process.env.WIKI_ENTRIES_DIR ??
        local.wikiEntriesDir ??
        "/var/www/trpg-helper/wiki/entities/entries"
    ),
    npcRootDir: resolve(process.env.NPC_ROOT_DIR ?? local.npcRootDir ?? "./data/npcs"),
    ai: {
      baseUrl: process.env.AI_BASE_URL ?? local.ai?.baseUrl ?? "https://api.deepseek.com",
      model: process.env.AI_MODEL ?? local.ai?.model ?? "deepseek-v4-flash",
      apiKey: requireValue(process.env[apiKeyEnv], apiKeyEnv)
    }
  };
}
