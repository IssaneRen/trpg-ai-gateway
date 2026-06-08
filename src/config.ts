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
  const apiKeyEnv = requireValue(local.ai?.apiKeyEnv ?? process.env.AI_API_KEY_ENV, "AI_API_KEY_ENV");
  const localPort = local.port === undefined ? undefined : String(local.port);

  return {
    port: Number(requireValue(process.env.PORT ?? localPort, "PORT")),
    wikiEntriesDir: resolve(requireValue(process.env.WIKI_ENTRIES_DIR ?? local.wikiEntriesDir, "WIKI_ENTRIES_DIR")),
    npcRootDir: resolve(requireValue(process.env.NPC_ROOT_DIR ?? local.npcRootDir, "NPC_ROOT_DIR")),
    ai: {
      baseUrl: requireValue(process.env.AI_BASE_URL ?? local.ai?.baseUrl, "AI_BASE_URL"),
      model: requireValue(process.env.AI_MODEL ?? local.ai?.model, "AI_MODEL"),
      apiKey: requireValue(process.env[apiKeyEnv], apiKeyEnv)
    }
  };
}
