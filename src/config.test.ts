import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
          moduleClueRootDir: "module-clues",
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

    const config = loadRuntimeConfig();
    expect(config.allowedOrigin).toBe("http://localhost:5173,http://127.0.0.1:5173");
    expect(config.moduleClueContentRootDir).toBe(resolve(realpathSync(root), "module-clues"));
    expect(config.moduleClueVisibilityRootDir).toBe(resolve(realpathSync(root), "module-clues"));
  });

  it("loads module clue content and visibility roots separately", () => {
    const root = mkdtempSync(join(tmpdir(), "trpg-ai-gateway-config-"));
    const tokenHashPepper = "local-pepper";
    writeFileSync(join(root, "token-hashes.json"), "[]");
    writeFileSync(
      join(root, "config.local.json"),
      JSON.stringify(
        {
          port: 3001,
          allowedOrigin: "http://localhost:5173",
          wikiEntriesDir: "wiki",
          npcRootDir: "npcs",
          chatMemoryRootDir: "chat-memory",
          moduleClueContentRootDir: "module-clue-content",
          moduleClueVisibilityRootDir: ".local/module-clue-visibility",
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

    const config = loadRuntimeConfig();
    expect(config.moduleClueContentRootDir).toBe(resolve(realpathSync(root), "module-clue-content"));
    expect(config.moduleClueVisibilityRootDir).toBe(resolve(realpathSync(root), ".local/module-clue-visibility"));
  });

  it("uses safe local placeholders for auth pepper and ai key when dev auth bypass is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "trpg-ai-gateway-config-"));
    writeFileSync(join(root, "token-hashes.json"), "[]");
    writeFileSync(
      join(root, "config.local.json"),
      JSON.stringify(
        {
          port: 3001,
          allowedOrigin: "http://127.0.0.1:5173",
          wikiEntriesDir: "wiki",
          npcRootDir: "npcs",
          chatMemoryRootDir: "chat-memory",
          moduleClueRootDir: "module-clues",
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
      DEV_AUTH_BYPASS: "1"
    };
    delete process.env.NODE_ENV;
    delete process.env.TOKEN_HASH_PEPPER;
    delete process.env.DEEPSEEK_API_KEY;

    const config = loadRuntimeConfig();
    expect(config.tokenHashPepper).toBe("dev-auth-bypass-pepper");
    expect(config.ai.apiKey).toBe("dev-auth-bypass-api-key");
  });

  it("does not allow dev auth bypass placeholders in production", () => {
    const root = mkdtempSync(join(tmpdir(), "trpg-ai-gateway-config-"));
    writeFileSync(join(root, "token-hashes.json"), "[]");
    writeFileSync(
      join(root, "config.local.json"),
      JSON.stringify(
        {
          port: 3001,
          allowedOrigin: "http://127.0.0.1:5173",
          wikiEntriesDir: "wiki",
          npcRootDir: "npcs",
          chatMemoryRootDir: "chat-memory",
          moduleClueRootDir: "module-clues",
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
      DEV_AUTH_BYPASS: "1",
      NODE_ENV: "production"
    };
    delete process.env.TOKEN_HASH_PEPPER;
    delete process.env.DEEPSEEK_API_KEY;

    expect(() => loadRuntimeConfig()).toThrow("Missing required config: TOKEN_HASH_PEPPER");
  });
});
