import type { IncomingMessage } from "node:http";
import type { RuntimeConfig } from "../config.js";

export function requireQqChatbotInternalToken(request: IncomingMessage, config: RuntimeConfig): void {
  const expected = config.qqChatbot.internalToken;
  if (!expected) throw Object.assign(new Error("qq chatbot is disabled"), { statusCode: 404 });

  const actual = request.headers["x-trpg-internal-token"];
  if (Array.isArray(actual) || actual !== expected) {
    throw Object.assign(new Error("forbidden"), { statusCode: 403 });
  }
}
