#!/bin/bash
set -e

PLUGIN_DIR="${1:-$HOME/.openclaw/extensions/xmpp}"

echo "============================================"
echo " XMPP Plugin Installer for OpenClaw 2026.5+"
echo "============================================"

# Create directory if needed
mkdir -p "$PLUGIN_DIR"

# Clone if directory is empty
if [ ! -f "$PLUGIN_DIR/package.json" ]; then
    echo "Cloning repository..."
    git clone https://github.com/kazakhan/openclaw-xmpp.git "$PLUGIN_DIR"
fi

cd "$PLUGIN_DIR"

# Install npm dependencies
echo "Installing npm dependencies..."
npm install

# Remove old compiled JS (shadows .ts sources)
echo "Removing old compiled JS..."
rm -rf dist/

# Compile TypeScript (required by OpenClaw 2026.5.4+)
echo "Compiling TypeScript..."
npx tsc 2>/dev/null || echo "  (tsc warnings are expected)"

# Register plugin with OpenClaw
echo "Registering plugin with OpenClaw..."
openclaw plugins install --force "$PLUGIN_DIR"

# Enable groupchat reply delivery
echo "Enabling groupchat reply delivery..."
openclaw config set messages.groupChat.visibleReplies automatic 2>/dev/null || true

echo ""
echo "============================================"
echo " Install complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Configure your XMPP account:"
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
echo "  3. Start the gateway:"
echo "     openclaw gateway"
echo ""
echo "  4. Whitelist contacts:"
echo "     openclaw xmpp add user@domain.com"
