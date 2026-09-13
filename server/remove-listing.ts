#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — remove a listing and its reliability history.
//
// Deleting a record through the API leaves its history behind: unlisting stamps
// it `retired` and keeps it for HISTORY_GRACE_DAYS so that a node relisted
// within the window resurrects its uptime intact. That is right for a node
// coming back, and wrong for one being removed deliberately. This removes both,
// now.
//
// Usage, on the box:
//     cd /var/www/dojobay/server
//     node remove-listing.ts <record-id>              # dry run
//     sudo systemctl stop dojobay-server.service
//     node remove-listing.ts --apply <record-id>
//     sudo systemctl start dojobay-server.service
//     node build-public.mjs
//
// As with the other write tools, --apply refuses to run while the service is
// up, because store.ts holds the store in memory as a single writer and would
// overwrite the edit. Both files are backed up first.
// =============================================================================
import { readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StoreRecord } from "../types.js";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const FORCE = argv.includes("--force");
const IDS = argv.filter((a) => !a.startsWith("--"));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = process.env.SERVER_DATA_DIR || path.join(HERE, "data");
const PUBLIC_DIR = process.env.PUBLIC_DATA_DIR || path.join(HERE, "..", "data");
const STORE = path.join(STORE_DIR, "store.json");
const HISTORY = ["history.json", "history-daily.json"].map((f) => path.join(PUBLIC_DIR, f));

if (!IDS.length) {
  console.error("Usage: node remove-listing.ts [--apply] <record-id>…\n" +
    "Record ids are shown by audit-signed.mjs, for example mainnet-kilombino.");
  process.exit(2);
}

if (APPLY && !FORCE) {
  let active = "";
  try { active = execFileSync("systemctl", ["is-active", "dojobay-server.service"], { encoding: "utf8" }).trim(); }
  catch (e: any) { active = (e.stdout || "").trim(); }
  if (active === "active") {
    console.error("REFUSING: dojobay-server.service is running.\n" +
      "The store is held in memory by the server and would overwrite this edit.\n" +
      "  sudo systemctl stop dojobay-server.service\n" +
      "  node remove-listing.ts --apply <record-id>\n" +
      "  sudo systemctl start dojobay-server.service");
    process.exit(2);
  }
}

const readJSON = async (p: string, fallback: any) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
};
// A temporary name no other writer can take; see build-public.ts. The counter
// matters as well as the pid, because one run rewrites both the store and the
// seed in quick succession.
let tmpSeq = 0;
const writeAtomic = async (p: string, doc: any) => {
  const tmp = `${p}.${process.pid}.${(tmpSeq = (tmpSeq + 1) % 1e6)}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n");
  await rename(tmp, p);
};

const store = await readJSON(STORE, { submissions: {} });
const found: StoreRecord[] = [];
const missing: string[] = [];
for (const id of IDS) {
  const rec = store.submissions?.[id];
  if (rec) found.push(rec); else missing.push(id);
}

console.log(`Store:   ${STORE}`);
console.log(`History: ${PUBLIC_DIR}\n`);

for (const rec of found) {
  const codes = (rec.paymentCodes || []).length;
  console.log(`  ${rec.id}  (${rec.status})`);
  console.log(`      name        ${rec.name || "(none)"}`);
  console.log(`      onion       ${rec.payload?.pairing?.url || "(none)"}`);
  console.log(`      codes       ${codes || "NONE — this listing has no owner"}`);
}
for (const id of missing) console.log(`  ${id}: not in the store`);
console.log("");

let histCounts: Record<string, number> = {};
for (const f of HISTORY) {
  const doc = await readJSON(f, { nodes: {} });
  histCounts[path.basename(f)] = IDS.filter((id) => doc.nodes && doc.nodes[id]).length;
}
console.log("History entries to remove: " +
  Object.entries(histCounts).map(([f, n]) => `${f}: ${n}`).join(", ") + "\n");

if (!found.length && !Object.values(histCounts).some(Boolean)) {
  console.log("Nothing to remove."); process.exit(missing.length ? 1 : 0);
}

if (!APPLY) {
  console.log("DRY RUN — nothing written. Re-run with --apply (service stopped) to remove.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await copyFile(STORE, `${STORE}.bak-${stamp}`);
for (const rec of found) delete store.submissions[rec.id];
await writeAtomic(STORE, store);
console.log(`Backup written: ${STORE}.bak-${stamp}`);

for (const f of HISTORY) {
  const doc = await readJSON(f, null);
  if (!doc || !doc.nodes) continue;
  let touched = false;
  for (const id of IDS) if (doc.nodes[id]) { delete doc.nodes[id]; touched = true; }
  if (!touched) continue;
  await copyFile(f, `${f}.bak-${stamp}`);
  await writeAtomic(f, doc);
  console.log(`Purged history from ${path.basename(f)} (backup alongside).`);
}

console.log(`\nRemoved ${found.length} listing(s). Start the service, then run\n` +
  "build-public.mjs to republish, and audit-signed.mjs to confirm the result.");
