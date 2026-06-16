#!/bin/bash
set -euo pipefail

PLUGIN_DIR="${1:-$HOME/.openclaw/extensions/xmpp}"

echo "============================================"
echo " XMPP Plugin Installer for OpenClaw 2026.6+"
echo "============================================"

mkdir -p "$PLUGIN_DIR"

if [ ! -f "$PLUGIN_DIR/package.json" ]; then
    echo "Cloning repository..."
    git clone https://github.com/kazakhan/openclaw-xmpp.git "$PLUGIN_DIR"
fi

cd "$PLUGIN_DIR"

echo "Installing npm dependencies..."
npm install

echo "Linking global OpenClaw SDK..."
GLOBAL_OPENCLAW="$(npm root -g)/openclaw"
if [ -d "$GLOBAL_OPENCLAW" ]; then
    LOCAL_LINK="$PLUGIN_DIR/node_modules/openclaw"
    if [ -L "$LOCAL_LINK" ] || [ -d "$LOCAL_LINK" ]; then
        echo "  node_modules/openclaw already present (skipping junction)"
    else
        ln -s "$GLOBAL_OPENCLAW" "$LOCAL_LINK"
        echo "  Symlink created: $LOCAL_LINK -> $GLOBAL_OPENCLAW"
    fi
else
    echo "  WARNING: Global OpenClaw not found. Run: npm install -g openclaw"
fi

echo "Removing old compiled JS..."
rm -rf dist/

echo "Compiling TypeScript..."
TSC_LOG="$PLUGIN_DIR/.tsc.log"
if ! npx tsc 2> "$TSC_LOG"; then
    echo "  tsc emitted errors. See $TSC_LOG"
else
    rm -f "$TSC_LOG"
    echo "  Build complete"
fi

echo "Registering plugin with OpenClaw..."
openclaw plugins install --link --force "$PLUGIN_DIR"

echo "Enabling XMPP entry..."
openclaw config set plugins.entries.xmpp.enabled true || true

echo "Enabling groupchat reply delivery..."
openclaw config set messages.groupChat.visibleReplies automatic || true

echo ""
echo "============================================"
echo " Install complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Configure your XMPP account (if not already set):"
echo "     openclaw config set channels.xmpp.accounts.default.service 'xmpp://your-server:5222'"
echo "     openclaw config set channels.xmpp.accounts.default.domain 'your-domain'"
echo "     openclaw config set channels.xmpp.accounts.default.jid 'user@domain'"
echo "     openclaw config set channels.xmpp.accounts.default.password 'your-password'"
echo "     openclaw config set channels.xmpp.accounts.default.dataDir '$PLUGIN_DIR/data'"
echo "     openclaw config set channels.xmpp.accounts.default.enabled true"
echo ""
echo "  2. Encrypt your password (recommended):"
echo "     openclaw xmpp encrypt-password"
echo ""
echo "  3. Restart the gateway:"
echo "     openclaw gateway restart"
echo ""
echo "  4. Whitelist contacts:"
echo "     openclaw xmpp add user@domain.com"
