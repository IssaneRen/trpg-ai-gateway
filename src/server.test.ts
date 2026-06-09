import { describe, expect, it } from "vitest";
import { createApp } from "./server.js";
import type { RuntimeConfig } from "./config.js";

const config: RuntimeConfig = {
  port: 0,
  allowedOrigin: "https://main.example.com",
  wikiEntriesDir: "/unused",
  npcRootDir: "/unused",
  ai: {
    baseUrl: "https://unused.example.com",
    model: "unused",
    apiKey: "unused"
  }
};

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
    await new Promise<void>((resolve) => app.close(() => resolve()));
  });
});
