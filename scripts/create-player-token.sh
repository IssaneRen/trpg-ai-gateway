#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  echo "请直接执行本脚本，不要 source 它：bash scripts/create-player-token.sh" >&2
  return 1 2>/dev/null || exit 1
fi

set -Eeuo pipefail

PLAYER_ID="pl.xxt"
DISPLAY_NAME="xxt"
SERVICE_NAME=""
ENV_FILE=""
WORKDIR=""
VERIFY_URL="http://127.0.0.1:3001/api/session"
HEALTH_URL="http://127.0.0.1:3001/health"

usage() {
  cat <<'USAGE'
用法：
  bash scripts/create-player-token.sh [选项]

选项：
  --player-id <id>       默认：pl.xxt
  --display-name <name>  默认：xxt
  --service <name>       systemd 服务名；默认自动查找
  --env-file <path>      运行时 env 文件；默认从 systemd EnvironmentFile 读取
  --workdir <path>       gateway 工作目录；默认从 systemd WorkingDirectory 读取
  --verify-url <url>     默认：http://127.0.0.1:3001/api/session
  --health-url <url>     默认：http://127.0.0.1:3001/health
  -h, --help             显示帮助

说明：
  - 不会打印 TOKEN_HASH_PEPPER。
  - 会生成明文 token，并在最后打印给你转发给对应 PL。
  - 会备份 data/auth/token-hashes.json。
  - 如果 env 文件里有 SUPPORTED_PLAYER_IDS，会自动追加 playerId 并备份 env 文件。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --player-id)
      PLAYER_ID="${2:?缺少 --player-id 参数值}"
      shift 2
      ;;
    --display-name)
      DISPLAY_NAME="${2:?缺少 --display-name 参数值}"
      shift 2
      ;;
    --service)
      SERVICE_NAME="${2:?缺少 --service 参数值}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:?缺少 --env-file 参数值}"
      shift 2
      ;;
    --workdir)
      WORKDIR="${2:?缺少 --workdir 参数值}"
      shift 2
      ;;
    --verify-url)
      VERIFY_URL="${2:?缺少 --verify-url 参数值}"
      shift 2
      ;;
    --health-url)
      HEALTH_URL="${2:?缺少 --health-url 参数值}"
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

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: 缺少命令：$1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd openssl
need_cmd curl
need_cmd python3
need_cmd systemctl

find_service_name() {
  if [[ -n "$SERVICE_NAME" ]]; then
    echo "$SERVICE_NAME"
    return
  fi

  if systemctl list-unit-files --no-pager | grep -q '^trpg-ai-gateway\.service'; then
    echo "trpg-ai-gateway"
    return
  fi

  local candidate
  candidate="$(
    systemctl list-units --type=service --all --no-pager \
      | grep -iE 'trpg|gateway|node' \
      | grep -viE 'apt-daily|packagekit|snapd' \
      | awk '{print $1}' \
      | sed 's/\.service$//' \
      | head -n 1
  )"

  if [[ -z "$candidate" ]]; then
    echo "ERROR: 找不到 AI Gateway systemd 服务。可用 --service 手动指定。" >&2
    sudo ss -ltnp | grep ':3001' || true
    exit 1
  fi

  echo "$candidate"
}

read_systemd_env_file() {
  if [[ -n "$ENV_FILE" ]]; then
    echo "$ENV_FILE"
    return
  fi

  local value
  value="$(
    sudo systemctl cat "$SERVICE_NAME" \
      | sed -nE 's/^[[:space:]]*EnvironmentFile=-?(.+)$/\1/p' \
      | head -n 1
  )"

  if [[ -z "$value" ]]; then
    echo "ERROR: 服务 $SERVICE_NAME 中找不到 EnvironmentFile。可用 --env-file 手动指定。" >&2
    sudo systemctl cat "$SERVICE_NAME" >&2
    exit 1
  fi

  echo "$value"
}

read_systemd_workdir() {
  if [[ -n "$WORKDIR" ]]; then
    echo "$WORKDIR"
    return
  fi

  local value
  value="$(sudo systemctl show "$SERVICE_NAME" -p WorkingDirectory --value)"
  if [[ -z "$value" ]]; then
    echo "ERROR: 服务 $SERVICE_NAME 中找不到 WorkingDirectory。可用 --workdir 手动指定。" >&2
    exit 1
  fi
  echo "$value"
}

strip_shell_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

read_env_value() {
  local key="$1"
  sudo KEY="$key" python3 - "$ENV_FILE" <<'PY'
import os
import re
import shlex
import sys
from pathlib import Path

key = os.environ["KEY"]
path = Path(sys.argv[1])
pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(key)}\s*=\s*(.*)$")

for raw_line in path.read_text().splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#"):
        continue
    match = pattern.match(raw_line)
    if not match:
        continue
    value = match.group(1).strip()
    if value:
        try:
            parts = shlex.split(value, comments=True, posix=True)
            if parts:
                print(parts[0])
                raise SystemExit(0)
        except ValueError:
            pass
    print(value.strip("\"'"))
    raise SystemExit(0)

raise SystemExit(1)
PY
}

SERVICE_NAME="$(find_service_name)"
ENV_FILE="$(read_systemd_env_file)"
WORKDIR="$(read_systemd_workdir)"

echo "SERVICE_NAME=$SERVICE_NAME"
echo "ENV_FILE=$ENV_FILE"
echo "WORKDIR=$WORKDIR"

sudo test -f "$ENV_FILE" || {
  echo "ERROR: env 文件不存在：$ENV_FILE" >&2
  exit 1
}

TOKEN_HASH_PEPPER_VALUE=""
if TOKEN_HASH_PEPPER_VALUE="$(read_env_value TOKEN_HASH_PEPPER)"; then
  echo "TOKEN_HASH_PEPPER exists"
else
  echo "env 文件里没有 TOKEN_HASH_PEPPER。"
  read -rsp "请输入 TOKEN_HASH_PEPPER（不会显示）： " TOKEN_HASH_PEPPER_VALUE
  echo
fi

if [[ -z "$TOKEN_HASH_PEPPER_VALUE" ]]; then
  echo "ERROR: TOKEN_HASH_PEPPER 为空" >&2
  exit 1
fi

cd "$WORKDIR"

TOKEN_HASH_FILE="data/auth/token-hashes.json"
if TOKEN_HASH_FILE_VALUE="$(read_env_value TOKEN_HASH_FILE)"; then
  TOKEN_HASH_FILE="$TOKEN_HASH_FILE_VALUE"
fi

test -f "$TOKEN_HASH_FILE" || {
  echo "ERROR: 找不到 $WORKDIR/$TOKEN_HASH_FILE" >&2
  exit 1
}

TOKEN="$(openssl rand -base64 32)"
NEW_RECORD_JSON="$(
  PLAYER_ID="$PLAYER_ID" \
  DISPLAY_NAME="$DISPLAY_NAME" \
  TOKEN="$TOKEN" \
  TOKEN_HASH_PEPPER="$TOKEN_HASH_PEPPER_VALUE" \
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
}));
'
)"

BACKUP_FILE="${TOKEN_HASH_FILE}.bak.$(date +%F-%H%M%S)"
sudo cp "$TOKEN_HASH_FILE" "$BACKUP_FILE"
echo "已备份 token hash 文件：$WORKDIR/$BACKUP_FILE"

TMP_JSON="$(mktemp)"
TMP_CURL_CONFIG=""
trap 'rm -f "${TMP_JSON:-}" "${TMP_CURL_CONFIG:-}"' EXIT
sudo cat "$TOKEN_HASH_FILE" > "$TMP_JSON"

NEW_RECORD_JSON="$NEW_RECORD_JSON" TOKEN_HASH_PATH="$TMP_JSON" node -e '
const fs = require("fs");
const file = process.env.TOKEN_HASH_PATH;
const records = JSON.parse(fs.readFileSync(file, "utf8"));
const next = JSON.parse(process.env.NEW_RECORD_JSON);
const index = records.findIndex((item) => item.playerId === next.playerId);
if (index >= 0) records[index] = next;
else records.push(next);
fs.writeFileSync(file, JSON.stringify(records, null, 2) + "\n");
'

node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log('json ok')" "$TMP_JSON"
sudo cp "$TMP_JSON" "$TOKEN_HASH_FILE"
echo "已写入 $WORKDIR/$TOKEN_HASH_FILE"

SUPPORTED_LINE="$(sudo grep -m 1 '^SUPPORTED_PLAYER_IDS=' "$ENV_FILE" || true)"
if [[ -n "$SUPPORTED_LINE" ]]; then
  if [[ ",${SUPPORTED_LINE#*=}," == *",$PLAYER_ID,"* ]]; then
    echo "SUPPORTED_PLAYER_IDS already contains $PLAYER_ID"
  else
    ENV_BACKUP="${ENV_FILE}.bak.$(date +%F-%H%M%S)"
    sudo cp "$ENV_FILE" "$ENV_BACKUP"
    sudo PLAYER_ID="$PLAYER_ID" python3 - "$ENV_FILE" <<'PY'
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
player_id = os.environ["PLAYER_ID"]
lines = path.read_text().splitlines()
out = []
updated = False

for line in lines:
    if not line.startswith("SUPPORTED_PLAYER_IDS="):
        out.append(line)
        continue
    key, value = line.split("=", 1)
    quote = ""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        quote = value[0]
        value = value[1:-1]
    ids = [item.strip() for item in value.split(",") if item.strip()]
    if player_id not in ids:
        ids.append(player_id)
    out.append(f"{key}={quote}{','.join(ids)}{quote}")
    updated = True

if not updated:
    raise SystemExit("SUPPORTED_PLAYER_IDS line disappeared")

path.write_text("\n".join(out) + "\n")
PY
    echo "已更新 SUPPORTED_PLAYER_IDS，并备份 env 文件：$ENV_BACKUP"
  fi
else
  echo "SUPPORTED_PLAYER_IDS not set; skip"
fi

sudo systemctl restart "$SERVICE_NAME"
sudo systemctl status "$SERVICE_NAME" --no-pager

echo
echo "Health check:"
curl -sS "$HEALTH_URL"
echo

TMP_CURL_CONFIG="$(mktemp)"
cat > "$TMP_CURL_CONFIG" <<CURL
request = "POST"
url = "$VERIFY_URL"
header = "Authorization: Bearer $TOKEN"
header = "Content-Type: application/json"
data = "{}"
silent
show-error
CURL

echo "Session check:"
curl --config "$TMP_CURL_CONFIG"
echo

echo
echo "发给 ${DISPLAY_NAME} 的明文 token："
echo "$TOKEN"
echo
echo "注意：明文 token 只发给对应 PL，不要提交 Git。"
