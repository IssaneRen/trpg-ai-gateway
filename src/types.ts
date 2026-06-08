export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface PromptBuildResult {
  messages: ChatMessage[];
}

export interface ChatRequest {
  npcId: string;
  playerId: string;
  message: string;
  temperature?: number;
}

export interface ChatResponse {
  content: string;
}

export interface ProviderChatRequest {
  messages: ChatMessage[];
  temperature?: number;
}

export interface AiProvider {
  chat(request: ProviderChatRequest): Promise<ChatResponse>;
}
