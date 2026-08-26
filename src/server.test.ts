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
  analyticsRootDir: "/unused",
  analyticsMaxEvents: 20000,
  contentRootDir: "/unused",
  contentUploadRootDir: "/unused",
  contentUploadBaseUrl: "/content-assets",
  contentMaxUploadBytes: 1024 * 1024,
  contentMaxImportBytes: 8 * 1024 * 1024,
  moduleClueContentRootDir: "/unused",
  moduleClueVisibilityRootDir: "/unused",
  tokenHashPepper: "test-pepper",
  supportedPlayerIds: ["pl.cici"],
  tokenHashRecords: [],
  ai: {
    baseUrl: "https://unused.example.com",
    model: "unused",
    apiKey: "unused"
  },
  qqChatbot: {
    playerMap: {},
    adminQqIds: []
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
  const analyticsRootDir = join(root, "analytics");
  const contentRootDir = join(root, "content");
  const contentUploadRootDir = join(root, "content-uploads");
  const moduleClueContentRootDir = join(root, "module-clue-content");
  const moduleClueVisibilityRootDir = join(root, "module-clue-visibility");
  const npcDir = join(npcRootDir, "char.claire");
  mkdirSync(wikiEntriesDir, { recursive: true });
  mkdirSync(join(npcDir, "players"), { recursive: true });
  mkdirSync(join(chatMemoryRootDir, "char.claire", "players", "pl.cici"), { recursive: true });
  mkdirSync(join(chatMemoryRootDir, "char.claire", "players", "pl.leina"), { recursive: true });
  mkdirSync(analyticsRootDir, { recursive: true });
  mkdirSync(join(contentRootDir, "blog", "posts"), { recursive: true });
  mkdirSync(join(contentRootDir, "wiki", "entities", "entries"), { recursive: true });
  mkdirSync(contentUploadRootDir, { recursive: true });
  writeFileSync(join(contentRootDir, "blog", "index.json"), "[]\n");
  writeFileSync(join(contentRootDir, "wiki", "entities", "players.json"), "[]\n");
  writeFileSync(join(contentRootDir, "wiki", "entities", "modules.json"), "[]\n");
  writeFileSync(
    join(contentRootDir, "wiki", "index.json"),
    JSON.stringify({ players: [], modules: [], entries: [], lookup: { entryIdByName: {}, playerIdByName: {}, moduleIdByName: {} } })
  );
  mkdirSync(join(moduleClueContentRootDir, "naimen-prologue"), { recursive: true });
  mkdirSync(join(moduleClueVisibilityRootDir, "naimen-prologue"), { recursive: true });
  mkdirSync(join(moduleClueContentRootDir, "drafts"), { recursive: true });
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
  writeFileSync(
    join(moduleClueContentRootDir, "naimen-prologue", "clues.json"),
    JSON.stringify(
      {
        moduleId: "naimen-prologue",
        moduleName: "奈面序章",
        clues: [
          {
            id: "arrival",
            title: "抵达奈面町",
            summary: "一切记录从抵达开始。",
            detail: "公开给 Cici 的抵达记录。",
            tags: ["序章"],
            thumbnail: "/wiki/images/naimen/arrival.jpg",
            order: 1,
            reveals: ["hidden-letter", "station-clock"],
            revealReasons: {
              "hidden-letter": "抵达后发现只对莱纳开放的密信。",
              "station-clock": "抵达现场能直接看到停摆的站钟。"
            }
          },
          {
            id: "hidden-letter",
            title: "不可见的密信",
            summary: "莱纳才能看到的密信摘要。",
            detail: "这段内容不应该出现在 Cici 的响应里。",
            tags: ["密信"],
            thumbnail: "/wiki/images/naimen/letter.jpg",
            order: 2,
            reveals: ["station-clock"]
          },
          {
            id: "station-clock",
            title: "停摆的站钟",
            summary: "站钟停在同一个时刻。",
            detail: "Cici 可以看到的站钟细节。",
            tags: ["时间"],
            order: 3,
            reveals: []
          }
        ]
      },
      null,
      2
    )
  );
  writeFileSync(
    join(moduleClueVisibilityRootDir, "naimen-prologue", "visibility.json"),
    JSON.stringify(
      {
        version: 1,
        clues: {
          arrival: ["pl.cici"],
          "hidden-letter": ["pl.leina"],
          "station-clock": ["pl.cici"]
        }
      },
      null,
      2
    )
  );
  mkdirSync(join(moduleClueContentRootDir, "keeper-archive"), { recursive: true });
  mkdirSync(join(moduleClueVisibilityRootDir, "keeper-archive"), { recursive: true });
  writeFileSync(
    join(moduleClueContentRootDir, "keeper-archive", "clues.json"),
    JSON.stringify(
      {
        moduleId: "keeper-archive",
        moduleName: "KP 档案",
        clues: [
          {
            id: "keeper-note",
            title: "KP 备忘",
            summary: "只有 KP 和莱纳可以看见。",
            tags: ["管理"],
            order: 1,
            reveals: []
          }
        ]
      },
      null,
      2
    )
  );
  writeFileSync(
    join(moduleClueVisibilityRootDir, "keeper-archive", "visibility.json"),
    JSON.stringify(
      {
        version: 1,
        clues: {
          "keeper-note": ["pl.leina"]
        }
      },
      null,
      2
    )
  );
  mkdirSync(join(moduleClueContentRootDir, "default-visibility"), { recursive: true });
  writeFileSync(
    join(moduleClueContentRootDir, "default-visibility", "clues.json"),
    JSON.stringify(
      {
        moduleId: "default-visibility",
        moduleName: "默认可见性测试",
        clues: [
          {
            id: "entry",
            title: "默认入口",
            summary: "未配置 visibility 时默认对所有 PL 可见。",
            tags: ["入口"],
            order: 1,
            isInitial: true,
            reveals: ["secret"]
          },
          {
            id: "configured-entry",
            title: "显式入口",
            summary: "即使是入口，也应以 visibility 显式配置为准。",
            tags: ["入口"],
            order: 2,
            isInitial: true,
            reveals: []
          },
          {
            id: "secret",
            title: "默认隐藏",
            summary: "未配置 visibility 时不应该默认对 PL 可见。",
            tags: ["隐藏"],
            order: 3,
            reveals: []
          }
        ]
      },
      null,
      2
    )
  );
  mkdirSync(join(moduleClueVisibilityRootDir, "default-visibility"), { recursive: true });
  writeFileSync(
    join(moduleClueVisibilityRootDir, "default-visibility", "visibility.json"),
    JSON.stringify(
      {
        version: 1,
        clues: {
          "configured-entry": ["pl.leina"]
        }
      },
      null,
      2
    )
  );

  const runtimeConfig: RuntimeConfig = {
    ...config,
    wikiEntriesDir,
    npcRootDir,
    chatMemoryRootDir,
    analyticsRootDir,
    contentRootDir,
    contentUploadRootDir,
    moduleClueContentRootDir,
    moduleClueVisibilityRootDir,
    supportedPlayerIds: ["pl.cici", "pl.leina"],
    tokenHashRecords: [
      tokenRecord("cici-token", "pl.cici", "Cici"),
      tokenRecord("leina-token", "pl.leina", "莱纳"),
      tokenRecord(keeperToken, "kp", "kp大人", true)
    ],
    ...overrides
  };

  return {
    root,
    npcRootDir,
    chatMemoryRootDir,
    analyticsRootDir,
    contentRootDir,
    contentUploadRootDir,
    moduleClueContentRootDir,
    moduleClueVisibilityRootDir,
    config: runtimeConfig
  };
}

describe("createApp content admin APIs", () => {
  it("requires a keeper token for every admin content route", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/admin/content/overview`);
      expect(missing.status).toBe(401);

      const player = await fetch(`${baseUrl}/api/admin/content/overview`, {
        headers: { authorization: "Bearer cici-token" }
      });
      expect(player.status).toBe(403);

      const keeper = await fetch(`${baseUrl}/api/admin/content/overview`, {
        headers: { authorization: `Bearer ${keeperToken}` }
      });
      expect(keeper.status).toBe(200);
      expect(await keeper.json()).toEqual({ blogs: [], wikiEntries: [], players: [], modules: [] });
    });
  });

  it("lets keepers create and read blog and Wiki documents", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const headers = {
        authorization: `Bearer ${keeperToken}`,
        "content-type": "application/json"
      };
      const blog = {
        id: "runtime-post",
        title: "运行时文章",
        tags: ["博客"],
        renderMode: "markdown",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
        markdown: "# 无需重新部署"
      };
      const blogSave = await fetch(`${baseUrl}/api/admin/content/blog/runtime-post`, {
        method: "PUT",
        headers,
        body: JSON.stringify(blog)
      });
      expect(blogSave.status).toBe(200);
      expect(await blogSave.json()).toMatchObject({ id: "runtime-post", title: "运行时文章" });

      const blogRead = await fetch(`${baseUrl}/api/admin/content/blog/runtime-post`, {
        headers: { authorization: `Bearer ${keeperToken}` }
      });
      expect(blogRead.status).toBe(200);
      expect(await blogRead.json()).toMatchObject({ markdown: "# 无需重新部署\n" });

      const wiki = {
        id: "event.runtime",
        category: "event",
        displayName: "运行时事件",
        summary: "后台写入。",
        content: [{ type: "secret-panel", hiddenMode: "collapse", playerIds: [], blocks: [] }],
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z"
      };
      const wikiSave = await fetch(`${baseUrl}/api/admin/content/wiki/event.runtime`, {
        method: "PUT",
        headers,
        body: JSON.stringify(wiki)
      });
      expect(wikiSave.status).toBe(200);
      expect(await wikiSave.json()).toMatchObject({ id: "event.runtime" });

      const overview = await fetch(`${baseUrl}/api/admin/content/overview`, {
        headers: { authorization: `Bearer ${keeperToken}` }
      });
      expect(await overview.json()).toMatchObject({
        blogs: [{ id: "runtime-post", title: "运行时文章" }],
        wikiEntries: [{ id: "event.runtime", displayName: "运行时事件" }]
      });
    });
  });

  it("uploads images and round-trips a ZIP backup for keepers", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const authorization = { authorization: `Bearer ${keeperToken}` };
      const upload = await fetch(`${baseUrl}/api/admin/content/images?fileName=${encodeURIComponent("封面.png")}`, {
        method: "POST",
        headers: { ...authorization, "content-type": "image/png" },
        body: new Uint8Array([137, 80, 78, 71])
      });
      expect(upload.status).toBe(201);
      expect(await upload.json()).toMatchObject({ mimeType: "image/png", size: 4 });

      const exported = await fetch(`${baseUrl}/api/admin/content/export`, { headers: authorization });
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type")).toBe("application/zip");
      const archive = await exported.arrayBuffer();
      expect(archive.byteLength).toBeGreaterThan(100);

      const imported = await fetch(`${baseUrl}/api/admin/content/import`, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/zip" },
        body: archive
      });
      expect(imported.status).toBe(200);
      expect(await imported.json()).toMatchObject({ blogPosts: 0, wikiEntries: 0, uploadedFiles: 1 });
    });
  });
});

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
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE, OPTIONS");
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

describe("createApp analytics APIs", () => {
  it("records analytics events with the bearer session display name", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/analytics/events`, {
        method: "POST",
        headers: {
          authorization: "Bearer cici-token",
          "content-type": "application/json",
          "user-agent": "Vitest Browser",
          "x-real-ip": "203.0.113.9"
        },
        body: JSON.stringify({
          eventName: "page_view",
          eventTime: "2026-07-09T10:00:00.000Z",
          anonymousId: "anon-cici",
          sessionId: "session-cici",
          pagePath: "/blog",
          pageUrl: "https://main.example.com/blog",
          pageTitle: "博客杂谈",
          referrer: "https://ref.example.com",
          properties: { source: "route" }
        })
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true });

      const raw = await readFile(join(fixture.analyticsRootDir, "events.jsonl"), "utf-8");
      const stored = JSON.parse(raw.trim());
      expect(stored).toMatchObject({
        eventName: "page_view",
        eventTime: "2026-07-09T10:00:00.000Z",
        anonymousId: "anon-cici",
        sessionId: "session-cici",
        pagePath: "/blog",
        pageUrl: "https://main.example.com/blog",
        pageTitle: "博客杂谈",
        referrer: "https://ref.example.com",
        properties: { source: "route" },
        playerId: "pl.cici",
        playerDisplayName: "Cici",
        isKeeper: false,
        ip: "203.0.113.9",
        userAgent: "Vitest Browser"
      });
      expect(stored.eventId).toMatch(/^evt_/);
      expect(stored.receivedAt).toBe("2026-07-09T10:00:00.000Z");
    });
  });

  it("summarizes analytics for keeper tokens without exposing raw ip values", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      for (const event of [
        {
          headers: { authorization: "Bearer cici-token" },
          body: {
            eventName: "page_view",
            eventTime: "2026-07-09T10:00:00.000Z",
            anonymousId: "anon-cici",
            sessionId: "session-cici",
            pagePath: "/blog",
            pageTitle: "博客杂谈"
          }
        },
        {
          headers: {},
          body: {
            eventName: "click_blog_card",
            eventTime: "2026-07-09T10:01:00.000Z",
            anonymousId: "anon-guest",
            sessionId: "session-guest",
            pagePath: "/blog",
            properties: { postId: "report.invite-to-dance-20260607" }
          }
        }
      ]) {
        const response = await fetch(`${baseUrl}/api/analytics/events`, {
          method: "POST",
          headers: {
            ...event.headers,
            "content-type": "application/json",
            "x-real-ip": "198.51.100.8"
          },
          body: JSON.stringify(event.body)
        });
        expect(response.status).toBe(202);
      }

      const missing = await fetch(`${baseUrl}/api/analytics/summary`);
      expect(missing.status).toBe(401);

      const player = await fetch(`${baseUrl}/api/analytics/summary`, {
        headers: { authorization: "Bearer cici-token" }
      });
      expect(player.status).toBe(403);

      const keeper = await fetch(`${baseUrl}/api/analytics/summary`, {
        headers: { authorization: `Bearer ${keeperToken}` }
      });
      expect(keeper.status).toBe(200);
      const body = await keeper.json();
      expect(body).toMatchObject({
        totals: {
          events: 2,
          pageViews: 1,
          clicks: 1,
          uniqueVisitors: 2
        },
        topPages: [{ pagePath: "/blog", pv: 1, uv: 1 }],
        topClicks: [{ eventName: "click_blog_card", pv: 1, uv: 1 }],
        players: [{ displayName: "Cici", playerId: "pl.cici", events: 1 }]
      });
      expect(JSON.stringify(body)).not.toContain("198.51.100.8");
      expect(JSON.stringify(body)).not.toContain("ip");
    });
  });

  it("keeps only the most recent analytics events when the retention limit is reached", async () => {
    const fixture = createFixture({ analyticsMaxEvents: 2 });
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      for (const pagePath of ["/first", "/second", "/third"]) {
        const response = await fetch(`${baseUrl}/api/analytics/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            eventName: "page_view",
            anonymousId: `anon-${pagePath}`,
            sessionId: `session-${pagePath}`,
            pagePath
          })
        });
        expect(response.status).toBe(202);
      }

      const raw = await readFile(join(fixture.analyticsRootDir, "events.jsonl"), "utf-8");
      const pagePaths = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).pagePath);
      expect(pagePaths).toEqual(["/second", "/third"]);
    });
  });
});

describe("createApp module clue APIs", () => {
  it("lists clue modules visible to the bearer session", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const playerResponse = await fetch(`${baseUrl}/api/module-clues`, {
        headers: { authorization: "Bearer cici-token" }
      });
      expect(playerResponse.status).toBe(200);
      expect(await playerResponse.json()).toEqual({
        modules: [
          { id: "naimen-prologue", name: "奈面序章" },
          { id: "default-visibility", name: "默认可见性测试" }
        ]
      });

      const leinaResponse = await fetch(`${baseUrl}/api/module-clues`, {
        headers: { authorization: "Bearer leina-token" }
      });
      expect(leinaResponse.status).toBe(200);
      expect(await leinaResponse.json()).toEqual({
        modules: [
          { id: "keeper-archive", name: "KP 档案" },
          { id: "naimen-prologue", name: "奈面序章" },
          { id: "default-visibility", name: "默认可见性测试" }
        ]
      });

      const keeperResponse = await fetch(`${baseUrl}/api/module-clues`, {
        headers: { authorization: `Bearer ${keeperToken}` }
      });
      expect(keeperResponse.status).toBe(200);
      expect(await keeperResponse.json()).toEqual({
        modules: [
          { id: "keeper-archive", name: "KP 档案" },
          { id: "naimen-prologue", name: "奈面序章" },
          { id: "default-visibility", name: "默认可见性测试" }
        ]
      });
    });
  });

  it("rejects missing bearer tokens when listing clue modules", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/module-clues`);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    });
  });

  it("filters clue payload and tags to the bearer player's visible clues", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/module-clues/naimen-prologue`, {
        headers: { authorization: "Bearer cici-token" }
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.module).toEqual({ id: "naimen-prologue", name: "奈面序章" });
      expect(body.clues.map((clue: { id: string }) => clue.id)).toEqual([
        "arrival",
        "station-clock"
      ]);
      expect(body.edges).toEqual([
        {
          id: "arrival->station-clock",
          source: "arrival",
          target: "station-clock",
          reason: "抵达现场能直接看到停摆的站钟。"
        }
      ]);
      expect(body.tags).toEqual(["序章", "时间"]);
      expect(JSON.stringify(body)).not.toContain("不可见的密信");
      expect(JSON.stringify(body)).not.toContain("莱纳才能看到");
      expect(JSON.stringify(body)).not.toContain("这段内容不应该出现在 Cici");
      expect(JSON.stringify(body)).not.toContain("密信");
      expect(JSON.stringify(body)).not.toContain("letter.jpg");
    });
  });

  it("defaults only initial clues to all supported players when visibility is unset", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const playerResponse = await fetch(`${baseUrl}/api/module-clues/default-visibility`, {
        headers: { authorization: "Bearer cici-token" }
      });
      expect(playerResponse.status).toBe(200);
      const playerBody = await playerResponse.json();
      expect(playerBody.clues.map((clue: { id: string }) => clue.id)).toEqual(["entry"]);
      expect(playerBody.edges).toEqual([]);
      expect(playerBody.tags).toEqual(["入口"]);

      const keeperResponse = await fetch(`${baseUrl}/api/module-clues/default-visibility`, {
        headers: { authorization: `Bearer ${keeperToken}` }
      });
      expect(keeperResponse.status).toBe(200);
      const keeperBody = await keeperResponse.json();
      expect(keeperBody.clues.find((clue: { id: string }) => clue.id === "entry").visiblePlayerIds).toEqual([
        "pl.cici",
        "pl.leina"
      ]);
      expect(keeperBody.clues.find((clue: { id: string }) => clue.id === "configured-entry").visiblePlayerIds).toEqual([
        "pl.leina"
      ]);
      expect(keeperBody.clues.find((clue: { id: string }) => clue.id === "secret").visiblePlayerIds).toEqual([]);
    });
  });

  it("does not expose module metadata when a player requests an invisible clue module directly", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/module-clues/keeper-archive`, {
        headers: { authorization: "Bearer cici-token" }
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    });
  });

  it("uses supported player ids, not every token record, for default initial clue visibility metadata", async () => {
    const fixture = createFixture({
      supportedPlayerIds: ["pl.cici"],
      tokenHashRecords: [
        tokenRecord("cici-token", "pl.cici", "Cici"),
        tokenRecord("legacy-token", "pl.legacy", "Legacy"),
        tokenRecord(keeperToken, "kp", "kp大人", true)
      ]
    });

    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/module-clues/default-visibility`, {
        headers: { authorization: `Bearer ${keeperToken}` }
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.clues.find((clue: { id: string }) => clue.id === "entry").visiblePlayerIds).toEqual(["pl.cici"]);
      expect(body.players).toEqual([{ id: "pl.cici", name: "Cici" }]);
    });
  });

  it("returns all clue payload and visibility metadata to keeper tokens", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/module-clues/naimen-prologue`, {
        headers: { authorization: `Bearer ${keeperToken}` }
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.clues.map((clue: { id: string }) => clue.id)).toEqual([
        "arrival",
        "hidden-letter",
        "station-clock"
      ]);
      expect(body.clues.find((clue: { id: string }) => clue.id === "hidden-letter").visiblePlayerIds).toEqual(["pl.leina"]);
      expect(body.tags).toEqual(["序章", "密信", "时间"]);
    });
  });

  it("lets keeper tokens update clue visibility and rejects player tokens", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const playerUpdate = await fetch(`${baseUrl}/api/module-clues/naimen-prologue/visibility/hidden-letter`, {
        method: "PUT",
        headers: { authorization: "Bearer cici-token", "content-type": "application/json" },
        body: JSON.stringify({ playerIds: ["pl.cici"] })
      });
      expect(playerUpdate.status).toBe(403);

      const keeperUpdate = await fetch(`${baseUrl}/api/module-clues/naimen-prologue/visibility/hidden-letter`, {
        method: "PUT",
        headers: { authorization: `Bearer ${keeperToken}`, "content-type": "application/json" },
        body: JSON.stringify({ playerIds: ["pl.cici"] })
      });
      expect(keeperUpdate.status).toBe(200);
      expect(await keeperUpdate.json()).toEqual({ ok: true });

      const refreshed = await fetch(`${baseUrl}/api/module-clues/naimen-prologue`, {
        headers: { authorization: "Bearer cici-token" }
      });
      const body = await refreshed.json();
      expect(body.clues.map((clue: { id: string }) => clue.id)).toEqual([
        "arrival",
        "hidden-letter",
        "station-clock"
      ]);
    });
  });

  it("writes keeper visibility updates only to the visibility root", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/module-clues/naimen-prologue/visibility/hidden-letter`, {
        method: "PUT",
        headers: { authorization: `Bearer ${keeperToken}`, "content-type": "application/json" },
        body: JSON.stringify({ playerIds: ["pl.cici"] })
      });

      expect(response.status).toBe(200);
      const visibility = JSON.parse(
        await readFile(join(fixture.moduleClueVisibilityRootDir, "naimen-prologue", "visibility.json"), "utf-8")
      );
      expect(visibility.clues["hidden-letter"]).toEqual(["pl.cici"]);
      await expect(
        readFile(join(fixture.moduleClueContentRootDir, "naimen-prologue", "visibility.json"), "utf-8")
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects unsafe module and clue path segments", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      for (const moduleId of ["%252E", "%252E%252E", "..%2Fx", "x%2Fy", "x%5Cy"]) {
        const response = await fetch(`${baseUrl}/api/module-clues/${moduleId}`, {
          headers: { authorization: "Bearer cici-token" }
        });
        expect(response.status).toBe(400);
      }

      for (const clueId of ["%252E", "%252E%252E", "..%2Fx", "x%2Fy", "x%5Cy"]) {
        const response = await fetch(`${baseUrl}/api/module-clues/naimen-prologue/visibility/${clueId}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${keeperToken}`, "content-type": "application/json" },
          body: JSON.stringify({ playerIds: ["pl.cici"] })
        });
        expect(response.status).toBe(400);
      }
    });
  });

  it("rejects unknown playerIds and client-submitted playerId in visibility updates", async () => {
    const fixture = createFixture();
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const unknownPlayer = await fetch(`${baseUrl}/api/module-clues/naimen-prologue/visibility/arrival`, {
        method: "PUT",
        headers: { authorization: `Bearer ${keeperToken}`, "content-type": "application/json" },
        body: JSON.stringify({ playerIds: ["pl.unknown"] })
      });
      expect(unknownPlayer.status).toBe(400);

      const spoofedIdentity = await fetch(`${baseUrl}/api/module-clues/naimen-prologue/visibility/arrival`, {
        method: "PUT",
        headers: { authorization: `Bearer ${keeperToken}`, "content-type": "application/json" },
        body: JSON.stringify({ playerId: "pl.cici", playerIds: ["pl.cici"] })
      });
      expect(spoofedIdentity.status).toBe(400);
    });
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

  it("requires the internal token for qq chatbot talk", async () => {
    const fixture = createFixture({
      qqChatbot: {
        internalToken: "internal-token",
        playerMap: { "123456789": "pl.cici" },
        adminQqIds: []
      }
    });
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/internal/qq-chatbot/talk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qqUserId: "123456789", npc: "char.claire", message: "hello" })
      });
      const wrong = await fetch(`${baseUrl}/api/internal/qq-chatbot/talk`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-trpg-internal-token": "wrong" },
        body: JSON.stringify({ qqUserId: "123456789", npc: "char.claire", message: "hello" })
      });

      expect(missing.status).toBe(403);
      expect(wrong.status).toBe(403);
    });
  });

  it("lets mapped qq users talk through the same npc player memory scope", async () => {
    const fixture = createFixture({
      qqChatbot: {
        internalToken: "internal-token",
        playerMap: { "123456789": "pl.cici" },
        adminQqIds: []
      }
    });
    const provider = new FakeProvider(["QQ reply"]);
    await withServer(fixture.config, provider, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/internal/qq-chatbot/talk`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-trpg-internal-token": "internal-token" },
        body: JSON.stringify({ qqUserId: "123456789", npc: "克莱儿", message: "你还记得我吗？" })
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        npcId: "char.claire",
        npcDisplayName: "克莱儿",
        playerId: "pl.cici",
        content: "QQ reply"
      });
      expect(provider.calls).toHaveLength(1);

      const log = await readFile(
        join(fixture.chatMemoryRootDir, "char.claire", "players", "pl.cici", "full_log.log"),
        "utf-8"
      );
      expect(log).toContain("你还记得我吗？");
      expect(log).toContain("QQ reply");
    });
  });

  it("returns safe portrait hints for qq chatbot talk", async () => {
    const fixture = createFixture({
      qqChatbot: {
        internalToken: "internal-token",
        playerMap: { "123456789": "pl.cici" },
        adminQqIds: []
      }
    });
    writeFileSync(
      join(fixture.npcRootDir, "char.claire", "npc.json"),
      JSON.stringify(
        {
          id: "char.claire",
          displayName: "克莱儿",
          role: "NPC",
          tone: "谨慎",
          portraitFiles: ["尴尬.jpg"]
        },
        null,
        2
      )
    );
    const provider = new FakeProvider(["【立绘: 尴尬.jpg】\n我记得。"]);
    await withServer(fixture.config, provider, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/internal/qq-chatbot/talk`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-trpg-internal-token": "internal-token" },
        body: JSON.stringify({ qqUserId: "123456789", npc: "克莱儿", message: "你还记得我吗？" })
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        npcId: "char.claire",
        content: "我记得。",
        portraitFile: "尴尬.jpg"
      });
    });
  });

  it("keeps npc access checks for qq chatbot talk", async () => {
    const fixture = createFixture({
      qqChatbot: {
        internalToken: "internal-token",
        playerMap: { "123456789": "pl.cici" },
        adminQqIds: []
      }
    });
    const provider = new FakeProvider();
    await withServer(fixture.config, provider, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/internal/qq-chatbot/talk`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-trpg-internal-token": "internal-token" },
        body: JSON.stringify({ qqUserId: "123456789", npc: "char.locked", message: "有人吗？" })
      });

      expect(response.status).toBe(403);
      expect(provider.calls).toHaveLength(0);
    });
  });

  it("lets configured qq admins append common and player npc memory", async () => {
    const fixture = createFixture({
      qqChatbot: {
        internalToken: "internal-token",
        playerMap: {},
        adminQqIds: ["123456789"]
      }
    });
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const headers = { "content-type": "application/json", "x-trpg-internal-token": "internal-token" };
      const common = await fetch(`${baseUrl}/api/internal/qq-chatbot/memory`, {
        method: "POST",
        headers,
        body: JSON.stringify({ adminQqUserId: "123456789", npc: "克莱儿", text: "她记得墓园里的钟声。" })
      });
      const player = await fetch(`${baseUrl}/api/internal/qq-chatbot/memory`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          adminQqUserId: "123456789",
          npc: "char.claire",
          player: "Cici",
          text: "她单独记得 Cici 的承诺。"
        })
      });

      expect(common.status).toBe(200);
      expect(await common.json()).toEqual({ ok: true, npcId: "char.claire" });
      expect(player.status).toBe(200);
      expect(await player.json()).toEqual({ ok: true, npcId: "char.claire", playerId: "pl.cici" });
      await expect(readFile(join(fixture.npcRootDir, "char.claire", "common-memory.md"), "utf-8")).resolves.toContain(
        "她记得墓园里的钟声。"
      );
      await expect(
        readFile(join(fixture.npcRootDir, "char.claire", "players", "pl.cici.memory.md"), "utf-8")
      ).resolves.toContain("她单独记得 Cici 的承诺。");
    });
  });

  it("rejects non-admin qq users from appending npc memory", async () => {
    const fixture = createFixture({
      qqChatbot: {
        internalToken: "internal-token",
        playerMap: {},
        adminQqIds: ["123456789"]
      }
    });
    await withServer(fixture.config, new FakeProvider(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/internal/qq-chatbot/memory`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-trpg-internal-token": "internal-token" },
        body: JSON.stringify({ adminQqUserId: "987654321", npc: "克莱儿", text: "不应写入。" })
      });

      expect(response.status).toBe(403);
    });
  });
});
