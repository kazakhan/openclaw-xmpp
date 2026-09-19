# AGENTS.md — OpenClaw XMPP plugin

Instructions for agents working in this repository (`~/.openclaw/extensions/xmpp`).

## Project

OpenClaw XMPP channel plugin. Source in `src/` and `index.ts`; compiled output in
`dist/` (git-ignored; the gateway loads `dist/`). GitHub:
`https://github.com/kazakhan/openclaw-xmpp` (branch `main`).

## Build & test

```bash
npx tsc                        # compile to dist/ (clean; 0 errors)
node --test tests/*.test.ts    # test suite
npm run typecheck              # tsc --noEmit
```

- **Build:** `npx tsc`. TypeScript must resolve `openclaw/plugin-sdk/*`, which
  needs `moduleResolution: "bundler"` (set in `tsconfig.json`) **and** the
  `node_modules/openclaw` symlink to the global OpenClaw install. The
  `postinstall` script (`scripts/link-openclaw-sdk.mjs`) creates it best-effort;
  the updater/onboarding also call `ensureSdkLink()`. Without the symlink the SDK
  types can't be found (TS2307). `noEmitOnError: false` still lets it emit.
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

- **Back up every file you edit** to `_backups/<version>_<timestamp>/` before
  editing (e.g. `_backups/2.15.2_20260915_000353/`).
- **CHANGELOG.md**: add a new entry **at the top** and bump `package.json`;
  never edit previous entries.
- Do not commit `dist/` (git-ignored). Rebuild it locally.
- Prefer editing existing files; keep security comments (`SECURITY (x.y.z):`)
  in place.

## Release checklist (run for EVERY release)

1. Back up all files to be edited to `_backups/<version>_<timestamp>/`.
2. Update `CHANGELOG.md` (new top entry); bump `package.json` version.
3. **Verify `README.md` is current** — Status/version, feature highlights, the
   command lists (CLI + slash), config examples, and File Layout must match the
   code. `tests/readme.test.ts` enforces this and will fail if stale.
4. **Verify `XMPPAUDIT.md`** if XEP support changed.
5. `npx tsc` (expect a clean build, 0 errors).
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
