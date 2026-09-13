#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — audit stored signed pairing blocks.
//
// READ-ONLY. Walks every record in the submission store and re-checks its
// stored `signed` block with exactly the gate the submit endpoint uses
// (verifySignedPayload over canonicalPairing(payload), against the notification
// address of the record's own payment code). Nothing is written, no network is
// touched, and the store is only ever read.
//
// Why this exists: records approved before the signed-message parser was fixed
// were checked by a parser that excised the BIP47 tail before verifying, so the
// verdict they received then is not the verdict they would receive now. This
// tells you whether anything was left behind.
//
// Run on the box as the deploy user:
//     cd /var/www/dojobay/server && node audit-signed.mjs
// SERVER_DATA_DIR defaults to ./data, the same path the server uses; set it
// only if your store lives elsewhere.
//
// Buckets:
//   VERIFIED  the stored signature is valid for one of the record's codes
//   FAILED    a signature is present but verifies for none of them
//   UNSIGNED  no signature stored (pre-gate migration, or a code-less record)
//   ERROR     the record could not be evaluated at all
// Exits non-zero if anything is FAILED, ERROR or UNSIGNED, so it can back a
// cron check. UNSIGNED counted as a failure since the signature became a
// structural requirement: the store refuses to write such a record and the
// rebuild withholds it, so one showing up here is not awaiting a decision.
// =============================================================================
import { store } from "./store.ts";
import { verifySignedPayload, notificationAddresses, canonicalPairing } from "./crypto.ts";

const networkOf = (rec) => (rec.network === "testnet" ? "testnet" : "bitcoin");

// Exported so the test suite can assert this reproduces the gate's verdict.
// This MUST mirror server/index.mjs's signature gate exactly: same canonical
// message, and the same set of acceptable signing addresses. An earlier version
// derived the notification address for the record's own network, which meant
// every testnet listing was reported as failing even though the gate accepted
// it, because a PayNym signs from its mainnet address whatever the node is.
export function auditRecord(rec) {
  const codes = Array.isArray(rec.paymentCodes) ? rec.paymentCodes : [];
  if (!rec.signed) {
    return { bucket: "UNSIGNED", detail: codes.length ? "record has a payment code but no signed block" : "no signed block and no payment code" };
  }
  const net = networkOf(rec);
  const expectedMessage = canonicalPairing(rec.payload);
  const tried = [];
  // A PayNym may have signed with either BIP47 variant, so every code on the
  // record is a legitimate candidate; the first that verifies wins.
  for (const code of codes) {
    const addrs = notificationAddresses(code);
    if (!addrs.length) { tried.push(`${code.slice(0, 12)}…: undecodable code`); continue; }
    const r = verifySignedPayload({ signedText: rec.signed, expectedMessage, expectedAddress: addrs, network: net });
    if (r.ok) return { bucket: "VERIFIED", detail: `${code.slice(0, 12)}… → ${addrs[0]}` };
    tried.push(`${code.slice(0, 12)}… (${addrs.join(" / ")}): ${r.error}`);
  }
  if (!codes.length) {
    const r = verifySignedPayload({ signedText: rec.signed, expectedMessage, network: net });
    return r.ok
      ? { bucket: "FAILED", detail: "signature is internally valid but the record carries no payment code to bind it to" }
      : { bucket: "FAILED", detail: r.error };
  }
  return { bucket: "FAILED", detail: tried.join("\n           ") };
}

// ---- CLI ---------------------------------------------------------------
// Only runs when executed directly, so tests can import auditRecord.
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (!isMain) { /* imported for testing */ } else {

const recs = (await store.listSubmissions())
  .sort((a, b) => (a.network + a.name).localeCompare(b.network + b.name));

const buckets = { VERIFIED: [], FAILED: [], UNSIGNED: [], ERROR: [] };
for (const rec of recs) {
  let res;
  try { res = auditRecord(rec); } catch (e) { res = { bucket: "ERROR", detail: e.message }; }
  buckets[res.bucket].push({ rec, detail: res.detail });
}

console.log(`Audited ${recs.length} record(s) in the store.\n`);
for (const b of ["FAILED", "ERROR", "UNSIGNED", "VERIFIED"]) {
  if (!buckets[b].length) continue;
  console.log(`${b}: ${buckets[b].length}`);
  for (const { rec, detail } of buckets[b]) {
    // Show the name as well as the id. Ids are immutable (reliability history
    // keys on them), so a record created before operator naming keeps its
    // payment-code-derived id even after its operator sets a name, and the id
    // alone is then unrecognisable.
    const label = rec.name && `${rec.network}-${rec.name}` !== rec.id ? `${rec.id}  ("${rec.name}")` : rec.id;
    console.log(`  [${b}] ${label}  (${rec.status})${detail ? "\n           " + detail : ""}`);
  }
  console.log("");
}

// An UNSIGNED record is now a failure, not a decision. Until the signature rule
// existed there was a legitimate answer to "this record predates the gate" and
// the audit deliberately left the judgement to a maintainer. The store now
// refuses to write such a record and the rebuild withholds it, so one appearing
// here means something got in around those rules or predates them, and either
// way it is not being published and needs dealing with.
const bad = buckets.FAILED.length + buckets.ERROR.length + buckets.UNSIGNED.length;
console.log(
  `Summary: ${buckets.VERIFIED.length} verified, ${buckets.FAILED.length} failed, ` +
  `${buckets.UNSIGNED.length} unsigned, ${buckets.ERROR.length} error.` +
  (buckets.UNSIGNED.length ? "\nUNSIGNED records are withheld from the public list. Ask the operator to sign their\npairing payload and resubmit, or remove the listing with server/remove-listing.ts." : "") +
  (bad ? `\nNON-ZERO EXIT: ${bad} record(s) need attention.` : "\nEvery record carries a signature and every signature verifies under the current gate."));
process.exit(bad ? 1 : 0);
}
