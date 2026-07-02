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

## GitHub Actions 自动部署

子仓库 push 到 `main` 或 `master` 会触发 `.github/workflows/deploy.yml`。部署目录、服务名、运行时环境文件、模型 key 与服务器网络细节均由 GitHub Secrets 或服务器本地配置提供，不写入公开仓库。

模组线索分为两类目录：

- `MODULE_CLUE_CONTENT_ROOT_DIR`：随代码发布的静态线索池，例如 `data/module-clues`。
- `MODULE_CLUE_VISIBILITY_ROOT_DIR`：服务器运行态可见性配置，必须指向发布目录之外或 `.local/` 这类持久化目录，避免 GitHub Actions 覆盖线上 KP 编辑结果。

旧配置 `MODULE_CLUE_ROOT_DIR` / `moduleClueRootDir` 仍作为兼容兜底；新部署建议显式配置上面两个目录。
