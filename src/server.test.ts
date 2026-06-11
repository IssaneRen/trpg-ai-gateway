import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashToken, type TokenHashRecord } from "./auth/tokens.js";
import { createApp } from "./server.js";
import type { RuntimeConfig } from "./config.js";
import type { AiProvider, ProviderChatRequest } from "./types.js";

const config: RuntimeConfig = {
  port: 0,
  allowedOrigin: "https://main.example.com",
  wikiEntriesDir: "/unused",
  npcRootDir: "/unused",
  chatMemoryRootDir: "/unused",
  tokenHashPepper: "test-pepper",
  supportedPlayerIds: ["pl.cici"],
  tokenHashRecords: [],
  ai: {
    baseUrl: "https://unused.example.com",
    model: "unused",
    apiKey: "unused"
  }
};
const keeperToken = ["kp", "114514"].join("");

class FakeProvider implements AiProvider {
  calls: ProviderChatRequest[] = [];
  constructor(private readonly responses: string[] = ["NPC reply"]) {}

  async chat(request: ProviderChatRequest) {
    this.calls.push(request);
    return { content: this.responses.shift() ?? "NPC reply" };
  }
}

function tokenRecord(
  token: string,
  playerId: string,
  displayName: string,
  isKeeper = false,
  pepper = config.tokenHashPepper
): TokenHashRecord {
  return {
    playerId,
    displayName,
    isKeeper,
    tokenHash: hashToken(token, pepper)
  };
}

function createFixture(overrides: Partial<RuntimeConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "trpg-ai-gateway-server-"));
  const wikiEntriesDir = join(root, "wiki");
  const npcRootDir = join(root, "npcs");
  const chatMemoryRootDir = join(root, "chat-memory");
  const npcDir = join(npcRootDir, "char.claire");
  mkdirSync(wikiEntriesDir, { recursive: true });
  mkdirSync(join(npcDir, "players"), { recursive: true });
  mkdirSync(join(chatMemoryRootDir, "char.claire", "players", "pl.cici"), { recursive: true });
  mkdirSync(join(chatMemoryRootDir, "char.claire", "players", "pl.leina"), { recursive: true });
  writeFileSync(
    join(npcDir, "npc.json"),
    JSON.stringify(
      {
        id: "char.claire",
        displayName: "克莱儿",
        role: "NPC",
        tone: "谨慎"
      },
      null,
      2
    )
  );
  const lockedNpcDir = join(npcRootDir, "char.locked");
  mkdirSync(lockedNpcDir, { recursive: true });
  writeFileSync(
    join(lockedNpcDir, "npc.json"),
    JSON.stringify(
      {
        id: "char.locked",
        displayName: "锁定 NPC",
        role: "NPC",
        tone: "沉默",
        supportedPlayerIds: ["pl.leina"]
      },
      null,
      2
    )
  );
  writeFileSync(
    join(npcDir, "ai-context.json"),
    JSON.stringify({ privateDirective: "AI 私有上下文" }, null, 2)
  );

  const runtimeConfig: RuntimeConfig = {
    ...config,
    wikiEntriesDir,
    npcRootDir,
    chatMemoryRootDir,
    supportedPlayerIds: ["pl.cici", "pl.leina"],
    tokenHashRecords: [
      tokenRecord("cici-token", "pl.cici", "Cici"),
      tokenRecord("leina-token", "pl.leina", "莱纳"),
      tokenRecord(keeperToken, "kp", "kp大人", true)
    ],
    ...overrides
  };

  return { root, npcRootDir, chatMemoryRootDir, config: runtimeConfig };
}

async function withServer<T>(
  runtimeConfig: RuntimeConfig,
  provider: AiProvider,
  fn: (baseUrl: string) => Promise<T>
) {
  const app = createApp(runtimeConfig, { provider });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
}

describe("createApp CORS", () => {
  it("allows preflight requests from the configured origin", async () => {
    const app = createApp(config);
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
      method: "OPTIONS",
      headers: {
        origin: "https://main.example.com",
        "access-control-request-method": "POST"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://main.example.com");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type, authorization");
    await new Promise<void>((resolve) => app.close(() => resolve()));
  });

  it("allows preflight requests from any configured comma-separated origin", async () => {
    const app = createApp({
      ...config,
      allowedOrigin: "https://issane.cn,https://www.issane.cn"
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
      method: "OPTIONS",
      headers: {
        origin: "https://www.issane.cn",
        "access-control-request-method": "POST"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://www.issane.cn");
    await new Promise<void>((resolve) => app.close(() => resolve()));
  });
});

describe("createApp auth and npc chat APIs", () => {
  it("returns the session for a valid bearer token and hides token material", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/session`, {
        method: "POST",
        headers: { authorization: "Bearer cici-token" }
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ playerId: "pl.cici", displayName: "Cici", isKeeper: false });
      expect(JSON.stringify(body)).not.toContain("token");
    });
  });

  it("returns one unauthorized shape for missing and invalid bearer tokens", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/session`, { method: "POST" });
      const invalid = await fetch(`${baseUrl}/api/session`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" }
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(await missing.json()).toEqual({ error: "unauthorized" });
      expect(await invalid.json()).toEqual({ error: "unauthorized" });
    });
  });

  it("rejects token records whose playerId is not supported", async () => {
    const fixture = createFixture({
      supportedPlayerIds: ["pl.cici"],
      tokenHashRecords: [tokenRecord("outsider-token", "pl.outsider", "Outsider")]
    });
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/session`, {
        method: "POST",
        headers: { authorization: "Bearer outsider-token" }
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    });
  });

  it("forbids client-submitted playerId in chat bodies", async () => {
    const fixture = createFixture();
    const provider = new FakeProvider();
    await withServer(fixture.config, provider, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { authorization: "Bearer cici-token", "content-type": "application/json" },
        body: JSON.stringify({ npcId: "char.claire", playerId: "pl.leina", message: "hello" })
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "playerId is not allowed" });
      expect(provider.calls).toHaveLength(0);
    });
  });

  it("forbids keeper tokens from direct npc chat, history, and delete", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const headers = { authorization: `Bearer ${keeperToken}`, "content-type": "application/json" };
      const chat = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ npcId: "char.claire", message: "hello" })
      });
      const history = await fetch(`${baseUrl}/api/chat/history?npcId=char.claire`, { headers });
      const deleted = await fetch(`${baseUrl}/api/chat/history`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ npcId: "char.claire" })
      });

      expect(chat.status).toBe(403);
      expect(history.status).toBe(403);
      expect(deleted.status).toBe(403);
    });
  });

  it("lists npcs without exposing ai-context", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/npcs`, {
        headers: { authorization: "Bearer cici-token" }
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        npcs: [{ id: "char.claire", displayName: "克莱儿", role: "NPC", tone: "谨慎" }]
      });
      expect(JSON.stringify(body)).not.toContain("AI 私有上下文");
    });
  });

  it("filters npcs and chat actions by the bearer player's npc access", async () => {
    const fixture = createFixture();
    const provider = new FakeProvider();
    await withServer(fixture.config, provider, async (baseUrl) => {
      const list = await fetch(`${baseUrl}/api/npcs`, {
        headers: { authorization: "Bearer cici-token" }
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({
        npcs: [{ id: "char.claire", displayName: "克莱儿", role: "NPC", tone: "谨慎" }]
      });

      const chat = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { authorization: "Bearer cici-token", "content-type": "application/json" },
        body: JSON.stringify({ npcId: "char.locked", message: "有人吗？" })
      });
      expect(chat.status).toBe(403);
      expect(provider.calls).toHaveLength(0);
    });
  });

  it("scopes history to the bearer player, caps limit, rejects traversal, and deletes only that scope", async () => {
    const fixture = createFixture();
    const ciciDir = join(fixture.chatMemoryRootDir, "char.claire", "players", "pl.cici");
    const leinaDir = join(fixture.chatMemoryRootDir, "char.claire", "players", "pl.leina");
    const ciciLines = Array.from({ length: 201 }, (_, index) =>
      JSON.stringify({ timestamp: `t-${index}`, role: "user", content: `cici-${index}` })
    );
    writeFileSync(join(ciciDir, "full_log.log"), `${ciciLines.join("\n")}\n`);
    writeFileSync(join(ciciDir, "current_context.md"), "cici context");
    writeFileSync(
      join(leinaDir, "full_log.log"),
      `${JSON.stringify({ timestamp: "t-other", role: "user", content: "leina secret" })}\n`
    );

    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const history = await fetch(`${baseUrl}/api/chat/history?npcId=char.claire&limit=999`, {
        headers: { authorization: "Bearer cici-token" }
      });
      expect(history.status).toBe(200);
      const historyBody = await history.json();
      expect(historyBody.messages).toHaveLength(200);
      expect(historyBody.messages[0].content).toBe("cici-1");
      expect(JSON.stringify(historyBody)).not.toContain("leina secret");

      const traversal = await fetch(`${baseUrl}/api/chat/history?npcId=../char.claire`, {
        headers: { authorization: "Bearer cici-token" }
      });
      expect(traversal.status).toBe(400);

      const deleted = await fetch(`${baseUrl}/api/chat/history`, {
        method: "DELETE",
        headers: { authorization: "Bearer cici-token", "content-type": "application/json" },
        body: JSON.stringify({ npcId: "char.claire" })
      });
      expect(deleted.status).toBe(200);

      const backups = readdirSync(ciciDir).filter((name) =>
        /^full_log_backup_\d{12}\.log$/.test(name)
      );
      expect(backups).toHaveLength(1);
      await expect(stat(join(ciciDir, "current_context.md"))).rejects.toMatchObject({
        code: "ENOENT"
      });
      expect(await readFile(join(leinaDir, "full_log.log"), "utf-8")).toContain("leina secret");
    });
  });

  it("compresses oversized current context before posting chat", async () => {
    const fixture = createFixture();
    const ciciDir = join(fixture.chatMemoryRootDir, "char.claire", "players", "pl.cici");
    writeFileSync(join(ciciDir, "current_context.md"), `x`.repeat(10 * 1024 * 1024 + 1));
    const provider = new FakeProvider(["compressed context", "after compression reply"]);

    await withServer(fixture.config, provider, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { authorization: "Bearer cici-token", "content-type": "application/json" },
        body: JSON.stringify({ npcId: "char.claire", message: "现在如何？" })
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ content: "after compression reply" });
      expect(provider.calls).toHaveLength(2);
      expect(provider.calls[0].messages[0].content).toContain("压缩");
      const context = await readFile(join(ciciDir, "current_context.md"), "utf-8");
      expect(context.startsWith("compressed context")).toBe(true);
      expect(context).toContain("现在如何？");
    });
  });
});
