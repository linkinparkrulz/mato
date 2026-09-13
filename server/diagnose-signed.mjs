#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — diagnose signed-block mismatches.
//
// READ-ONLY. For every record whose stored block does not pass the gate, this
// answers the question the audit cannot: is the SIGNATURE bad, or is the stored
// payload merely a different representation of the same signed text?
//
// For each record it reports, in order:
//   1. INTERNAL VALIDITY - does the signature verify over the block's own text,
//      and does the BIP47 code inside that text derive the signing address?
//      If yes, the block is a genuine wallet export and nothing is forged.
//   2. MESSAGE MATCH - does the pairing JSON inside the block equal
//      canonicalPairing(stored payload) byte for byte? If not, it shows the
//      first differing offset with a window either side, and whether the two
//      are the same DATA in a different serialisation (key order, spacing) or
//      genuinely different values.
//
// Run on the box:  cd /var/www/dojobay/server && node diagnose-signed.mjs
// Add --all to include records that already pass.
// =============================================================================
import { store } from "./store.ts";
// canonicalPairing is imported, never reimplemented: a diagnostic that computes
// the canonical message its own way can only ever report on itself.
// server/selftest.mjs enforces the single definition.
import { parseSignedBlock, verifySignedPayload, notificationAddresses, canonicalPairing } from "./crypto.ts";
import { bitcoinMessageFactory } from "@dojo-tools/bitcoinjs-message";
import * as bip47utils from "@dojo-tools/bip47/utils";
import ecc from "@bitcoinerlab/secp256k1";

const message = bitcoinMessageFactory(ecc);
const ALL = process.argv.includes("--all");
const netOf = (rec) => (rec.network === "testnet" ? "testnet" : "bitcoin");

// Same data, different serialisation? Compare parsed structures, not strings.
const deepEq = (a, b) => {
  try { return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b)); } catch { return false; }
};
const sortDeep = (v) => {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  }
  return v;
};

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
const window_ = (s, i) => JSON.stringify(s.slice(Math.max(0, i - 30), i + 30));

const recs = (await store.listSubmissions())
  .sort((a, b) => (a.network + a.name).localeCompare(b.network + b.name));

let genuine = 0, forged = 0, drifted = 0, reorder = 0;

for (const rec of recs) {
  if (!rec.signed) continue;
  const net = netOf(rec);
  const codes = Array.isArray(rec.paymentCodes) ? rec.paymentCodes : [];
  const canon = canonicalPairing(rec.payload);
  const passes = codes.some((c) => {
    try { return verifySignedPayload({ signedText: rec.signed, expectedMessage: canon, expectedAddress: notificationAddresses(c), network: net }).ok; }
    catch { return false; }
  });
  if (passes && !ALL) continue;

  const label = rec.name && `${rec.network}-${rec.name}` !== rec.id ? `${rec.id}  ("${rec.name}")` : rec.id;
  console.log(`\n=== ${label}  (${rec.status})${passes ? "  [currently passes]" : ""}`);
  const p = parseSignedBlock(rec.signed);
  if (!p) { console.log("  block does not parse at all"); continue; }

  // 1. internal validity
  let sigOk = false;
  try { sigOk = message.verify(p.message, p.address, p.signature, bip47utils.networks[net].messagePrefix); } catch (e) { console.log("  verify threw:", e.message); }
  // A PayNym signs from its mainnet notification address whatever network the
  // node is on, so both derivations are legitimate.
  let derived = null;
  try { derived = p.paymentCode ? notificationAddresses(p.paymentCode) : null; } catch { derived = null; }
  const bound = Array.isArray(derived) && derived.includes(p.address);
  const derivedTxt = Array.isArray(derived) ? derived.join(" / ") : "(undecodable)";
  console.log(`  signature over the block's own text : ${sigOk ? "VALID" : "INVALID"}`);
  console.log(`  signing address                     : ${p.address}`);
  console.log(`  BIP47 code inside the signed text   : ${p.paymentCode ? p.paymentCode.slice(0, 12) + "…" : "(none)"} -> ${p.paymentCode ? derivedTxt : "n/a"} ${p.paymentCode ? (bound ? "(binds)" : "(DOES NOT BIND)") : ""}`);
  console.log(`  record's payment code(s)            : ${codes.map((c) => c.slice(0, 12) + "…").join(", ") || "(none)"}`);
  if (sigOk && bound) genuine++; else forged++;

  // 2. message match
  if (p.pairingText === canon) { console.log("  pairing text matches the stored payload exactly"); continue; }
  const i = firstDiff(p.pairingText, canon);
  let signedObj, storedObj;
  try { signedObj = JSON.parse(p.pairingText); } catch {}
  try { storedObj = JSON.parse(canon); } catch {}
  const same = signedObj && storedObj && deepEq(signedObj, storedObj);
  if (same) reorder++; else drifted++;
  console.log(`  pairing text DIFFERS from the stored payload`);
  console.log(`    same data, different serialisation? ${same ? "YES - key order/spacing only" : "NO - the values themselves differ"}`);
  console.log(`    lengths: signed ${p.pairingText.length}, stored ${canon.length}; first difference at offset ${i}`);
  console.log(`    signed: ${window_(p.pairingText, i)}`);
  console.log(`    stored: ${window_(canon, i)}`);
  if (!same && signedObj && storedObj) {
    const keys = new Set([...Object.keys(signedObj), ...Object.keys(storedObj)]);
    for (const k of keys) {
      if (JSON.stringify(sortDeep(signedObj[k])) !== JSON.stringify(sortDeep(storedObj[k]))) {
        console.log(`    top-level key "${k}" differs:`);
        console.log(`      signed: ${JSON.stringify(signedObj[k])}`);
        console.log(`      stored: ${JSON.stringify(storedObj[k])}`);
      }
    }
  }
}

console.log(`\nSummary of blocks examined: ${genuine} genuine (valid signature, code binds), ${forged} not genuine.`);
console.log(`Mismatches: ${reorder} serialisation-only, ${drifted} with genuinely different values.`);
console.log(genuine && !forged
  ? "\nEvery block examined is a real wallet export; the failures are a stored-payload representation problem, not a trust problem."
  : "");
