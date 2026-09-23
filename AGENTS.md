# AGENTS.md — OpenClaw XMPP plugin

Instructions for agents working in this repository (`~/.openclaw/extensions/xmpp`).

## Project

OpenClaw XMPP channel plugin. Source in `src/` and `index.ts`; compiled output in
`dist/` (git-ignored; the gateway loads `dist/`). GitHub:
`https://github.com/kazakhan/openclaw-xmpp` (branch `main`).

## Build & test

```bash
npm install                    # installs esbuild (devDependency)
node scripts/build.mjs         # tsc + esbuild bundle -> dist/
node --test tests/*.test.ts    # test suite
npm run typecheck              # tsc --noEmit
```

- **Build:** `node scripts/build.mjs` (or `npm run build`). It runs `tsc` (which
  must resolve `openclaw/plugin-sdk/*`, needing `moduleResolution: "bundler"`
  and the `node_modules/openclaw` symlink from `scripts/link-openclaw-sdk.mjs` /
  `ensureSdkLink()`), then bundles each entry with esbuild. **Keep the bundle:**
  OpenClaw 2026.9.5+ captures plugin source by parsing the whole module graph, so
  an unbundled `dist` drags `typebox`/`@xmpp` through it and the gateway startup
  times out. Externals: `openclaw`, `openclaw/*`, `@openclaw/*`, `ssh2`,
  `cpu-features`. Bundling is best-effort (falls back to plain `tsc` output).
  `noEmitOnError: false` still lets `tsc` emit on type-only errors.
  - **2.18.6:** the bundle **must** carry the esbuild `createRequire` banner, or
    the ESM output throws `Dynamic require of "events" is not supported` (2.18.5
    shipped exactly that and failed to load everywhere). The build now verifies
    every bundle has the banner and only then swaps it in (two-phase, because
    `src/outbound.ts` imports `../index.js`; swapping as you go duplicates the
    banner). A bundle that fails verification is discarded.
  - **2.18.6:** `@xmpp/client` + `typebox` are **devDependencies** (inlined, not
    captured); `ssh2` stays the only runtime dependency. The installers/updater
    run `npm prune --omit=dev` after building (or pass `OPENCLAW_XMPP_PRUNE=1` to
    `scripts/build.mjs`), and the build clears stale `openclaw-plugin-build-*`
    temp dirs (`scripts/clean-plugin-build-temp.mjs`). Env overrides:
    `OPENCLAW_XMPP_PRUNE=1`, `OPENCLAW_XMPP_SKIP_TEMP_CLEAN=1`,
    `OPENCLAW_XMPP_TEMP_GRACE_MS`. Bundling alone did not shrink the capture —
    the prune is what drops it from ~12k files/40 MB to ~482 files/7.9 MB.
- **Test:** `node --test tests/*.test.ts` (Node's built-in runner, TS type-stripping).
- **Known pre-existing failures** (do NOT "fix" unless asked): the whole-file
  import suites `tests/encryption.test.ts`, `rate-limit.test.ts`,
  `store.test.ts`, `unit.test.ts` (they import `../src/...js` which does not
  resolve under `node --test`), the stale `liveness`/diagnostics tests
  (L2/L3/L10/M1), and the hard-coded `v2.1.5` version tests.
- **`tsc` is clean (0 errors)** as of 2.17.1: `module: ESNext` +
  `moduleResolution: bundler` fix the `openclaw/plugin-sdk/*` TS2307, the tool
  `execute` params are typed, and the by-construction `src/gateway.ts` TS2367 is
  suppressed with a scoped `@ts-expect-error` (the pass-through expression is
  pinned by `tests/high-severity.test.ts` H9).
- Tests that load real modules are only reliable for dependency-free files
  (e.g. `src/presence.ts`, `src/lib/json-extract.ts`). Most suites are
  source-level (read the file and assert patterns).

## Conventions

- **Back up every file you edit** to
  `~/.openclaw/_backups/xmpp/<version>_<timestamp>/` before editing (e.g.
  `~/.openclaw/_backups/xmpp/2.18.1_20260921_100807/`).  **Never** put backups
  inside the extension directory: OpenClaw captures plugin source by walking it,
  and an in-tree `_backups/` dir can contain a Windows reserved device entry
  (`nul`) that fails the whole plugin load.  `openclaw xmpp doctor --fix` removes
  any stale in-tree backups.  Because the plugin cannot self-heal (it fails
  before loading), the pre-load repair lives outside it: the `postinstall`
  script `scripts/purge-in-tree-backups.mjs` and the `install.*` scripts purge
  in-tree `_backups`/`_trash` + reserved-name entries.
- **CHANGELOG.md**: add a new entry **at the top** and bump `package.json`;
  never edit previous entries.
- Do not commit `dist/` (git-ignored). Rebuild it locally.
- Prefer editing existing files; keep security comments (`SECURITY (x.y.z):`)
  in place.

## Release checklist (run for EVERY release)

1. Back up all files to be edited to
   `~/.openclaw/_backups/xmpp/<version>_<timestamp>/` (never in-tree).
2. Update `CHANGELOG.md` (new top entry); bump `package.json` version.
3. **Verify `README.md` is current** — Status/version, feature highlights, the
   command lists (CLI + slash), config examples, and File Layout must match the
   code. `tests/readme.test.ts` enforces this and will fail if stale.
4. **Verify `XMPPAUDIT.md`** if XEP support changed.
5. `node scripts/build.mjs` (expect a clean build; verify `dist/index.js` only
   imports `openclaw/*` and `ssh2`).
6. `node --test tests/*.test.ts` (expect only the pre-existing failures above).
7. Commit with a `type(version): summary` message (see `git log`).
8. Push and create a GitHub release using the token in `~/.bashrc`:
   ```bash
   TOKEN=$(grep 'GITHUB_KAZA_TOKEN' ~/.bashrc | tail -1 | sed -E 's/.*GITHUB_KAZA_TOKEN=//; s/^["'\'']//; s/["'\'']$//')
   git push "https://${TOKEN}@github.com/kazakhan/openclaw-xmpp.git" main
   # then POST to https://api.github.com/repos/kazakhan/openclaw-xmpp/releases
   ```
   Never print the token or store it in git config.

## Notes

- The gateway runs from `dist/`. On Linux restart with
  `systemctl --user restart openclaw-gateway`; on Windows the gateway is a
  Scheduled Task (use `openclaw gateway restart`, elevated).
- CLI commands (`openclaw xmpp …`) route through the running gateway's existing
  connection (in-process client or `openclaw/plugin-sdk/gateway-runtime`); do
  not open a second XMPP connection with the same JID+resource.
- Inbound dispatch uses OpenClaw's channel inbound runner
  (`runtime.channel.inbound.run`, i.e. `runChannelInboundEvent`) in
  `src/gateway.ts`. Do NOT reintroduce the deprecated
  `dispatchInboundReplyWithBase` shim, and do NOT add a plugin-side mention
  gate: `InboundEventKind` must come from `classifyChannelInboundEvent` +
  `resolveUnmentionedGroupInboundPolicy` (default `user_request`), so the
  **agent** decides whether to reply.
- Channel sends must return a real `messageId`/`MessageReceipt`
  (`src/outbound.ts`); an identityless result makes OpenClaw throw
  `No delivery result`.
- Never default a data path to `process.cwd()`: the Windows gateway runs as a
  scheduled task with cwd `C:\Windows\System32`.  The queue uses the account
  `dataDir` with `defaultQueueDir()` as a writable fallback (`src/queue-bridge.ts`).
- Non-bundled plugins need
  `plugins.entries.xmpp.hooks.allowConversationAccess=true` for the
  `before_agent_run`/`agent_end` conversation hooks (presence auto-activity);
  `openclaw xmpp setup` and `doctor --fix` set it.
- The updater must **not** leave the git repo in detached HEAD: check the
  release out with `git checkout -B main v<tag>` (`src/updater.ts`), or a later
  manual `git pull` fails with "You are not currently on a branch".
- A root-level `nul` (or any reserved-name entry) in the extension dir breaks
  plugin source capture; `scripts/purge-in-tree-backups.mjs`, the installers,
  and `doctor --fix` remove them (using `\\?\` paths on Windows).
- Group replies must be **optional**: OpenClaw requires an explicit
  `surfaces.xmpp.silentReply.group="allow"` opt-in, otherwise every accepted
  room message requires a reply and bots loop.  Set on setup, `doctor --fix`,
  the installers, and the config migration registered in `index.ts`.  Do not
  reintroduce a plugin-side mention gate for this.
