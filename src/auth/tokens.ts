import { createHash, timingSafeEqual } from "node:crypto";

export interface TokenHashRecord {
  playerId: string;
  displayName: string;
  isKeeper?: boolean;
  tokenHash: string;
}

export interface AuthSession {
  playerId: string;
  displayName: string;
  isKeeper: boolean;
}

const SHA256_HEX_LENGTH = 64;

export function hashToken(token: string, pepper: string): string {
  return createHash("sha256").update(pepper).update("\0").update(token).digest("hex");
}

function parseBearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1];
}

function safeCompareHex(candidateHash: string, storedHash: string): boolean {
  const candidate = Buffer.from(candidateHash, "hex");
  const validStored = /^[a-f0-9]{64}$/i.test(storedHash);
  const stored = validStored ? Buffer.from(storedHash, "hex") : Buffer.alloc(32);
  if (candidate.length !== stored.length) return false;
  const matched = timingSafeEqual(candidate, stored);
  return validStored && matched;
}

export function authenticateBearerToken(
  authorization: string | undefined,
  records: TokenHashRecord[],
  pepper: string,
  supportedPlayerIds: string[]
): AuthSession | undefined {
  const token = parseBearerToken(authorization);
  if (!token) return undefined;

  const candidateHash = hashToken(token, pepper);
  const supported = new Set(supportedPlayerIds);
  for (const record of records) {
    if (record.tokenHash.length !== SHA256_HEX_LENGTH) {
      safeCompareHex(candidateHash, record.tokenHash);
      continue;
    }
    if (!safeCompareHex(candidateHash, record.tokenHash)) continue;
    const isKeeper = record.isKeeper === true;
    if (!isKeeper && !supported.has(record.playerId)) return undefined;
    return {
      playerId: record.playerId,
      displayName: record.displayName,
      isKeeper
    };
  }
  return undefined;
}
