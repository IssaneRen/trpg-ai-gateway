# TRPG AI Gateway

独立的 NPC AI 对话网关。父工程只需要在 `.gitignore` 中忽略本目录；进入本目录后，它是单独的 Git 仓库。

## 能力

- 按 `npcId` 读取 `data/npcs/<npcId>/npc.json`。
- 按 `npc.json#wikiFileNames` 从父工程部署目录读取 Wiki JSON，作为通用记忆来源。
- 按 `playerId` 读取 `data/npcs/<npcId>/players/<playerId>.memory.md`。
- 组装 prompt 后调用 DeepSeek 或其他 OpenAI-compatible 模型。
- API key 只从服务器环境变量读取，不进入前端和 Git。

## 本地开发

```bash
pnpm install
pnpm test
pnpm dev
```

本地如需真实调用模型：

```bash
cp config.example.json config.local.json
export DEEPSEEK_API_KEY=sk-xxx
pnpm dev
```

## API

```http
GET /health
```

```http
POST /api/chat
Content-Type: application/json

{
  "npcId": "char.example",
  "playerId": "pl.example",
  "message": "你还记得我吗？",
  "temperature": 0.6
}
```

## 服务器配置建议

把密钥放在服务器，不放 GitHub Actions：

```bash
sudo mkdir -p /etc/trpg-ai
sudo nano /etc/trpg-ai/trpg-ai.env
sudo chmod 600 /etc/trpg-ai/trpg-ai.env
```

示例：

```bash
PORT=3001
WIKI_ENTRIES_DIR=/var/www/trpg-helper/wiki/entities/entries
NPC_ROOT_DIR=/opt/trpg-ai-gateway/data/npcs
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=sk-xxx
```

systemd 服务可使用：

```ini
[Unit]
Description=TRPG AI Gateway
After=network.target

[Service]
WorkingDirectory=/opt/trpg-ai-gateway
EnvironmentFile=/etc/trpg-ai/trpg-ai.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

Nginx 反代：

```nginx
location /api/ai/ {
    proxy_pass http://127.0.0.1:3001/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```
