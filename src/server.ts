import { existsSync, readlinkSync } from "node:fs";
import { readReport, readReportImage } from "./content/report-access.js";
import { ReadingCommunity } from "./reading/community.js";
import { Accounts, reject } from "./auth/accounts.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { authenticateBearerToken, type AuthSession } from "./auth/tokens.js";
import { createOpenAiCompatibleProvider } from "./ai/openai-compatible.js";
import { ContentStore } from "./content/content-store.js";
import type { BlogPostDocument } from "./content/content-types.js";
import {
  appendAnalyticsEvent,
  readAnalyticsSummary,
  validateAnalyticsEventBody
} from "./analytics/analytics-store.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import {
  appendChatTurn,
  compressCurrentContextIfNeeded,
  deleteChatHistory,
  readChatHistory
} from "./memory/chat-memory.js";
import { appendNpcMemory } from "./memory/npc-memory-writer.js";
import {
  listModuleClueSummaries,
  readModuleCluePayload,
  updateModuleClueVisibility,
  validateVisibilityUpdateBody
} from "./memory/module-clue-memory.js";
import { listNpcProfiles, readNpcProfile } from "./memory/npc-memory.js";
import { buildNpcPrompt } from "./prompt/prompt-builder.js";
import { requireQqChatbotInternalToken } from "./qq/qq-chatbot-auth.js";
import { extractQqChatbotPortrait } from "./qq/qq-chatbot-portrait.js";
import { resolveNpcProfileByName, resolvePlayerIdByName, resolveQqPlayerId } from "./qq/qq-chatbot-resolver.js";
import { KeyedSerialQueue } from "./queue/keyed-queue.js";
import type { KnowledgeStore } from "./knowledge/knowledge-store.js";
import { WorkbenchStore } from "./workbench/workbench-store.js";
import type { AiProvider, ChatRequest, ChatResponse } from "./types.js";

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

async function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw Object.assign(new Error("request body is too large"), { statusCode: 413 });
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {}
) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function writeBinary(
  response: ServerResponse,
  statusCode: number,
  payload: Uint8Array,
  headers: Record<string, string> = {}
) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": String(payload.byteLength),
    ...headers
  });
  response.end(Buffer.from(payload));
}

function buildCorsHeaders(request: IncomingMessage, allowedOrigin: string): Record<string, string> {
  const origin = request.headers.origin;
  const allowedOrigins = allowedOrigin
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (origin && allowedOrigins.includes(origin)) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, authorization"
    };
  }
  return {};
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clientIp(request: IncomingMessage): string | undefined {
  const realIp = firstHeaderValue(request.headers["x-real-ip"]);
  if (realIp) return realIp;
  const forwardedFor = firstHeaderValue(request.headers["x-forwarded-for"]);
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim();
  return request.socket.remoteAddress;
}

function validateChatRequest(value: unknown): ChatRequest {
  const candidate = value as Partial<ChatRequest>;
  if (!candidate || typeof candidate !== "object") throw new Error("request body must be JSON");
  if (typeof candidate.playerId === "string") throw new Error("playerId is not allowed");
  if (!candidate.npcId || typeof candidate.npcId !== "string") {
    throw new Error("npcId is required");
  }
  if (!candidate.message || typeof candidate.message !== "string") {
    throw new Error("message is required");
  }

  return {
    npcId: candidate.npcId,
    message: candidate.message,
    temperature: typeof candidate.temperature === "number" ? candidate.temperature : undefined
  };
}

function validateNpcIdBody(value: unknown): { npcId: string } {
  const candidate = value as { npcId?: unknown };
  if (!candidate || typeof candidate !== "object") throw new Error("request body must be JSON");
  if (!candidate.npcId || typeof candidate.npcId !== "string") {
    throw new Error("npcId is required");
  }
  return { npcId: candidate.npcId };
}

function validateQqChatbotTalkBody(value: unknown): {
  qqUserId: string;
  npc: string;
  message: string;
} {
  const candidate = value as { qqUserId?: unknown; npc?: unknown; message?: unknown };
  if (!candidate || typeof candidate !== "object") throw new Error("request body must be JSON");
  if (!candidate.qqUserId || typeof candidate.qqUserId !== "string") {
    throw new Error("qqUserId is required");
  }
  if (!candidate.npc || typeof candidate.npc !== "string") {
    throw new Error("npc is required");
  }
  if (!candidate.message || typeof candidate.message !== "string") {
    throw new Error("message is required");
  }
  return {
    qqUserId: candidate.qqUserId,
    npc: candidate.npc,
    message: candidate.message
  };
}

function validateQqChatbotMemoryBody(value: unknown): {
  adminQqUserId: string;
  npc: string;
  text: string;
  player?: string;
} {
  const candidate = value as { adminQqUserId?: unknown; npc?: unknown; text?: unknown; player?: unknown };
  if (!candidate || typeof candidate !== "object") throw new Error("request body must be JSON");
  if (!candidate.adminQqUserId || typeof candidate.adminQqUserId !== "string") {
    throw new Error("adminQqUserId is required");
  }
  if (!candidate.npc || typeof candidate.npc !== "string") {
    throw new Error("npc is required");
  }
  if (!candidate.text || typeof candidate.text !== "string") {
    throw new Error("text is required");
  }
  if (candidate.player !== undefined && typeof candidate.player !== "string") {
    throw new Error("player must be a string");
  }
  return {
    adminQqUserId: candidate.adminQqUserId,
    npc: candidate.npc,
    text: candidate.text,
    player: candidate.player
  };
}

function legacySession(request: IncomingMessage, config: RuntimeConfig): AuthSession | undefined {
  return authenticateBearerToken(
    request.headers.authorization,
    config.tokenHashRecords,
    config.tokenHashPepper,
    config.supportedPlayerIds
  );
}

function requirePlayerSession(session: AuthSession): void {
  if (session.isKeeper) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
}

function requireKeeperSession(session: AuthSession): void {
  if (!session.isKeeper) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
}

function canAccessNpc(session: AuthSession, supportedPlayerIds: string[] | undefined): boolean {
  return session.isKeeper || !supportedPlayerIds || supportedPlayerIds.includes(session.playerId);
}

function qqChatbotPortraitSystemSuffix(portraitFiles: string[] | undefined): string {
  if (!portraitFiles?.length) {
    return "QQ 回复可选第一行格式：如果需要指定差分立绘，只能从 NPC 配置允许的文件名中选择，并把第一行写成【立绘: 文件名】；正文从下一行开始。";
  }

  return [
    `可用差分立绘文件名：${portraitFiles.join(", ")}`,
    "QQ 回复第一行可选格式：【立绘: 文件名】；正文从下一行开始。",
    "只要当前回复的情绪、语气或场景大致匹配，就尽量选择一张最贴近的差分立绘。",
    "只有在没有任何文件名符合当前情绪或场景时，才不要输出立绘标记。",
    "文件名必须精确使用上方列表中的一个，不能编造、改写或添加路径。"
  ].join("\n");
}

async function requireNpcAccess(config: RuntimeConfig, session: AuthSession, npcId: string): Promise<void> {
  const profile = await readNpcProfile(config.npcRootDir, npcId);
  if (!canAccessNpc(session, profile.supportedPlayerIds)) {
    throw Object.assign(new Error("forbidden"), { statusCode: 403 });
  }
}

function queueKey(npcId: string, playerId: string): string {
  return `${npcId}\0${playerId}`;
}

function decodeRouteSegment(value: string): string {
  return decodeURIComponent(value);
}

function playerDirectory(config: RuntimeConfig) {
  const supportedPlayerIds = new Set(config.supportedPlayerIds);
  return config.tokenHashRecords
    .filter((record) => !record.isKeeper && supportedPlayerIds.has(record.playerId))
    .map((record) => ({ id: record.playerId, name: record.displayName }));
}

function playerSessionFromId(config: RuntimeConfig, playerId: string): AuthSession {
  const supported = new Set(config.supportedPlayerIds);
  const record = config.tokenHashRecords.find((item) => !item.isKeeper && item.playerId === playerId);
  if (!record || !supported.has(record.playerId)) {
    throw Object.assign(new Error("forbidden"), { statusCode: 403 });
  }
  return {
    playerId: record.playerId,
    displayName: record.displayName,
    isKeeper: false
  };
}

export interface CreateAppOptions {
  provider?: AiProvider;
  now?: () => Date;
  contentStore?: ContentStore;
  workbenchStore?: WorkbenchStore;
}

export function createApp(config: RuntimeConfig = loadRuntimeConfig(), options: CreateAppOptions = {}) {
  const provider = options.provider ?? createOpenAiCompatibleProvider(config.ai);
  const now = options.now ?? (() => new Date());
  const contentStore =
    options.contentStore ??
    new ContentStore({
      contentRootDir: config.contentRootDir,
      uploadRootDir: config.contentUploadRootDir,
      publicUploadBaseUrl: config.contentUploadBaseUrl,
      maxUploadBytes: config.contentMaxUploadBytes,
      maxImportBytes: config.contentMaxImportBytes,
      trashRootDir: config.contentTrashRootDir
    });
  const queue = new KeyedSerialQueue();
  const contentQueue = new KeyedSerialQueue();
  const workbenchStore = options.workbenchStore ?? new WorkbenchStore(config.workbenchRootDir, config.tokenHashPepper);
  const workbenchQueue = new KeyedSerialQueue();
  let music: Promise<import("./music/music-library.js").MusicLibrary> | undefined;
  function musicLibrary() {
    music ??= import("./music/music-library.js").then(({ MusicLibrary }) =>
      new MusicLibrary(join(config.workbenchRootDir, "music"))).catch(() => {
      music = undefined;
      throw Object.assign(new Error("公开曲库暂不可用。"), { statusCode: 503 });
    });
    return music;
  }
  let knowledge: Promise<KnowledgeStore> | undefined;

  // 在第一次有需要的请求中加载数据库。并发请求共用初始化结果，出错后允许下次重试。
  async function getKnowledgeStore() {
    const root = config.knowledgeRootDir;
    if (!root) return undefined;
    knowledge ??= import("./knowledge/knowledge-store.js").then(({ KnowledgeStore }) => new KnowledgeStore(root)).catch((error: unknown) => {
      knowledge = undefined;
      console.error("Knowledge database initialization failed", error instanceof Error ? error.name : "error");
      throw Object.assign(new Error("知识库存储暂时不可用。"), { statusCode: 503 });
    });
    return knowledge;
  }


  async function runNpcChat(
    npcId: string,
    playerId: string,
    message: string,
    temperature?: number,
    options: { systemSuffix?: string; transformAssistantContent?: (content: string) => string } = {}
  ): Promise<ChatResponse> {
    await compressCurrentContextIfNeeded(
      config.chatMemoryRootDir,
      npcId,
      playerId,
      provider
    );
    const providerRequest = await buildNpcPrompt({
      npcId,
      playerId,
      userMessage: message,
      wikiEntriesDir: config.wikiEntriesDir,
      npcRootDir: config.npcRootDir,
      chatMemoryRootDir: config.chatMemoryRootDir
    });
    const chatResult = await provider.chat({
      messages: options.systemSuffix
        ? providerRequest.messages.map((item, index) =>
            index === 0 && item.role === "system"
              ? { ...item, content: `${item.content}\n\n${options.systemSuffix}` }
              : item
          )
        : providerRequest.messages,
      temperature
    });
    const assistantContent = options.transformAssistantContent?.(chatResult.content) ?? chatResult.content;
    await appendChatTurn(
      config.chatMemoryRootDir,
      npcId,
      playerId,
      message,
      assistantContent,
      now()
    );
    return { content: assistantContent };
  }

  let opening: Promise<Accounts> | undefined;
  let accounts: Accounts | undefined;
  let reading: ReadingCommunity | undefined;
  const accountStore = () =>
    (opening ??= Accounts.open(config)
      .then((db) => (accounts = db))
      .catch((error) => {
        opening = undefined;
        throw error;
      }));
  const sessionKey = (req: IncomingMessage) =>
    /(?:^|; *)__Host-issane=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie || "",
    )?.[1];
  const authenticate = (
    req: IncomingMessage,
    cfg: RuntimeConfig,
  ): AuthSession | undefined => {
    const key = sessionKey(req);
    if (key) {
      const user = accounts?.current(key);
      if (user)
        return {
          playerId: String(user.playerId),
          displayName: String(user.displayName),
          isKeeper: user.role === "admin",
        };
    }
    if (key || req.headers.authorization === "Bearer site-session")
      return undefined;
    const legacy = legacySession(req, cfg);
    if (legacy && !legacy.isKeeper && accounts) return undefined;
    return legacy;
  };
  const activePlayers = () =>
    accounts
      ? accounts
          .list()
          .filter((row) => row.role !== "admin")
          .map((row) => ({ id: String(row.id), name: String(row.nickname) }))
      : playerDirectory(config);
  const attempts = new Map<string, { n: number; until: number }>();
  const server = createServer(async (request, response) => {
    const corsHeaders = buildCorsHeaders(request, config.allowedOrigin);

    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      const rawPath = (request.url ?? "/").split(/[?#]/)[0];

      if (
        sessionKey(request) ||
        url.pathname.startsWith("/api/account") ||
        ((request.headers.authorization ||
          url.pathname.startsWith("/api/internal/")) &&
          existsSync(join(config.workbenchRootDir, "accounts/accounts.sqlite")))
      )
        await accountStore();
      if (
        (sessionKey(request) &&
          !["GET", "HEAD", "OPTIONS"].includes(request.method || "")) ||
        (url.pathname.startsWith("/api/account") && request.method !== "GET")
      ) {
        const origin = request.headers.origin;
        if (
          origin &&
          !config.allowedOrigin
            .split(",")
            .map((s) => s.trim())
            .includes(origin)
        )
          reject(403, "来源未授权");
        if (request.headers["sec-fetch-site"] === "cross-site")
          reject(403, "来源未授权");
      }
      if (
        url.pathname.startsWith("/api/account") &&
        request.method !== "OPTIONS"
      ) {
        const db = await accountStore();
        const action = url.pathname.slice("/api/account".length);
        const method = request.method;
        const key = sessionKey(request) || "";
        const user = db.current(key);
        const json = async () => {
          if (
            request.headers["content-type"]?.split(";")[0] !==
            "application/json"
          )
            reject(415, "需要 JSON");
          const obj = JSON.parse(
            Buffer.from(await readBoundedBody(request, 400000)).toString(),
          );
          if (!obj || typeof obj !== "object" || Array.isArray(obj))
            reject(400, "无效的数据");
          return obj;
        };
        const cookie = (value: string, age: number) =>
          response.setHeader(
            "Set-Cookie",
            "__Host-issane=" +
              value +
              "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=" +
              age,
          );
        let result: unknown = { ok: true };
        if (action === "/login" && method === "POST") {
          const input = await json();
          const nowMs = Date.now();
          const ip = clientIp(request) || "local";
          for (const [addr, limit] of attempts)
            if (limit.until <= nowMs) attempts.delete(addr);
          const limit = attempts.get(ip) || { n: 0, until: nowMs + 60000 };
          if (++limit.n > 30) reject(429, "请稍后重试");
          attempts.set(ip, limit);
          cookie(await db.login(input.id, input.password), 604800);
        } else if (action === "/setup" && method === "POST") {
          const keeper = legacySession(request, config);
          if (!keeper?.isKeeper) reject(403, "需要原 KP 凭据");
          const input = await json();
          await db.create(
            keeper.playerId,
            keeper.displayName,
            input.password,
            "admin",
          );
          cookie(await db.login(keeper.playerId, input.password), 604800);
        } else if (action === "/logout" && method === "POST") {
          db.logout(key);
          cookie("", 0);
        } else {
          if (!user) reject(401, "请登录");
          const id = String(user.playerId);
          if (action === "/me" && method === "GET") result = db.profile(id);
          else if (action === "/me" && method === "PUT")
            await db.edit(id, await json());
          else {
            if (user.role !== "admin") reject(403, "需要管理员");
            if (action === "/keeper" && method === "GET") result = { ok: true };
            else if (action === "/users" && method === "GET")
              result = db.list();
            else if (action === "/users" && method === "POST") {
              const input = await json();
              if (
                config.tokenHashRecords.some(
                  (r) =>
                    r.isKeeper &&
                    r.playerId.toLowerCase() ===
                      String(input.id).trim().toLowerCase(),
                )
              )
                reject(409, "管理员 ID 已保留");
              result = await db.create(
                input.id,
                input.nickname,
                input.password,
              );
            } else if (action.startsWith("/users/") && method === "DELETE")
              db.remove(decodeURIComponent(action.slice(7)));
            else reject(404, "接口不存在");
          }
        }
        writeJson(response, 200, result, corsHeaders);
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders);
        response.end();
        return;
      }

      if (
        request.method === "GET" &&
        (url.pathname.startsWith("/wiki/entities/entries/report.") ||
          url.pathname.startsWith("/blog/images/report-"))
      ) {
        const activeSource = "/etc/nginx/snippets/trpg-content-active.conf";
        const release =
          existsSync(activeSource) &&
          readlinkSync(activeSource).split("/").pop() ===
            "trpg-content-release.conf";
        const root = release
          ? "/var/www/trpg-helper/current"
          : config.contentRootDir;
        const session = authenticate(request, config);
        if (url.pathname.startsWith("/wiki/")) {
          writeJson(
            response,
            200,
            await readReport(
              root,
              url.pathname.slice("/wiki/entities/entries/".length),
              session,
            ),
            corsHeaders,
          );
        } else {
          const image = await readReportImage(root, url.pathname, session);
          const extension = url.pathname.split(".").pop()?.toLowerCase();
          writeBinary(response, 200, image, {
            "content-type":
              "image/" + (extension === "jpg" ? "jpeg" : extension),
            "x-content-type-options": "nosniff",
          });
        }
        return;
      }

      if (url.pathname.startsWith("/api/reading/")) {
        const store = await accountStore();
        const user = store.current(sessionKey(request) || "");
        if (!user) reject(401, "请先登录");
        reading ??= new ReadingCommunity(store.db);
        const method = request.method || "GET";
        const data = method === "POST" || method === "PUT"
          ? JSON.parse(Buffer.from(await readBoundedBody(request, 32768)).toString("utf8")) : {};
        if (!data || typeof data !== "object" || Array.isArray(data)) reject(400, "需要 JSON 对象");
        const result = reading.route(url.pathname.slice("/api/reading".length), method, url.searchParams, String(user.playerId), user.role === "admin", data);
        writeJson(response, 200, result, corsHeaders);
        return;
      }
      const musicPath = /^\/api\/music\/songs(?:\/(\d{1,15}))?$/.exec(url.pathname);
      if (musicPath && request.method === "GET") {
        const library = await musicLibrary();
        const data = musicPath[1] ? library.read(Number(musicPath[1])) :
          library.list(Number(url.searchParams.get("before") || Number.MAX_SAFE_INTEGER));
        writeJson(response, data ? 200 : 404, data ?? { error: "曲目不存在。" }, corsHeaders);
        return;
      }
      if (url.pathname === "/api/music/songs" && request.method === "POST") {
        const session = authenticate(request, config);
        if (!session) { writeJson(response, 401, { error: "请先登录。" }, corsHeaders); return; }
        const bytes = await readBoundedBody(request, 512 * 1024);
        let score: unknown;
        try { score = JSON.parse(Buffer.from(bytes).toString("utf8")); }
        catch { throw Object.assign(new Error("曲谱 JSON 无效。"), { statusCode: 400 }); }
        writeJson(response, 200, (await musicLibrary()).save(session.playerId, score), corsHeaders);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/portfolio") {
        const data = await workbenchQueue.run("workbench", () => workbenchStore.read());
        const summaries = data.works.filter((work) => work.status === "published").map(({ body, ...summary }) => summary);
        // 同一作品集展示原工作台作品与知识库公开快照。知识库暂时不可用时仍可列出原有作品。
        const publications = await getKnowledgeStore().then((store) => store?.listPublications() ?? []).catch(() => []);
        writeJson(response, 200, [...summaries, ...publications], corsHeaders);
        return;
      }

      const publicWorkMatch = rawPath.match(/^\/api\/portfolio\/([a-zA-Z0-9_-]+)$/);
      if (request.method === "GET" && publicWorkMatch) {
        // kb- 开头的链接读取公开快照。游客直接访问这个入口即可阅读。
        if (/^kb-[a-f0-9]{32}$/.test(publicWorkMatch[1])) {
          const publication = await getKnowledgeStore().then((store) => store?.getPublication(publicWorkMatch[1].slice(3))).catch(() => undefined);
          if (publication) {
            writeJson(response, 200, publication, corsHeaders);
            return;
          }
        }
        const data = await workbenchQueue.run("workbench", () => workbenchStore.read());
        const work = data.works.find((item) => item.id === publicWorkMatch[1] && item.status === "published");
        writeJson(response, work ? 200 : 404, work ?? { error: "not_found" }, corsHeaders);
        return;
      }

      if (url.pathname === "/api/knowledge" || url.pathname.startsWith("/api/knowledge/")) {
        const authorization = request.headers.authorization;
        if (!authorization && !sessionKey(request)) { writeJson(response, 401, { error: "需要知识库凭据。" }, corsHeaders); return; }
        // 维护者沿用站点 KP 身份。rag_ 凭据交给世界观接口核对权限，保持独立的授权范围。
        const isAgentToken = /^Bearer rag_[a-f0-9]{64}$/i.test(authorization ?? "");
        const keeper = !isAgentToken && authenticate(request, config)?.isKeeper === true;
        if (!keeper && !isAgentToken) {
          writeJson(response, 403, { error: "需要维护者权限。" }, corsHeaders);
          return;
        }
        const store = await getKnowledgeStore();
        if (!store) { writeJson(response, 503, { error: "此环境尚未启用知识库存储。" }, corsHeaders); return; }
        const { routeKnowledge } = await import("./knowledge/knowledge-routes.js");
        try {
          await routeKnowledge({
            store, request, pathname: url.pathname, keeper,
            json: async () => {
              // 先限制收到的字节数，再解析 JSON，避免把超大请求读进服务器内存。
              const importLimit = 8 * 1024 * 1024 + 1024;
              const limit = url.pathname === "/api/knowledge/worlds/import" ? importLimit : 1024 * 1024;
              const bytes = await readBoundedBody(request, limit);
              try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
              catch { throw Object.assign(new Error("请求须包含有效 JSON。"), { statusCode: 400 }); }
            },
            send: (status, data) => writeJson(response, status, data, corsHeaders)
          });
        } catch (error) {
          // 校验失败可以把原因告诉用户。存储故障只返回通用提示，具体错误类别记入服务日志。
          if (error instanceof Error && "statusCode" in error) {
            writeJson(response, Number(error.statusCode), { error: error.message }, corsHeaders);
          } else {
            console.error("Knowledge API failed", error instanceof Error ? error.name : "error");
            writeJson(response, 503, { error: "知识库存储暂时不可用，请稍后重试。" }, corsHeaders);
          }
        }
        return;
      }

      if (url.pathname === "/api/admin/reader-books" || url.pathname.startsWith("/api/admin/reader-books/")) {
        const session = authenticate(request, config);
        if (!session) { writeJson(response, 401, { error: "unauthorized" }, corsHeaders); return; }
        requireKeeperSession(session);
        if (request.method !== "GET") { writeJson(response, 405, { error: "method_not_allowed" }, corsHeaders); return; }
        const root = join(config.workbenchRootDir, "reader-books");
        try {
          if (url.pathname === "/api/admin/reader-books") {
            const dirs = await readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
              if (err.code === "ENOENT") return [];
              throw err;
            });
            const books = await Promise.all(dirs.filter(dir => dir.isDirectory() && /^[a-f0-9]{64}$/.test(dir.name))
              .map(async dir => JSON.parse(await readFile(join(root, dir.name, "book.json"), "utf8"))));
            writeJson(response, 200, books, corsHeaders);
          } else {
            const id = url.pathname.slice("/api/admin/reader-books/".length);
            if (!/^[a-f0-9]{64}$/.test(id)) { writeJson(response, 404, { error: "not_found" }, corsHeaders); return; }
            const bytes = await readFile(join(root, id, "body.bin"));
            response.writeHead(200, { ...corsHeaders, "content-type": "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
            response.end(bytes);
          }
        } catch (err) {
          const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
          writeJson(response, missing ? 404 : 500, { error: missing ? "not_found" : "library_unavailable" }, corsHeaders);
        }
        return;
      }

      if (url.pathname === "/api/admin/workbench") {
        const session = authenticate(request, config);
        if (!session) { writeJson(response, 401, { error: "unauthorized" }, corsHeaders); return; }
        requireKeeperSession(session);
        if (request.method === "GET") {
          writeJson(response, 200, await workbenchQueue.run("workbench", () => workbenchStore.read()), corsHeaders);
          return;
        }
        if (request.method === "PUT") {
          const bytes = await readBoundedBody(request, 2 * 1024 * 1024);
          const input = JSON.parse(Buffer.from(bytes).toString("utf8"));
          writeJson(response, 200, await workbenchQueue.run("workbench", () => workbenchStore.write(input)), corsHeaders);
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { ok: true }, corsHeaders);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session") {
        const session = authenticate(request, config);
        if (!session) {
          writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
          return;
        }
        writeJson(response, 200, session, corsHeaders);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/internal/qq-chatbot/talk") {
        requireQqChatbotInternalToken(request, config);
        const body = validateQqChatbotTalkBody(await readJsonBody(request));
        const playerId = resolveQqPlayerId(config.qqChatbot, body.qqUserId);
        if (accounts?.isDeleted(playerId)) reject(403, "账号已删除");
        const session = playerSessionFromId(config, playerId);
        const profile = await resolveNpcProfileByName(config.npcRootDir, body.npc);
        if (!canAccessNpc(session, profile.supportedPlayerIds)) {
          writeJson(response, 403, { error: "forbidden" }, corsHeaders);
          return;
        }
        let portraitFile: string | undefined;
        const result = await queue.run(queueKey(profile.id, playerId), () =>
          runNpcChat(profile.id, playerId, body.message, undefined, {
            systemSuffix: qqChatbotPortraitSystemSuffix(profile.portraitFiles),
            transformAssistantContent: (content) => {
              const parsed = extractQqChatbotPortrait(content, profile.portraitFiles);
              portraitFile = parsed.portraitFile;
              return parsed.content;
            }
          })
        );
        writeJson(
          response,
          200,
          {
            npcId: profile.id,
            npcDisplayName: profile.displayName,
            playerId,
            content: result.content,
            ...(portraitFile ? { portraitFile } : {})
          },
          corsHeaders
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/internal/qq-chatbot/memory") {
        requireQqChatbotInternalToken(request, config);
        const body = validateQqChatbotMemoryBody(await readJsonBody(request));
        if (!config.qqChatbot.adminQqIds.includes(body.adminQqUserId)) {
          writeJson(response, 403, { error: "forbidden" }, corsHeaders);
          return;
        }
        const profile = await resolveNpcProfileByName(config.npcRootDir, body.npc);
        const playerId = body.player ? resolvePlayerIdByName(config.tokenHashRecords, body.player) : undefined;
        await queue.run(`npc-memory:${profile.id}`, () =>
          appendNpcMemory({
            npcRootDir: config.npcRootDir,
            npcId: profile.id,
            playerId,
            text: body.text,
            now: now()
          })
        );
        writeJson(
          response,
          200,
          {
            ok: true,
            npcId: profile.id,
            ...(playerId ? { playerId } : {})
          },
          corsHeaders
        );
        return;
      }

      if (url.pathname.startsWith("/api/admin/content")) {
        const session = authenticate(request, config);
        if (!session) {
          writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
          return;
        }
        requireKeeperSession(session);

        if (request.method === "GET" && url.pathname === "/api/admin/content/overview") {
          const overview = await contentQueue.run("content", () => contentStore.getOverview());
          if (accounts) overview.players = activePlayers().map(({ id, name }) => ({ id, displayName: name }));
          writeJson(response, 200, overview, corsHeaders);
          return;
        }

        const blogMatch = rawPath.match(/^\/api\/admin\/content\/blog\/([^/]+)$/);
        if (blogMatch) {
          const id = decodeRouteSegment(blogMatch[1]);
          if (request.method === "GET") {
            writeJson(response, 200, await contentQueue.run("content", () => contentStore.readBlog(id)), corsHeaders);
            return;
          }
          if (request.method === "PUT") {
            const body = (await readJsonBody(request)) as BlogPostDocument;
            if (body.id !== id) throw new Error("博客 id 与路由不一致");
            writeJson(response, 200, await contentQueue.run("content", () => contentStore.saveBlog(body)), corsHeaders);
            return;
          }
          if (request.method === "DELETE") {
            writeJson(response, 200, await contentQueue.run("content", () => contentStore.deleteBlog(id)), corsHeaders);
            return;
          }
        }

        const wikiMatch = rawPath.match(/^\/api\/admin\/content\/wiki\/([^/]+)$/);
        if (wikiMatch) {
          const id = decodeRouteSegment(wikiMatch[1]);
          if (request.method === "GET") {
            writeJson(response, 200, await contentQueue.run("content", () => contentStore.readWiki(id)), corsHeaders);
            return;
          }
          if (request.method === "PUT") {
            const body = await readJsonBody(request);
            if (!body || typeof body !== "object" || (body as { id?: unknown }).id !== id) {
              throw new Error("Wiki id 与路由不一致");
            }
            writeJson(response, 200, await contentQueue.run("content", () => contentStore.saveWiki(body)), corsHeaders);
            return;
          }
          if (request.method === "DELETE") {
            writeJson(response, 200, await contentQueue.run("content", () => contentStore.deleteWiki(id)), corsHeaders);
            return;
          }
        }

        if (request.method === "POST" && url.pathname === "/api/admin/content/images") {
          const fileName = url.searchParams.get("fileName");
          if (!fileName) throw new Error("fileName is required");
          const mimeType = firstHeaderValue(request.headers["content-type"]);
          if (!mimeType) throw new Error("content-type is required");
          const bytes = await readBoundedBody(request, config.contentMaxUploadBytes);
          const result = await contentQueue.run("content", () =>
            contentStore.saveImage({
              report: url.searchParams.get("scope") === "report",
              fileName,
              mimeType: mimeType.split(";")[0].trim().toLowerCase(),
              bytes
            })
          );
          writeJson(
            response,
            201,
            { url: result.url, size: result.size, mimeType: result.mimeType },
            corsHeaders
          );
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/admin/content/export") {
          writeBinary(response, 200, await contentQueue.run("content", () => contentStore.exportZip()), {
            ...corsHeaders,
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="trpg-content-${now().toISOString().slice(0, 10)}.zip"`
          });
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/admin/content/import") {
          const archive = await readBoundedBody(request, config.contentMaxImportBytes);
          writeJson(response, 200, await contentQueue.run("content", () => contentStore.importZip(archive)), corsHeaders);
          return;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/analytics/events") {
        const receivedAt = now();
        const session = authenticate(request, config);
        const event = validateAnalyticsEventBody(await readJsonBody(request), receivedAt);
        await appendAnalyticsEvent(config.analyticsRootDir, event, {
          session,
          now: receivedAt,
          ip: clientIp(request),
          userAgent: firstHeaderValue(request.headers["user-agent"]),
          maxEvents: config.analyticsMaxEvents
        });
        writeJson(response, 202, { ok: true }, corsHeaders);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/analytics/summary") {
        const session = authenticate(request, config);
        if (!session) {
          writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
          return;
        }
        requireKeeperSession(session);
        writeJson(response, 200, await readAnalyticsSummary(config.analyticsRootDir), corsHeaders);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/npcs") {
        const session = authenticate(request, config);
        if (!session) {
          writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
          return;
        }
        const profiles = await listNpcProfiles(config.npcRootDir);
        const visibleProfiles = profiles.filter((profile) =>
          canAccessNpc(session, profile.supportedPlayerIds)
        );
        writeJson(
          response,
          200,
          {
            npcs: visibleProfiles.map((profile) => ({
              id: profile.id,
              displayName: profile.displayName,
              avatarUrl: profile.avatarUrl,
              summary: profile.summary,
              role: profile.role,
              tone: profile.tone
            }))
          },
          corsHeaders
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/module-clues") {
        const session = authenticate(request, config);
        if (!session) {
          writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
          return;
        }
        const modules = await listModuleClueSummaries(
          config.moduleClueContentRootDir,
          config.moduleClueVisibilityRootDir,
          activePlayers().map(player => player.id),
          session
        );
        writeJson(response, 200, { modules }, corsHeaders);
        return;
      }

      const moduleClueMatch = rawPath.match(/^\/api\/module-clues\/([^/]+)$/);
      if (request.method === "GET" && moduleClueMatch) {
        const session = authenticate(request, config);
        if (!session) {
          writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
          return;
        }
        const payload = await readModuleCluePayload(
          config.moduleClueContentRootDir,
          config.moduleClueVisibilityRootDir,
          decodeRouteSegment(moduleClueMatch[1]),
          session,
          activePlayers().map(player => player.id),
          activePlayers()
        );
        writeJson(response, 200, payload, corsHeaders);
        return;
      }

      const moduleClueVisibilityMatch = rawPath.match(
        /^\/api\/module-clues\/([^/]+)\/visibility\/([^/]+)$/
      );
      if (request.method === "PUT" && moduleClueVisibilityMatch) {
        const session = authenticate(request, config);
        if (!session) {
          writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
          return;
        }
        requireKeeperSession(session);
        const { playerIds } = validateVisibilityUpdateBody(
          await readJsonBody(request),
          activePlayers().map(player => player.id)
        );
        await updateModuleClueVisibility(
          config.moduleClueContentRootDir,
          config.moduleClueVisibilityRootDir,
          decodeRouteSegment(moduleClueVisibilityMatch[1]),
          decodeRouteSegment(moduleClueVisibilityMatch[2]),
          playerIds
        );
        writeJson(response, 200, { ok: true }, corsHeaders);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/chat/history") {
        const session = authenticate(request, config);
        if (!session) {
          writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
          return;
        }
        if (!sessionKey(request)) requirePlayerSession(session);
        const npcId = url.searchParams.get("npcId");
        if (!npcId) throw new Error("npcId is required");
        await requireNpcAccess(config, session, npcId);
        const parsedLimit = Number(url.searchParams.get("limit") ?? "100");
        const messages = await readChatHistory(
          config.chatMemoryRootDir,
          npcId,
          session.playerId,
          Number.isFinite(parsedLimit) ? parsedLimit : 100
        );
        writeJson(response, 200, { messages }, corsHeaders);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat") {
        const session = authenticate(request, config);
        if (!session) {
          writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
          return;
        }
        if (!sessionKey(request)) requirePlayerSession(session);
        const chatRequest = validateChatRequest(await readJsonBody(request));
        await requireNpcAccess(config, session, chatRequest.npcId!);
        const result = await queue.run(queueKey(chatRequest.npcId!, session.playerId), () =>
          runNpcChat(chatRequest.npcId!, session.playerId, chatRequest.message, chatRequest.temperature)
        );
        writeJson(response, 200, result, corsHeaders);
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/chat/history") {
        const session = authenticate(request, config);
        if (!session) {
          writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
          return;
        }
        if (!sessionKey(request)) requirePlayerSession(session);
        const { npcId } = validateNpcIdBody(await readJsonBody(request));
        await requireNpcAccess(config, session, npcId);
        const result = await queue.run(queueKey(npcId, session.playerId), () =>
          deleteChatHistory(config.chatMemoryRootDir, npcId, session.playerId, now())
        );
        writeJson(response, 200, { ok: true, ...result }, corsHeaders);
        return;
      }

      writeJson(response, 404, { error: "not_found" }, corsHeaders);
    } catch (error) {
      const statusCode =
        error instanceof Error && "statusCode" in error
          ? Number((error as Error & { statusCode: number }).statusCode)
          : 400;
      writeJson(
        response,
        statusCode,
        {
          error:
            statusCode === 403
              ? "forbidden"
              : error instanceof Error
                ? error.message
                : "unknown error"
        },
        corsHeaders
      );
    }
  });
  // HTTP 服务关闭时释放知识库的目录连接，测试也可以关闭后重新打开原数据目录。
  server.once("close", () => {
    void opening?.then(store => store.db.close()).catch(() => {});
    void music?.then(store => store.close()).catch(() => {});
    void knowledge?.then((store) => { store.close(); }).catch(() => {});
  });
  return server;
}

if (process.env.NODE_ENV !== "test") {
  const config = loadRuntimeConfig();
  createApp(config).listen(config.port, "127.0.0.1", () => {
    console.log(`trpg-ai-gateway listening on 127.0.0.1:${config.port}`);
  });
}
