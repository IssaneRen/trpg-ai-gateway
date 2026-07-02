import { afterEach, describe, expect, it } from "vitest";
import { authenticateBearerToken, hashToken } from "./tokens.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("authenticateBearerToken", () => {
  it("returns a local debug session for any bearer token when dev auth bypass is enabled", () => {
    process.env = {
      ...originalEnv,
      DEV_AUTH_BYPASS: "1",
      DEV_PLAYER_ID: "pl.local",
      DEV_PLAYER_NAME: "本地调试",
      DEV_IS_KEEPER: "1"
    };
    delete process.env.NODE_ENV;

    const session = authenticateBearerToken("Bearer anything", [], "unused", []);

    expect(session).toEqual({
      playerId: "pl.local",
      displayName: "本地调试",
      isKeeper: true
    });
  });

  it("ignores dev auth bypass in production", () => {
    const pepper = "pepper";
    process.env = {
      ...originalEnv,
      DEV_AUTH_BYPASS: "1",
      NODE_ENV: "production"
    };

    const session = authenticateBearerToken(
      "Bearer real-token",
      [
        {
          playerId: "pl.cici",
          displayName: "Cici",
          tokenHash: hashToken("real-token", pepper)
        }
      ],
      pepper,
      ["pl.cici"]
    );

    expect(session).toEqual({
      playerId: "pl.cici",
      displayName: "Cici",
      isKeeper: false
    });
  });
});
