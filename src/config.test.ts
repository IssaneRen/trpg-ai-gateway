import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashToken } from "./auth/tokens.js";
import { loadRuntimeConfig } from "./config.js";

const originalCwd = process.cwd();
const originalEnv = { ...process.env };

afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
});

describe("loadRuntimeConfig", () => {
  it("loads allowedOrigin from config.local.json for local development", () => {
    const root = mkdtempSync(join(tmpdir(), "trpg-ai-gateway-config-"));
    const tokenHashPepper = "local-pepper";
    writeFileSync(
      join(root, "token-hashes.json"),
      JSON.stringify(
        [
          {
            playerId: "pl.leina",
            displayName: "莱纳",
            tokenHash: hashToken("local-token", tokenHashPepper)
          }
        ],
        null,
        2
      )
    );
    writeFileSync(
      join(root, "config.local.json"),
      JSON.stringify(
        {
          port: 3001,
          allowedOrigin: "http://localhost:5173,http://127.0.0.1:5173",
          wikiEntriesDir: "wiki",
          npcRootDir: "npcs",
          chatMemoryRootDir: "chat-memory",
          tokenHashFile: "token-hashes.json",
          ai: {
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-chat",
            apiKeyEnv: "DEEPSEEK_API_KEY"
          }
        },
        null,
        2
      )
    );

    process.chdir(root);
    process.env = {
      ...originalEnv,
      TOKEN_HASH_PEPPER: tokenHashPepper,
      DEEPSEEK_API_KEY: "dev-placeholder"
    };
    delete process.env.ALLOWED_ORIGIN;

    expect(loadRuntimeConfig().allowedOrigin).toBe("http://localhost:5173,http://127.0.0.1:5173");
  });
});
