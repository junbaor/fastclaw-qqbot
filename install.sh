#!/usr/bin/env bash
set -euo pipefail

# FastClaw QQ Bot Plugin Installer
# Usage:
#   bash install.sh --token "appId:clientSecret"
#   curl -fsSL <url>/install.sh | bash -s -- --token "appId:clientSecret"

PLUGIN_ID="qqbot"
FASTCLAW_HOME="${HOME}/.fastclaw"
PLUGIN_DIR="${FASTCLAW_HOME}/plugins/${PLUGIN_ID}"
CONFIG_FILE="${FASTCLAW_HOME}/fastclaw.json"

APP_ID=""
CLIENT_SECRET=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)
      IFS=':' read -r APP_ID CLIENT_SECRET <<< "$2"
      shift 2
      ;;
    --appid)
      APP_ID="$2"
      shift 2
      ;;
    --secret)
      CLIENT_SECRET="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: install.sh --token appId:clientSecret"
      echo "       install.sh --appid YOUR_APPID --secret YOUR_SECRET"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$APP_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "Error: --token appId:clientSecret is required"
  echo "Usage: install.sh --token 1903230345:O9ugSF2qeTI8zqiaTMGA50wspnlkjjjk"
  exit 1
fi

echo "==> Installing FastClaw QQ Bot Plugin..."

# Check node
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required. Install from https://nodejs.org/"
  exit 1
fi

# Check npm
if ! command -v npm &>/dev/null; then
  echo "Error: npm is required."
  exit 1
fi

# Create plugin dir
mkdir -p "$PLUGIN_DIR"

# Download plugin files (if running from curl, download from GitHub)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" 2>/dev/null)" && pwd 2>/dev/null || echo "")"

if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/plugin.mjs" ]]; then
  # Local install
  echo "==> Copying plugin files from $SCRIPT_DIR..."
  cp "$SCRIPT_DIR/plugin.json" "$PLUGIN_DIR/"
  cp "$SCRIPT_DIR/plugin.mjs" "$PLUGIN_DIR/"
  cp "$SCRIPT_DIR/package.json" "$PLUGIN_DIR/"
  [[ -f "$SCRIPT_DIR/README.md" ]] && cp "$SCRIPT_DIR/README.md" "$PLUGIN_DIR/"
else
  # Remote install via npm
  echo "==> Installing from npm..."
  cd "$PLUGIN_DIR"
  npm pack fastclaw-qqbot --pack-destination . 2>/dev/null && \
    tar xzf fastclaw-qqbot-*.tgz --strip-components=1 && \
    rm -f fastclaw-qqbot-*.tgz || {
    echo "Error: Failed to download plugin from npm."
    echo "You can manually copy plugin files to $PLUGIN_DIR"
    exit 1
  }
fi

# Install dependencies
echo "==> Installing dependencies..."
cd "$PLUGIN_DIR"
npm install --production 2>/dev/null

# Update fastclaw config
echo "==> Configuring fastclaw..."
python3 -c "
import json, os, sys

config_path = '$CONFIG_FILE'
app_id = '$APP_ID'
client_secret = '$CLIENT_SECRET'

# Load or create config
if os.path.exists(config_path):
    with open(config_path, 'r') as f:
        cfg = json.load(f)
else:
    cfg = {}

# Ensure plugins section
if 'plugins' not in cfg:
    cfg['plugins'] = {}
cfg['plugins']['enabled'] = True

# Ensure paths includes default plugin dir
paths = cfg['plugins'].get('paths', [])
if '~/.fastclaw/plugins' not in paths:
    paths.append('~/.fastclaw/plugins')
cfg['plugins']['paths'] = paths

# Set plugin config
entries = cfg['plugins'].get('entries', {})
entries['qqbot'] = {
    'enabled': True,
    'config': {
        'appId': app_id,
        'clientSecret': client_secret,
    }
}
cfg['plugins']['entries'] = entries

# Ensure binding exists
bindings = cfg.get('bindings', [])
has_qqbot_binding = any(b.get('match', {}).get('channel') == 'qqbot' for b in bindings)
if not has_qqbot_binding:
    # Find first agent id or use 'default'
    agent_id = 'default'
    agents = cfg.get('agents', {}).get('list', [])
    if agents:
        agent_id = agents[0].get('id', 'default')
    bindings.append({'agentId': agent_id, 'match': {'channel': 'qqbot'}})
    cfg['bindings'] = bindings

with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print('Config updated.')
"

echo ""
echo "==> Done! QQ Bot plugin installed successfully."
echo ""
echo "    Plugin dir: $PLUGIN_DIR"
echo "    AppID:      $APP_ID"
echo ""
echo "    Restart fastclaw to activate:"
echo "      fastclaw daemon restart"
echo ""
echo "    View logs:"
echo "      tail -f ~/.fastclaw/logs/qqbot.log"
echo ""
echo "    IMPORTANT: Make sure your bot has NO webhook callback URL configured"
echo "    on QQ Open Platform, otherwise WebSocket events won't be received."
