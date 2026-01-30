# Molt XMPP Channel Plugin Functional Specification (Full Channel Version)

## 1. Overview

This plugin integrates XMPP as a **full Molt channel**, like Discord or Telegram. It supports 1:1 and multi-user chat (MUC), is loaded on agent startup, and allows admin-controlled whitelist management via slash commands. Messages from non-whitelisted users are logged but not relayed. Whitelist persists across restarts.

## 2. Plugin Structure

xmpp_channel/
- index.js            # Plugin registration & Molt channel interface
- config.json         # XMPP credentials + admins + optional initial whitelist
- storage.json        # Persistent runtime whitelist
- xmppClient.js       # XMPP connection + send/receive functions
- commands.js         # Slash command handlers for whitelist/admins

## 3. Channel Registration & Molt Integration

module.exports = {
  name: 'xmpp',
  description: 'XMPP channel for Molt',
  channels: ['xmpp'],
  onLoad: async (molt) => {
    const xmppClient = require('./xmppClient');
    const config = require('./config.json');
    await xmppClient.connect(molt, config);
    const commands = require('./commands');
    molt.registerSlashCommands(commands);
    molt.registerChannel('xmpp', {
      send: async (message) => {
        // Molt sends message via XMPP
        await xmppClient.sendMessage(message.to, message.text);
      }
    });
  },
};

## 4. XMPP Connection (xmppClient.js)

const { client, xml } = require('@xmpp/client');
const storage = require('./storage.json');
let xmpp;

async function connect(molt, config) {
  xmpp = client({ service: `xmpp://${config.xmpp.server}`, username: config.xmpp.jid, password: config.xmpp.password });

  xmpp.on('online', () => {
    console.log('XMPP connected');
  });

  xmpp.on('stanza', async stanza => {
    if (stanza.is('message') && stanza.getChildText('body')) {
      const from = stanza.attrs.from;
      const body = stanza.getChildText('body');

      if (storage.whitelist.includes(from)) {
        // Relay whitelisted messages to Molt
        molt.sendMessage('xmpp', { user: from, text: body });
      } else {
        console.log(`Non-whitelisted message from ${from}: ${body}`);
      }
    }
  });

  await xmpp.start();
}

async function sendMessage(to, body) {
  const msg = xml('message', { type: 'chat', to }, xml('body', {}, body));
  await xmpp.send(msg);
}

module.exports = { connect, sendMessage };

## 5. Slash Commands (commands.js)

const fs = require('fs');

function saveStorage() {
  fs.writeFileSync('./storage.json', JSON.stringify(storage, null, 2));
}

function isAdmin(jid) {
  const config = require('./config.json');
  return config.admins.includes(jid);
}

module.exports = [
  {
    name: 'whitelist-add',
    description: 'Add a JID to the whitelist',
    execute: async ({ args, user, molt }) => {
      if (!isAdmin(user)) return molt.reply('Permission denied');
      const jid = args[0];
      if (!storage.whitelist.includes(jid)) storage.whitelist.push(jid);
      saveStorage();
      molt.reply(`Added ${jid} to whitelist`);
    }
  },
  {
    name: 'whitelist-remove',
    description: 'Remove a JID from the whitelist',
    execute: async ({ args, user, molt }) => {
      if (!isAdmin(user)) return molt.reply('Permission denied');
      const jid = args[0];
      storage.whitelist = storage.whitelist.filter(j => j !== jid);
      saveStorage();
      molt.reply(`Removed ${jid} from whitelist`);
    }
  },
  {
    name: 'whitelist-list',
    description: 'List all whitelisted JIDs',
    execute: async ({ user, molt }) => {
      if (!isAdmin(user)) return molt.reply('Permission denied');
      molt.reply(`Whitelist: ${storage.whitelist.join(', ')}`);
    }
  }
];

## 6. Storage & Config

config.json:

{
  "xmpp": {
    "jid": "bot@domain.com",
    "password": "password",
    "server": "domain.com"
  },
  "admins": ["admin@domain.com"],
  "whitelist": ["trusteduser@domain.com"]
}

storage.json:

{
  "whitelist": ["trusteduser@domain.com"],
  "lastMessageTimestamps": {}
}

## 7. Logging

- Messages from non-whitelisted users are logged to console.
- Optional: save logs to a file or Molt log API.

## 8. Multi-User Chat (MUC)

- Automatically join rooms defined in config.
- Messages in MUC rooms checked against whitelist before relaying to Molt channel.

## 9. Future Extension Hooks

- Message Reactions / Media support (files, emojis, images)
- Dynamic Admin Management via slash commands
- Event hooks for message arrival or room join
- Optional encryption (OMEMO / end-to-end)

## 10. Summary Flow

1. Molt loads plugin as a channel.  
2. XMPP client connects.  
3. Incoming messages from whitelisted users → appear in Molt channel.  
4. Messages sent via Molt channel → delivered over XMPP.  
5. Admin slash commands manage whitelist/admins.  
6. Non-whitelisted messages → logged only.  

## 11. AI Implementation Notes

- Fully implement Molt channel API: `send`, `receive`.  
- Enforce whitelist for incoming messages.  
- Admin-only slash commands.  
- Persistent storage required.  
- Keep XMPP logic separate from Molt channel logic for maintainability.
