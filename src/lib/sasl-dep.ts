import fs from "fs";
import path from "path";
import { createRequire } from "module";

// SECURITY (2.15.5): `sasl-scram-sha-1` 1.4.0 changed its `response()` API to
// async (RESP.challenge is now an `async function` returning a Promise).
// `@xmpp/sasl` 0.13.x calls it synchronously and only encodes the result when
// `typeof resp === "string"`, so with 1.4.0 the SCRAM <response/> goes out
// EMPTY and strict servers (Prosody) reject it with `malformed-request`.
//
// package.json pins the compatible version via `overrides`, but an existing
// `node_modules` (installed before the pin) keeps the broken 1.4.0 until deps
// are reconciled.  This helper lets `doctor` detect it and `--fix` repair it.

export const REQUIRED_SASL_SCRAM_VERSION = "1.3.0";

export interface SaslDepInfo {
  installed: boolean;
  version?: string;
  compatible: boolean;
  reason?: string;
}

/**
 * Inspect the installed `sasl-scram-sha-1` and verify its `response()` is
 * synchronous (string-returning) at the challenge stage, as @xmpp/sasl 0.13.x
 * requires.  `pluginDir` is the plugin root (the directory containing
 * `node_modules`).
 */
export function inspectSaslScram(pluginDir: string): SaslDepInfo {
  const pkgPath = path.join(pluginDir, "node_modules", "sasl-scram-sha-1", "package.json");
  if (!fs.existsSync(pkgPath)) {
    return {
      installed: false,
      compatible: false,
      reason: "sasl-scram-sha-1 is not installed — run `npm install` in the plugin directory",
    };
  }

  let version: string | undefined;
  try {
    version = JSON.parse(fs.readFileSync(pkgPath, "utf8"))?.version;
  } catch {
    /* fall through to the behavioural check */
  }

  const versionOk = version === REQUIRED_SASL_SCRAM_VERSION;
  let compatible = versionOk;
  let reason: string | undefined = versionOk
    ? undefined
    : `sasl-scram-sha-1@${version ?? "unknown"} is not the pinned ${REQUIRED_SASL_SCRAM_VERSION}; SCRAM auth can fail with malformed-request`;

  // Behavioural check: drive the mechanism to the challenge stage and confirm
  // response() returns a string (1.4.0 returns a Promise).
  try {
    const requireFrom = createRequire(path.join(pluginDir, "package.json"));
    const Mechanism = requireFrom("sasl-scram-sha-1");
    const mech = new Mechanism();
    mech.response({ username: "probe", password: "probe" }); // client-first -> stage "challenge"
    mech.challenge("r=probe,s=cHJvYmU=,i=4096");
    const resp = mech.response({ username: "probe", password: "probe" });
    if (typeof resp !== "string") {
      compatible = false;
      const kind = resp && resp.constructor ? resp.constructor.name : typeof resp;
      reason = `sasl-scram-sha-1@${version ?? "unknown"} response() returns ${kind}, not a string (async API); @xmpp/sasl 0.13.x cannot use it`;
    }
  } catch (err: any) {
    compatible = false;
    reason = reason || `could not load sasl-scram-sha-1: ${err?.message || String(err)}`;
  }

  return { installed: true, version, compatible, reason };
}
