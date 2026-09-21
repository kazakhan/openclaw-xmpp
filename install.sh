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

# SECURITY (2.18.2): remove in-tree backup/trash dirs BEFORE install.  OpenClaw
# captures plugin source by walking the extension dir; a stale `_backups/`
# snapshot can fail the plugin load.  Runs outside the plugin load, so it
# repairs a plugin that currently fails to load.
for backup_name in _backups _trash; do
    if [ -e "$PLUGIN_DIR/$backup_name" ]; then
        echo "Removing in-tree $backup_name (can break plugin loading)..."
        rm -rf "$PLUGIN_DIR/$backup_name"
    fi
done

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
#openclaw plugins install --link --force "$PLUGIN_DIR"
openclaw plugins install --link "$PLUGIN_DIR"

echo "Enabling XMPP entry..."
openclaw config set plugins.entries.xmpp.enabled true || true

echo "Enabling groupchat reply delivery..."
openclaw config set messages.groupChat.visibleReplies automatic || true

# SECURITY (2.18.1): the plugin needs the conversation hooks
# (before_agent_run/agent_end) for presence auto-activity.
echo "Enabling conversation hooks..."
openclaw config set plugins.entries.xmpp.hooks.allowConversationAccess true || true

# SECURITY (2.18.0): no mention-only toggles.  The plugin dispatches every room
# message through OpenClaw's channel inbound runner; the agent decides whether
# to reply.

echo ""
echo "============================================"
echo " Running interactive onboarding..."
echo "============================================"
echo ""
echo "You will be asked for your server, JID, and password."
echo "The password is encrypted and stored as an ENC: secret."
echo ""
openclaw xmpp setup || {
  echo ""
  echo "  WARNING: interactive onboarding did not complete."
  echo "  You can run it later with: openclaw xmpp setup"
}

echo ""
echo "============================================"
echo " Install complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Restart the gateway:"
echo "     openclaw gateway restart"
echo ""
echo "  2. Whitelist contacts:"
echo "     openclaw xmpp add user@domain.com"
echo ""
