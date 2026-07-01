#!/usr/bin/env bash

set -Eeuo pipefail

PLAYER_ID=""
DISPLAY_NAME=""
ENV_FILE=""

usage() {
  cat <<'USAGE'
用法：
  ./scripts/print-player-token-record.sh --env-file <path> --player-id <id> --display-name <name>

示例：
  ./scripts/print-player-token-record.sh \
    --env-file /home/ubuntu/trpg-ai-gateway.env \
    --player-id pl.xxt \
    --display-name xxt

输出：
  1. 复制进 data/auth/token-hashes.json 的 tokenHash 记录
  2. 私发给 PL 的明文 token

注意：
  - 不会打印 TOKEN_HASH_PEPPER。
  - 不会修改服务器文件。
  - 明文 token 不要提交 Git。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:?缺少 --env-file 参数值}"
      shift 2
      ;;
    --player-id)
      PLAYER_ID="${2:?缺少 --player-id 参数值}"
      shift 2
      ;;
    --display-name)
      DISPLAY_NAME="${2:?缺少 --display-name 参数值}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$ENV_FILE" || -z "$PLAYER_ID" || -z "$DISPLAY_NAME" ]]; then
  usage >&2
  exit 2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env 文件不存在：$ENV_FILE" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 缺少 node" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: 缺少 openssl" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [[ -z "${TOKEN_HASH_PEPPER:-}" ]]; then
  echo "ERROR: env 文件里没有 TOKEN_HASH_PEPPER" >&2
  exit 1
fi

TOKEN="$(openssl rand -base64 32)"
export PLAYER_ID DISPLAY_NAME TOKEN

echo "复制下面这个对象到子仓库 data/auth/token-hashes.json："
node -e '
const { createHash } = require("node:crypto");
const tokenHash = createHash("sha256")
  .update(process.env.TOKEN_HASH_PEPPER)
  .update("\0")
  .update(process.env.TOKEN)
  .digest("hex");
console.log(JSON.stringify({
  playerId: process.env.PLAYER_ID,
  displayName: process.env.DISPLAY_NAME,
  isKeeper: false,
  tokenHash
}, null, 2));
'

echo
echo "私发给 ${DISPLAY_NAME} 的明文 token："
echo "$TOKEN"
echo
echo "注意：只提交 tokenHash；不要提交明文 token 或 TOKEN_HASH_PEPPER。"
