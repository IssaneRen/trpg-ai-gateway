---
name: review-ai-gateway
description: Use when reviewing or changing the AI gateway code, provider configuration, prompt assembly, server deployment, or secret-handling behavior.
---

# Review AI Gateway

Use this skill inside the `trpg-ai-gateway` repository for code and deployment changes.

## Required Context

1. Read `repo.json`.
2. Read `README.md` if deployment behavior is involved.
3. Check tests near the changed module before editing.

## Security Rules

- API keys must come from environment variables only.
- Do not allow callers to provide arbitrary `baseUrl`, `apiKey`, or model provider config.
- Keep `config.local.json` and `.env*` untracked.
- Treat parent Wiki files as source data; only include secret blocks in prompts when the current `playerId` is authorized.

## Verification

Run:

```bash
pnpm test
pnpm build
```

If dependency or runtime behavior changes, also run:

```bash
pnpm type-check
```
