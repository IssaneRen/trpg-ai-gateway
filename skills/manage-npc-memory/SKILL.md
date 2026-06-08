---
name: manage-npc-memory
description: Use when creating, reviewing, or updating NPC memory folders in this trpg-ai-gateway repository, including npc.json, common-memory.md, and per-player memory files.
---

# Manage NPC Memory

Use this skill inside the `trpg-ai-gateway` repository when maintaining NPC memory.

## Workflow

1. Read `repo.json` first to confirm paths and security rules.
2. Locate the NPC folder at `data/npcs/<npcId>/`.
3. Keep one NPC per folder:
   - `npc.json` stores metadata and `wikiFileNames`.
   - `common-memory.md` stores memory available to all PLs.
   - `players/<playerId>.memory.md` stores that PL's private memory with this NPC.
4. Never write API keys, service tokens, or real deployment credentials into memory files.
5. Preserve in-world wording. Do not write meta notes like “玩家应该知道”.
6. If adding `wikiFileNames`, use exact JSON file names from the parent Wiki entries directory.

## Checks

- Run `pnpm test` after changing memory parsing assumptions.
- Run `pnpm build` before committing repository structure changes.
