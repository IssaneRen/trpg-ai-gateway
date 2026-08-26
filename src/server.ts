import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

function authenticate(request: IncomingMessage, config: RuntimeConfig): AuthSession | undefined {
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
      maxImportBytes: config.contentMaxImportBytes
    });
  const queue = new KeyedSerialQueue();
  const contentQueue = new KeyedSerialQueue();

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

  return createServer(async (request, response) => {
    const corsHeaders = buildCorsHeaders(request, config.allowedOrigin);

    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const rawPath = (request.url ?? "/").split(/[?#]/)[0];

      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders);
        response.end();
        return;
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
        const session = playerSessionFromId(config, playerId);
        const profile = await resolveNpcProfileByName(config.npcRootDir, body.npc);
        if (!canAccessNpc(session, profile.supportedPlayerIds)) {
          writeJson(response, 403, { error: "forbidden" }, corsHeaders);
          return;
        }
        let portraitFile: string | undefined;
        const result = await queue.run(queueKey(profile.id, playerId), () =>
          runNpcChat(profile.id, playerId, body.message, undefined, {
            systemSuffix:
              "QQ 回复可选第一行格式：如果需要指定差分立绘，只能从 NPC 配置允许的文件名中选择，并把第一行写成【立绘: 文件名】；正文从下一行开始。",
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
          writeJson(response, 200, await contentQueue.run("content", () => contentStore.getOverview()), corsHeaders);
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
        }

        if (request.method === "POST" && url.pathname === "/api/admin/content/images") {
          const fileName = url.searchParams.get("fileName");
          if (!fileName) throw new Error("fileName is required");
          const mimeType = firstHeaderValue(request.headers["content-type"]);
          if (!mimeType) throw new Error("content-type is required");
          const bytes = await readBoundedBody(request, config.contentMaxUploadBytes);
          const result = await contentQueue.run("content", () =>
            contentStore.saveImage({
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
          config.supportedPlayerIds,
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
          config.supportedPlayerIds,
          playerDirectory(config)
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
          config.supportedPlayerIds
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
        requirePlayerSession(session);
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
        requirePlayerSession(session);
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
        requirePlayerSession(session);
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
}

if (process.env.NODE_ENV !== "test") {
  const config = loadRuntimeConfig();
  createApp(config).listen(config.port, "127.0.0.1", () => {
    console.log(`trpg-ai-gateway listening on 127.0.0.1:${config.port}`);
  });
}
