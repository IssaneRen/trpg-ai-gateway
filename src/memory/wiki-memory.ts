import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeJsonFileName } from "./safe-path.js";

interface WikiInlineToken {
  type: "text" | "ref" | "secret-inline";
  text?: string;
  label?: string;
  playerIds?: string[];
}

interface WikiBlock {
  type: string;
  text?: string;
  tokens?: WikiInlineToken[];
  items?: WikiInlineToken[][];
  title?: string;
  playerIds?: string[];
  blocks?: WikiBlock[];
}

interface WikiEntryRecord {
  id: string;
  displayName: string;
  summary?: string;
  content?: WikiBlock[];
}

function canReveal(playerIds: string[] | undefined, playerId: string): boolean {
  return Boolean(playerIds?.includes(playerId));
}

function renderTokens(tokens: WikiInlineToken[] | undefined, playerId: string): string {
  return (tokens ?? [])
    .map((token) => {
      if (token.type === "text") return token.text ?? "";
      if (token.type === "ref") return token.label ?? "";
      if (token.type === "secret-inline") {
        return canReveal(token.playerIds, playerId) ? token.text ?? "" : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

function renderBlocks(blocks: WikiBlock[] | undefined, playerId: string): string[] {
  const lines: string[] = [];

  for (const block of blocks ?? []) {
    if (block.type === "secret-panel") {
      if (canReveal(block.playerIds, playerId)) {
        if (block.title) lines.push(`## ${block.title}`);
        lines.push(...renderBlocks(block.blocks, playerId));
      }
      continue;
    }

    if (block.text) lines.push(block.text);

    const tokenText = renderTokens(block.tokens, playerId);
    if (tokenText) lines.push(tokenText);

    for (const item of block.items ?? []) {
      const itemText = renderTokens(item, playerId);
      if (itemText) lines.push(`- ${itemText}`);
    }

    if (block.blocks) lines.push(...renderBlocks(block.blocks, playerId));
  }

  return lines;
}

export async function readWikiMemoryByFileName(
  wikiEntriesDir: string,
  fileName: string,
  playerId: string
): Promise<string> {
  const safeFileName = assertSafeJsonFileName(fileName);
  const raw = await readFile(join(wikiEntriesDir, safeFileName), "utf-8");
  const entry = JSON.parse(raw) as WikiEntryRecord;
  const lines = [
    `# ${entry.displayName || entry.id}`,
    entry.summary ? `摘要：${entry.summary}` : "",
    ...renderBlocks(entry.content, playerId)
  ].filter(Boolean);

  return lines.join("\n");
}
