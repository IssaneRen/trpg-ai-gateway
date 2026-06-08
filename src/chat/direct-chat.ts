import type { ChatMessage, ChatRequest, ProviderChatRequest } from "../types.js";

function normalizeMessages(request: ChatRequest): ChatMessage[] {
  if (request.messages?.length) {
    return request.messages.map((message) => ({
      role: message.role,
      content: message.content
    }));
  }

  return [{ role: "user", content: request.message }];
}

export function buildDirectChatRequest(request: ChatRequest): ProviderChatRequest {
  return {
    messages: normalizeMessages(request),
    temperature: request.temperature
  };
}
