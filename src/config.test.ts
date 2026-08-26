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
    expect(config.analyticsRootDir).toBe(resolve(realpathSync(root), ".local/analytics"));
    expect(config.analyticsMaxEvents).toBe(20000);
    expect(config.contentRootDir).toBe(resolve(realpathSync(root), ".local/content"));
    expect(config.contentUploadRootDir).toBe(resolve(realpathSync(root), ".local/content-uploads"));
    expect(config.contentUploadBaseUrl).toBe("/content-assets");
    expect(config.contentMaxUploadBytes).toBe(10 * 1024 * 1024);
    expect(config.contentMaxImportBytes).toBe(256 * 1024 * 1024);
    expect(config.moduleClueContentRootDir).toBe(resolve(realpathSync(root), "module-clues"));
    expect(config.moduleClueVisibilityRootDir).toBe(resolve(realpathSync(root), "module-clues"));
  });

  it("loads runtime content storage settings from config and environment", () => {
    const root = mkdtempSync(join(tmpdir(), "trpg-ai-gateway-config-"));
    writeFileSync(join(root, "token-hashes.json"), "[]");
    writeFileSync(
      join(root, "config.local.json"),
      JSON.stringify({
        port: 3001,
        allowedOrigin: "http://localhost:5173",
        wikiEntriesDir: "wiki",
        npcRootDir: "npcs",
        chatMemoryRootDir: "chat-memory",
        contentRootDir: "local-content",
        contentUploadRootDir: "local-uploads",
        contentUploadBaseUrl: "/local-assets",
        contentMaxUploadBytes: 1234,
        contentMaxImportBytes: 5678,
        moduleClueRootDir: "module-clues",
        tokenHashFile: "token-hashes.json",
        ai: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKeyEnv: "DEEPSEEK_API_KEY" }
      })
    );
    process.chdir(root);
    process.env = {
      ...originalEnv,
      TOKEN_HASH_PEPPER: "pepper",
      DEEPSEEK_API_KEY: "key",
      CONTENT_ROOT_DIR: "env-content",
      CONTENT_UPLOAD_ROOT_DIR: "env-uploads",
      CONTENT_UPLOAD_BASE_URL: "/env-assets",
      CONTENT_MAX_UPLOAD_BYTES: "4321",
      CONTENT_MAX_IMPORT_BYTES: "8765"
    };

    const config = loadRuntimeConfig();
    expect(config.contentRootDir).toBe(resolve(realpathSync(root), "env-content"));
    expect(config.contentUploadRootDir).toBe(resolve(realpathSync(root), "env-uploads"));
    expect(config.contentUploadBaseUrl).toBe("/env-assets");
    expect(config.contentMaxUploadBytes).toBe(4321);
    expect(config.contentMaxImportBytes).toBe(8765);
  });

  it("loads qq chatbot internal settings from environment and runtime player map file", () => {
    const root = mkdtempSync(join(tmpdir(), "trpg-ai-gateway-config-"));
    const playerMapFile = join(root, "qq-chatbot.players.json");
    writeFileSync(join(root, "token-hashes.json"), "[]");
    writeFileSync(playerMapFile, JSON.stringify({ "123456789": "pl.cici" }, null, 2));
    writeFileSync(
      join(root, "config.local.json"),
      JSON.stringify({
        port: 3001,
        allowedOrigin: "http://localhost:5173",
        wikiEntriesDir: "wiki",
        npcRootDir: "npcs",
        chatMemoryRootDir: "chat-memory",
        moduleClueRootDir: "module-clues",
        tokenHashFile: "token-hashes.json",
        ai: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKeyEnv: "DEEPSEEK_API_KEY" }
      })
    );
    process.chdir(root);
    process.env = {
      ...originalEnv,
      TOKEN_HASH_PEPPER: "pepper",
      DEEPSEEK_API_KEY: "key",
      QQ_CHATBOT_INTERNAL_TOKEN: "local-internal-token",
      QQ_CHATBOT_PLAYER_MAP_FILE: playerMapFile,
      QQ_CHATBOT_ADMIN_QQ_IDS: "123456789,987654321"
    };

    const config = loadRuntimeConfig();
    expect(config.qqChatbot.internalToken).toBe("local-internal-token");
    expect(config.qqChatbot.playerMapFile).toBe(playerMapFile);
    expect(config.qqChatbot.playerMap).toEqual({ "123456789": "pl.cici" });
    expect(config.qqChatbot.adminQqIds).toEqual(["123456789", "987654321"]);
  });

  it("loads analytics storage settings from config and environment", () => {
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
          analyticsRootDir: "local-analytics",
          analyticsMaxEvents: 15,
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
      DEEPSEEK_API_KEY: "dev-placeholder",
      ANALYTICS_ROOT_DIR: "env-analytics",
      ANALYTICS_MAX_EVENTS: "7"
    };

    const config = loadRuntimeConfig();
    expect(config.analyticsRootDir).toBe(resolve(realpathSync(root), "env-analytics"));
    expect(config.analyticsMaxEvents).toBe(7);
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
