import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createOpenAiCompatibleProvider } from "./ai/openai-compatible.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import { buildNpcPrompt } from "./prompt/prompt-builder.js";
import type { ChatRequest } from "./types.js";

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function validateChatRequest(value: unknown): ChatRequest {
  const candidate = value as Partial<ChatRequest>;
  if (!candidate || typeof candidate !== "object") throw new Error("request body must be JSON");
  if (!candidate.npcId || typeof candidate.npcId !== "string") throw new Error("npcId is required");
  if (!candidate.playerId || typeof candidate.playerId !== "string") {
    throw new Error("playerId is required");
  }
  if (!candidate.message || typeof candidate.message !== "string") {
    throw new Error("message is required");
  }
  return {
    npcId: candidate.npcId,
    playerId: candidate.playerId,
    message: candidate.message,
    temperature: typeof candidate.temperature === "number" ? candidate.temperature : undefined
  };
}

export function createApp(config: RuntimeConfig = loadRuntimeConfig()) {
  const provider = createOpenAiCompatibleProvider(config.ai);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat") {
        const chatRequest = validateChatRequest(await readJsonBody(request));
        const prompt = await buildNpcPrompt({
          npcId: chatRequest.npcId,
          playerId: chatRequest.playerId,
          userMessage: chatRequest.message,
          wikiEntriesDir: config.wikiEntriesDir,
          npcRootDir: config.npcRootDir
        });
        const result = await provider.chat({
          messages: prompt.messages,
          temperature: chatRequest.temperature
        });
        writeJson(response, 200, result);
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : "unknown error" });
    }
  });
}

if (process.env.NODE_ENV !== "test") {
  const config = loadRuntimeConfig();
  createApp(config).listen(config.port, "127.0.0.1", () => {
    console.log(`trpg-ai-gateway listening on 127.0.0.1:${config.port}`);
  });
}
