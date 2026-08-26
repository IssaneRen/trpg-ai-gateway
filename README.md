# TRPG AI Gateway

独立的 NPC AI 对话网关。父工程只需要在 `.gitignore` 中忽略本目录；进入本目录后，它是单独的 Git 仓库。

## 能力

- 按 `npcId` 读取 `data/npcs/<npcId>/npc.json`。
- 按 `npc.json#wikiFileNames` 从父工程部署目录读取 Wiki JSON，作为通用记忆来源。
- 按 `playerId` 读取 `data/npcs/<npcId>/players/<playerId>.memory.md`。
- 组装 prompt 后调用 DeepSeek 或其他 OpenAI-compatible 模型。
- 可通过内部 QQ Chatbot 接口复用同一套 NPC/PL 记忆。
- API key 只从服务器环境变量读取，不进入前端和 Git。

## 本地开发

```bash
pnpm install
pnpm test
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
  "message": "你还记得我吗？"
}
```

```http
POST /api/internal/qq-chatbot/talk
x-trpg-internal-token: <QQ_CHATBOT_INTERNAL_TOKEN>
Content-Type: application/json

{
  "qqUserId": "123456789",
  "npc": "克莱儿",
  "message": "你还记得我吗？"
}
```

```http
POST /api/internal/qq-chatbot/memory
x-trpg-internal-token: <QQ_CHATBOT_INTERNAL_TOKEN>
Content-Type: application/json

{
  "adminQqUserId": "123456789",
  "npc": "克莱儿",
  "player": "pl.cici",
  "text": "她单独记得 Cici 的承诺。"
}
```

## GitHub Actions 自动部署

子仓库 push 到 `main` 或 `master` 会触发 `.github/workflows/deploy.yml`。部署目录、服务名、运行时环境文件、模型 key 与服务器网络细节均由 GitHub Secrets 或服务器本地配置提供，不写入公开仓库。

模组线索分为两类目录：

- `MODULE_CLUE_CONTENT_ROOT_DIR`：随代码发布的静态线索池，例如 `data/module-clues`。
- `MODULE_CLUE_VISIBILITY_ROOT_DIR`：服务器运行态可见性配置，必须指向发布目录之外或 `.local/` 这类持久化目录，避免 GitHub Actions 覆盖线上 KP 编辑结果。

旧配置 `MODULE_CLUE_ROOT_DIR` / `moduleClueRootDir` 仍作为兼容兜底；新部署建议显式配置上面两个目录。

Analytics 统计数据也必须放在 release 目录之外：

- `ANALYTICS_ROOT_DIR`：运行态统计 JSONL 目录，当前 GitHub Actions 写入 `${APP_DIR}/shared/analytics`。
- `ANALYTICS_MAX_EVENTS`：保留最近事件数量，默认 `20000`。个人站点按这个上限通常只占用数 MB 到十几 MB 量级；超过上限会裁掉最旧事件。

本地开发未配置 `ANALYTICS_ROOT_DIR` 时默认写入 `.local/analytics/events.jsonl`。生产部署不要把它指向 `${APP_DIR}/current` 或任一 `releases/<sha>` 目录，避免下一次部署切换 release 后看不到旧数据。

QQ Chatbot 也使用运行时路径：

- `QQ_CHATBOT_INTERNAL_TOKEN`：海豹插件调用内部接口的共享 token。
- `QQ_CHATBOT_PLAYER_MAP_FILE`：QQ 号到 `playerId` 的 JSON 映射文件。
- `QQ_CHATBOT_ADMIN_QQ_IDS`：允许 `.chatbot add-memory` 的 QQ 号，逗号分隔。
- `NPC_ROOT_DIR`：如启用 QQ 追加记忆，生产环境应指向 shared 目录。
- `CHAT_MEMORY_ROOT_DIR`：聊天记录目录，必须指向 shared 或 `.local` 这类持久化目录。
- `WIKI_ENTRIES_DIR`：生产环境应指向 `/var/www/trpg-content/wiki/entities/entries`，不要指向 Git release 内的 `public/wiki`。
