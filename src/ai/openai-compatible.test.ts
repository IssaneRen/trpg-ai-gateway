import { describe, expect, it } from "vitest";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

describe("createOpenAiCompatibleProvider", () => {
  it("calls an OpenAI-compatible chat endpoint with the server-side api key", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = createOpenAiCompatibleProvider(
      {
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        apiKey: "server-only-key"
      },
      async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "回应文本" } }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );

    const result = await provider.chat({
      messages: [{ role: "user", content: "你好" }],
      temperature: 0.4
    });

    expect(result.content).toBe("回应文本");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(requests[0].init.headers).toMatchObject({
      authorization: "Bearer server-only-key",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "你好" }],
      temperature: 0.4
    });
  });
});
