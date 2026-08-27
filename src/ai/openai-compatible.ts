import type { AiProvider, ChatResponse, ProviderChatRequest } from "../types.js";

export interface OpenAiCompatibleProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

type FetchLike = typeof fetch;

export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleProviderConfig,
  fetchImpl: FetchLike = fetch
): AiProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  return {
    async chat(request: ProviderChatRequest): Promise<ChatResponse> {
      const payload = {
        model: config.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.6
      };
      console.log("[AI_PROMPT]", JSON.stringify(payload));
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`AI provider request failed: ${response.status} ${text}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("AI provider returned an empty response");
      return { content };
    }
  };
}
