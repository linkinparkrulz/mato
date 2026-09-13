#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — restore payload.pairing.version to the value that was signed.
//
// Some records have a stored pairing payload whose `version` was updated after
// the operator signed it (a Dojo upgrade, typically), so the published payload
// no longer matches the signature that attests to it. The version is purely
// informational and the live value is read from the node's X-Dojo-Version
// header on every probe, so the right correction is to put the payload back to
// what was signed and let the next signed submission move both together.
//
// STRICTLY LIMITED: this only ever writes payload.pairing.version, and only on
// records where the signed block and the stored payload are otherwise
// identical (key order and whitespace ignored). Anything else is reported and
// left alone.
//
// Usage, on the box:
//     cd /var/www/dojobay/server
//     node fix-payload-version.mjs             # dry run, changes nothing
//     sudo systemctl stop dojobay-server.service
//     node fix-payload-version.mjs --apply     # writes, after a backup
//     sudo systemctl start dojobay-server.service
//
// The stop/start matters: server/store.ts keeps the store in memory and is
// designed as a single writer, so editing store.json underneath a running
// server would be overwritten by its next session or nonce write. --apply
// refuses to run while the service is active unless you pass --force.
// =============================================================================
import { readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSignedBlock } from "./crypto.ts";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const DIR = process.env.SERVER_DATA_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");
const FILE = path.join(DIR, "store.json");

const stable = (v) => {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
};
// Everything except pairing.version, so we can prove that is the only difference.
const withoutVersion = (payload) => {
  const p = structuredClone(payload || {});
  if (p.pairing && typeof p.pairing === "object") delete p.pairing.version;
  return { pairing: p.pairing, explorer: p.explorer };
};

if (APPLY && !FORCE) {
  let active = "";
  try { active = execFileSync("systemctl", ["is-active", "dojobay-server.service"], { encoding: "utf8" }).trim(); } catch (e) { active = (e.stdout || "").trim(); }
  if (active === "active") {
    console.error("REFUSING: dojobay-server.service is running.\n" +
      "The store is held in memory by the server and would overwrite this edit.\n" +
      "  sudo systemctl stop dojobay-server.service\n" +
      "  node fix-payload-version.mjs --apply\n" +
      "  sudo systemctl start dojobay-server.service\n" +
      "(--force overrides this check, but do not use it on a live instance.)");
    process.exit(2);
  }
}

const raw = await readFile(FILE, "utf8");
const doc = JSON.parse(raw);
const recs = Object.values(doc.submissions || {}).sort((a, b) => a.id.localeCompare(b.id));

const planned = [];
const skipped = [];
for (const rec of recs) {
  if (!rec.signed) continue;
  const p = parseSignedBlock(rec.signed);
  if (!p) { skipped.push([rec.id, "signed block does not parse"]); continue; }
  let signedObj;
  try { signedObj = JSON.parse(p.pairingText); } catch { skipped.push([rec.id, "signed text is not a bare pairing JSON (extra content around it)"]); continue; }
  const sv = signedObj?.pairing?.version ?? null;
  const cv = rec.payload?.pairing?.version ?? null;
  if (sv === cv) continue;                                       // nothing to do
  if (stable(withoutVersion(signedObj)) !== stable(withoutVersion(rec.payload))) {
    skipped.push([rec.id, `differs beyond the version (signed ${JSON.stringify(sv)} vs stored ${JSON.stringify(cv)}), left alone`]);
    continue;
  }
  planned.push({ rec, from: cv, to: sv });
}

console.log(`Store: ${FILE}`);
console.log(`Records with a signed block: ${recs.filter((r) => r.signed).length}\n`);

if (planned.length) {
  console.log(`Version-only differences (${planned.length}) — payload.pairing.version will be set back to the signed value:`);
  for (const { rec, from, to } of planned) console.log(`  ${rec.id}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  console.log("");
}
if (skipped.length) {
  console.log(`Not touched (${skipped.length}):`);
  for (const [id, why] of skipped) console.log(`  ${id}: ${why}`);
  console.log("");
}
if (!planned.length) { console.log("Nothing to change."); process.exit(0); }

if (!APPLY) {
  console.log("DRY RUN — nothing written. Re-run with --apply (with the service stopped) to make these changes.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${FILE}.bak-${stamp}`;
await copyFile(FILE, backup);
for (const { rec, to } of planned) doc.submissions[rec.id].payload.pairing.version = to;
// A temporary name no other writer can take; see build-public.ts. One write per
// run, so the pid alone distinguishes it.
const tmp = `${FILE}.${process.pid}.tmp`;
await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n");
await rename(tmp, FILE);

console.log(`Backup written: ${backup}`);
console.log(`Applied ${planned.length} change(s).`);
console.log("Start the service again, then re-run audit-signed.mjs. The published\n" +
  "dojos.json picks the corrected payload up on the next updater cycle.");
