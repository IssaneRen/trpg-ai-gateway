import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { authenticateBearerToken, type AuthSession } from "./auth/tokens.js";
import { createOpenAiCompatibleProvider } from "./ai/openai-compatible.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import {
  appendChatTurn,
  compressCurrentContextIfNeeded,
  deleteChatHistory,
  readChatHistory
} from "./memory/chat-memory.js";
import {
  listModuleClueSummaries,
  readModuleCluePayload,
  updateModuleClueVisibility,
  validateVisibilityUpdateBody
} from "./memory/module-clue-memory.js";
import { listNpcProfiles, readNpcProfile } from "./memory/npc-memory.js";
import { buildNpcPrompt } from "./prompt/prompt-builder.js";
import { KeyedSerialQueue } from "./queue/keyed-queue.js";
import type { AiProvider, ChatRequest } from "./types.js";

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
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

export interface CreateAppOptions {
  provider?: AiProvider;
  now?: () => Date;
}

export function createApp(config: RuntimeConfig = loadRuntimeConfig(), options: CreateAppOptions = {}) {
  const provider = options.provider ?? createOpenAiCompatibleProvider(config.ai);
  const now = options.now ?? (() => new Date());
  const queue = new KeyedSerialQueue();

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
        const result = await queue.run(queueKey(chatRequest.npcId!, session.playerId), async () => {
          await compressCurrentContextIfNeeded(
            config.chatMemoryRootDir,
            chatRequest.npcId!,
            session.playerId,
            provider
          );
          const providerRequest = await buildNpcPrompt({
            npcId: chatRequest.npcId!,
            playerId: session.playerId,
            userMessage: chatRequest.message,
            wikiEntriesDir: config.wikiEntriesDir,
            npcRootDir: config.npcRootDir,
            chatMemoryRootDir: config.chatMemoryRootDir
          });
          const chatResult = await provider.chat({
            messages: providerRequest.messages,
            temperature: chatRequest.temperature
          });
          await appendChatTurn(
            config.chatMemoryRootDir,
            chatRequest.npcId!,
            session.playerId,
            chatRequest.message,
            chatResult.content,
            now()
          );
          return chatResult;
        });
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
