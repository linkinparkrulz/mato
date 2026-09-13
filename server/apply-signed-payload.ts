#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — apply operator-signed pairing payload updates.
//
// Takes signed blocks an operator has sent out of band (a re-signed pairing
// payload, a new apikey, a moved onion) and applies them to the store, doing
// exactly what the submission gate would have done had they gone through the
// site:
//
//   1. the block must parse, and its signature must be valid over its own text;
//   2. the BIP47 code inside the signed text must derive the signing address;
//   3. that code must already own a record here, which is how the update is
//      matched to a listing;
//   4. the payload written is the one INSIDE the signed block, so what is
//      published is exactly what the operator attested to.
//
// The record's id is never changed, so its reliability history survives. Status
// is left alone: an approved listing stays approved, a pending one stays pending.
//
// Usage, on the box:
//     cd /var/www/dojobay/server
//     node apply-signed-payload.ts blocks/*.txt              # dry run
//     sudo systemctl stop dojobay-server.service
//     node apply-signed-payload.ts --apply blocks/*.txt
//     sudo systemctl start dojobay-server.service
//     node audit-signed.mjs
//
// Each file holds one signed block. `--id <record-id>` pins the target when a
// payment code owns more than one listing. As with fix-payload-version, --apply
// refuses to run while the service is up, because store.ts holds the store in
// memory as a single writer and would overwrite the edit.
// =============================================================================
import { readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
// canonicalPairing is imported, never reimplemented: this tool must accept
// exactly what the submission gate accepts, and a second definition of the
// canonical message would diverge silently. server/selftest.mjs enforces it.
import { parseSignedBlock, verifySignedPayload, notificationAddresses, repairSignedBlock, canonicalPairing } from "./crypto.ts";
import type { StoreRecord } from "../types.js";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const FORCE = argv.includes("--force");
const idFlag = argv.indexOf("--id");
const PINNED_ID = idFlag >= 0 ? argv[idFlag + 1] : null;
const FILES = argv.filter((a, i) =>
  !a.startsWith("--") && !(idFlag >= 0 && i === idFlag + 1));

const DIR = process.env.SERVER_DATA_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");
const FILE = path.join(DIR, "store.json");

if (!FILES.length) {
  console.error("Usage: node apply-signed-payload.ts [--apply] [--id <record-id>] <file>…\n" +
    "Each file contains one BEGIN BITCOIN SIGNED MESSAGE block.");
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
      "  node apply-signed-payload.ts --apply <files…>\n" +
      "  sudo systemctl start dojobay-server.service");
    process.exit(2);
  }
}

const doc = JSON.parse(await readFile(FILE, "utf8"));
const records: StoreRecord[] = Object.values(doc.submissions || {});

interface Planned { file: string; rec: StoreRecord; payload: any; signed: string; before: string; after: string; note: string | null }
const planned: Planned[] = [];
const refused: [string, string][] = [];

for (const file of FILES) {
  let signed: string;
  try { signed = await readFile(file, "utf8"); }
  catch (e: any) { refused.push([file, "cannot read: " + e.message]); continue; }

  // Copying a block through chat, a form or a mail client routinely eats the
  // blank line before the BIP47 line, which the signature covers. Repair it if
  // a reconstruction verifies cryptographically; nothing is taken on trust.
  let note: string | null = null;
  const repaired = repairSignedBlock(signed);
  if (repaired) { signed = repaired.block; note = repaired.note; }

  const parsed = parseSignedBlock(signed);
  if (!parsed) { refused.push([file, "not a recognisable signed block"]); continue; }
  if (!parsed.paymentCode) { refused.push([file, "the signed text has no BIP47 line, so it cannot be matched to an operator"]); continue; }

  // The payload published is the one inside the signed block, never a
  // hand-copied version of it.
  let payload: any;
  try { payload = JSON.parse(parsed.pairingText); }
  catch { refused.push([file, "the signed text is not a bare pairing JSON"]); continue; }
  if (!payload?.pairing?.url || !payload?.pairing?.type) {
    refused.push([file, "the signed payload has no pairing.url/type"]); continue;
  }

  const addrs = notificationAddresses(parsed.paymentCode);
  const v = verifySignedPayload({
    signedText: signed,
    expectedMessage: canonicalPairing(payload),
    expectedAddress: addrs,
  });
  if (!v.ok) { refused.push([file, v.error]); continue; }

  const owned = records.filter((r) => (r.paymentCodes || []).includes(parsed.paymentCode!));
  const target = PINNED_ID ? owned.find((r) => r.id === PINNED_ID) : (owned.length === 1 ? owned[0] : undefined);
  if (!owned.length) {
    refused.push([file, `signature is valid, but ${parsed.paymentCode.slice(0, 12)}… owns no record here`]); continue;
  }
  if (!target) {
    refused.push([file, `that code owns ${owned.length} records (${owned.map((r) => r.id).join(", ")}); re-run with --id`]); continue;
  }

  planned.push({
    file, rec: target, payload, signed: signed.trim(), note,
    before: target.payload?.pairing?.url || "(none)",
    after: payload.pairing.url,
  });
}

console.log(`Store: ${FILE}`);
console.log(`Blocks read: ${FILES.length}\n`);

if (planned.length) {
  console.log(`Will update (${planned.length}):`);
  for (const p of planned) {
    console.log(`  ${p.rec.id}  (${p.rec.status})   from ${path.basename(p.file)}`);
    console.log(`      url     ${p.before}`);
    console.log(`           -> ${p.after}`);
    const bv = p.rec.payload?.pairing?.version, av = p.payload.pairing.version;
    if (bv !== av) console.log(`      version ${bv || "(none)"} -> ${av || "(none)"}`);
    if (!p.rec.signed) console.log("      (record was UNSIGNED; it gains a verified signature)");
    if (p.note) console.log(`      note: ${p.note}, and the repaired block verifies`);
  }
  console.log("");
}
if (refused.length) {
  console.log(`Refused (${refused.length}):`);
  for (const [f, why] of refused) console.log(`  ${path.basename(f)}: ${why}`);
  console.log("");
}
if (!planned.length) { console.log("Nothing to apply."); process.exit(refused.length ? 1 : 0); }

if (!APPLY) {
  console.log("DRY RUN — nothing written. Re-run with --apply (service stopped) to make these changes.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${FILE}.bak-${stamp}`;
await copyFile(FILE, backup);
const nowIso = new Date().toISOString();
for (const p of planned) {
  const rec = doc.submissions[p.rec.id];
  rec.payload = p.payload;          // exactly what was signed
  rec.signed = p.signed;
  rec.updated_at = nowIso;
}
// A temporary name no other writer can take; see build-public.ts. This tool
// refuses to run while the service holds the store, so a collision needs two
// maintenance tools at once, which is exactly the case nobody plans for.
const tmp = `${FILE}.${process.pid}.tmp`;
await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n");
await rename(tmp, FILE);

console.log(`Backup written: ${backup}`);
console.log(`Applied ${planned.length} update(s).`);
console.log("Start the service again, then run audit-signed.mjs; each updated record\n" +
  "should now read VERIFIED. The published dojos.json follows on the next\n" +
  "updater cycle, or immediately if you run build-public.mjs.");
process.exit(refused.length ? 1 : 0);
