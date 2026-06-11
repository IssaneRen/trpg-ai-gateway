#!/usr/bin/env node
import { createHash } from "node:crypto";

function hashToken(token, pepper) {
  return createHash("sha256").update(pepper).update("\0").update(token).digest("hex");
}

async function readInput() {
  if (process.argv[2]) return process.argv[2];
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

const pepper = process.env.TOKEN_HASH_PEPPER;
if (!pepper) {
  console.error("TOKEN_HASH_PEPPER is required.");
  process.exit(1);
}

const raw = await readInput();
if (!raw.trim()) {
  console.error(
    'Pass JSON records on stdin or argv, e.g. [{"playerId":"pl.leina","displayName":"莱纳","token":"..."}].'
  );
  process.exit(1);
}

const records = JSON.parse(raw);
if (!Array.isArray(records)) {
  console.error("Input must be a JSON array.");
  process.exit(1);
}

const output = records.map((record) => {
  if (
    !record ||
    typeof record.playerId !== "string" ||
    typeof record.displayName !== "string" ||
    typeof record.token !== "string"
  ) {
    throw new Error("Each record must contain playerId, displayName, and token strings.");
  }
  return {
    playerId: record.playerId,
    displayName: record.displayName,
    isKeeper: record.isKeeper === true,
    tokenHash: hashToken(record.token, pepper)
  };
});

console.log(JSON.stringify(output, null, 2));
