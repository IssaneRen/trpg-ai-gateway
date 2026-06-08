---
name: deploy-ai-gateway
description: Use when preparing GitHub Actions, server deployment, systemd, Nginx reverse proxy, or runtime environment variables for this AI gateway.
---

# Deploy AI Gateway

Use this skill when deploying `trpg-ai-gateway`.

## Deployment Shape

Recommended server paths:

- App: `/opt/trpg-ai-gateway`
- Env file: `/etc/trpg-ai/trpg-ai.env`
- Parent Wiki entries: `/var/www/trpg-helper/wiki/entities/entries`
- Local port: `127.0.0.1:3001`

## GitHub Actions Boundary

GitHub Actions should upload code and restart the service. Prefer not to store model API keys in GitHub Secrets. Keep model keys in `/etc/trpg-ai/trpg-ai.env` on the server.

## Required Environment

```bash
PORT=3001
WIKI_ENTRIES_DIR=/var/www/trpg-helper/wiki/entities/entries
NPC_ROOT_DIR=/opt/trpg-ai-gateway/data/npcs
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=sk-xxx
```

## Verify

After deployment:

```bash
curl http://127.0.0.1:3001/health
systemctl status trpg-ai-gateway
```
