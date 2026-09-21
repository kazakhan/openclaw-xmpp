import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const [xmppDir, stateDb, pluginId, pkgName, pkgVer, manifestHash, manifestPath] = process.argv.slice(2);

// SECURITY (2.18.2): remove in-tree backup/trash dirs.  OpenClaw captures plugin
// source by walking the extension dir; a Windows reserved device entry (e.g.
// `nul`) in an old `_backups/` snapshot fails the whole plugin load.  The \\?\
// prefix lets device names be deleted.
function purgeInTreeBackups(dir) {
  for (const name of ['_backups', '_trash']) {
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) continue;
    const candidates =
      process.platform === 'win32' ? ['\\\\?\\' + path.resolve(target), target] : [target];
    for (const candidate of candidates) {
      try {
        fs.rmSync(candidate, { recursive: true, force: true });
        console.log(`Removed in-tree ${name}: ${target}`);
        break;
      } catch {
        /* try the next form */
      }
    }
  }
}
purgeInTreeBackups(xmppDir);

const toPath = (p) => p.replaceAll('\\', '/');

const xmppDirPath  = toPath(xmppDir);
const stateDbPath  = toPath(stateDb);
const manifestNorm = toPath(manifestPath);

console.log('Opening:', stateDbPath);

const db = new DatabaseSync(stateDbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA busy_timeout=30000');

const row = db.prepare(
  'SELECT * FROM installed_plugin_index WHERE index_key = ?'
).get('installed-plugin-index');

if (!row) {
  console.error('ERROR: installed_plugin_index row not found');
  db.close();
  process.exit(1);
}

const installRecords = JSON.parse(row.install_records_json);
const plugins        = JSON.parse(row.plugins_json);
const diagnostics    = JSON.parse(row.diagnostics_json);

// 1. Merge install record
installRecords[pluginId] = {
  source: 'path',
  sourcePath: xmppDirPath,
  installPath: xmppDirPath,
  version: pkgVer
};

// 2. Merge plugins entry
const pluginEntry = {
  pluginId,
  packageName: pkgName,
  packageVersion: pkgVer,
  manifestPath: manifestNorm,
  manifestHash,
  rootDir: xmppDirPath,
  origin: 'global',
  enabled: true,
  startup: {
    sidecar: false,
    memory: false,
    deferConfiguredChannelFullLoadUntilAfterListen: false,
    agentHarnesses: []
  },
  compat: []
};

const existingIdx = plugins.findIndex(p => p.pluginId === pluginId);
if (existingIdx >= 0) {
  Object.assign(plugins[existingIdx], pluginEntry);
  console.log('Updated existing entry in plugins array');
} else {
  plugins.push(pluginEntry);
  console.log('Added new entry to plugins array');
}

// 3. Remove stale diagnostics about xmpp
const filteredDiags = diagnostics.filter(d =>
  !d.message?.includes(pluginId) &&
  !d.message?.includes('@openclaw/xmpp') &&
  !d.message?.includes('Package not found')
);

// 4. Write back
const stmt = db.prepare(
  'UPDATE installed_plugin_index SET install_records_json = ?, plugins_json = ?, diagnostics_json = ?, updated_at_ms = ? WHERE index_key = ?'
);

stmt.run(
  JSON.stringify(installRecords),
  JSON.stringify(plugins),
  JSON.stringify(filteredDiags),
  Date.now(),
  'installed-plugin-index'
);

// Checkpoint WAL to flush
db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
db.close();

console.log('');
console.log('SUCCESS:');
console.log('  install_records keys:', Object.keys(installRecords).join(', '));
console.log('  plugins:', plugins.map(p => p.pluginId).join(', '));
console.log('  diagnostics removed:', diagnostics.length - filteredDiags.length);
