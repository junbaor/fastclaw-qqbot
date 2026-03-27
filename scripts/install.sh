#!/usr/bin/env bash
set -euo pipefail

# FastClaw QQ Bot Plugin Installer (macOS / Linux)
# Usage:
#   首次安装: install.sh --token "appId:clientSecret"
#   升级:     install.sh

PLUGIN_ID="qqbot"
FASTCLAW_HOME="${HOME}/.fastclaw"
PLUGIN_DIR="${FASTCLAW_HOME}/plugins/${PLUGIN_ID}"
GITHUB_REPO="junbaor/fastclaw-qqbot"

APP_ID=""
CLIENT_SECRET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)
      IFS=':' read -r APP_ID CLIENT_SECRET <<< "$2"
      shift 2
      ;;
    --appid)  APP_ID="$2"; shift 2 ;;
    --secret) CLIENT_SECRET="$2"; shift 2 ;;
    -h|--help)
      echo "Usage:"
      echo "  install.sh --token appId:clientSecret   # 首次安装"
      echo "  install.sh                              # 升级（仅更新二进制）"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Determine install vs upgrade
UPGRADE=false
if [[ -z "$APP_ID" || -z "$CLIENT_SECRET" ]]; then
  if [[ -f "${PLUGIN_DIR}/qqbot" ]]; then
    UPGRADE=true
    echo "==> Upgrading FastClaw QQ Bot Plugin..."
  else
    echo "Error: --token appId:clientSecret is required for first install"
    exit 1
  fi
else
  echo "==> Installing FastClaw QQ Bot Plugin..."
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)        ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Error: Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "==> Platform: ${OS}/${ARCH}"
mkdir -p "$PLUGIN_DIR"

DOWNLOAD_BASE="https://github.com/${GITHUB_REPO}/releases/latest/download"
BINARY_NAME="qqbot-${OS}-${ARCH}"

echo "==> Downloading binary..."
curl -fsSL "${DOWNLOAD_BASE}/${BINARY_NAME}" -o "${PLUGIN_DIR}/qqbot"
chmod +x "${PLUGIN_DIR}/qqbot"

echo "==> Downloading plugin.json..."
curl -fsSL "https://raw.githubusercontent.com/${GITHUB_REPO}/master/plugin.json" -o "${PLUGIN_DIR}/plugin.json"

if [[ "$UPGRADE" == "true" ]]; then
  echo ""
  echo "==> Upgrade complete!"
  echo "    Restart fastclaw to activate:  fastclaw daemon restart"
  exit 0
fi

echo "==> Configuring fastclaw..."
"${PLUGIN_DIR}/qqbot" --setup --appid "$APP_ID" --secret "$CLIENT_SECRET"

echo ""
echo "==> Done!"
echo "    Plugin dir: $PLUGIN_DIR"
echo "    AppID:      $APP_ID"
echo ""
echo "    Restart fastclaw to activate:  fastclaw daemon restart"
echo "    View logs:  tail -f ~/.fastclaw/logs/qqbot.log"
echo ""
echo "    IMPORTANT: Make sure your bot has NO webhook callback URL configured"
echo "    on QQ Open Platform, otherwise WebSocket events won't be received."
