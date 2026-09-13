#!/usr/bin/env node
// =============================================================================
// Pre-signed address pool: the air-gapped alternative to running the daemon.
//
// The operator runs this on a machine that is never online, and carries the
// resulting file to the store by hand. The store then serves addresses from it
// without holding any key at all, which is the strongest version of the claim
// this project makes: a full compromise of the web server yields no ability to
// mint an address a customer would accept.
//
//   node pool.mjs --seed seed.json --personal PM8T… --count 500 --out pool.json
//   node pool.mjs --verify pool.json --expect PM8T…      (check one, offline)
//
// WHO SIGNS, and why it is not the personal wallet.
//
// The obvious arrangement is for the operator's personal wallet to sign the
// batch, since it is the cold key already on that machine. It is the wrong one.
// A signature is only checkable against the identity it was made with, so
// signing with the personal wallet would mean publishing the operator's
// PERSONAL payment code for customers to verify against — permanently linking
// their personal PayNym to this store, in public, which is precisely the
// exposure an onion store exists to avoid. It would also give the customer two
// different things to verify depending on which mode the store happens to run,
// for no gain.
//
// So the STORE key signs here too, offline. The customer's verification path is
// then identical in both modes — check against the store payment code in
// data/store.json — and the operator's personal code never leaves their own
// machine. What pool mode changes is not who signs but WHERE the key lives: on
// the air-gapped box, never on the server.
// =============================================================================
import { readFile, writeFile } from "node:fs/promises";
import { StoreIdentity, verifySignedAddress } from "./identity.ts";
import { addressFor, parseAddressType } from "./derive.ts";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Build a pool. Pure, so the self-test can exercise it without touching disk. */
export function buildPool(identity, personalCode, { start = 0, count = 100, type = "p2pkh" } = {}) {
  if (!Number.isInteger(start) || start < 0) throw new Error("--start must be a non-negative integer");
  if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a positive integer");
  const addressType = parseAddressType(type);
  const addresses = [];
  for (let i = start; i < start + count; i++) {
    addresses.push(identity.signAddress({
      v: 1,
      address: addressFor(identity.code, personalCode, i, addressType, identity.network),
      index: i,
      type: addressType,
      network: identity.network,
      paymentCode: identity.paymentCode(),
    }));
  }
  return {
    v: 1,
    paymentCode: identity.paymentCode(),
    type: addressType,
    network: identity.network,
    start,
    count,
    generated_at: new Date().toISOString(),
    addresses,
  };
}

/**
 * Re-check every record in a pool against the payment code the caller expects.
 *
 * Worth running on the online machine after copying a pool across, because the
 * failure it catches — a truncated or altered file — is otherwise discovered
 * one customer at a time. `expected` is required for the same reason
 * verifySignedAddress requires it: "these are signed" is not the question.
 */
export function verifyPool(pool, expectedPaymentCode) {
  const problems = [];
  if (!pool || pool.v !== 1) return { ok: false, checked: 0, problems: ["not a v1 pool file"] };
  if (pool.paymentCode !== expectedPaymentCode) {
    return { ok: false, checked: 0, problems: ["this pool was signed by a different store"] };
  }
  const seen = new Set();
  for (const rec of pool.addresses || []) {
    const v = verifySignedAddress(rec, expectedPaymentCode);
    if (!v.ok) problems.push(`index ${rec?.index}: ${v.error}`);
    if (seen.has(rec?.index)) problems.push(`index ${rec.index} appears twice`);
    seen.add(rec?.index);
  }
  return { ok: problems.length === 0, checked: (pool.addresses || []).length, problems };
}

// ---- CLI --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const verifyPath = arg("verify");
  if (verifyPath) {
    const expect = arg("expect");
    if (!expect) {
      console.error("--verify needs --expect <store payment code>: checking a signature\n" +
                    "without naming the identity it must belong to answers the wrong question.");
      process.exit(2);
    }
    const pool = JSON.parse(await readFile(verifyPath, "utf8"));
    const r = verifyPool(pool, expect);
    console.log(`checked ${r.checked} addresses`);
    for (const p of r.problems.slice(0, 20)) console.log(`  ${p}`);
    if (r.problems.length > 20) console.log(`  …and ${r.problems.length - 20} more`);
    console.log(r.ok ? "pool is good" : "POOL IS NOT USABLE");
    process.exit(r.ok ? 0 : 1);
  }

  const seedFile = arg("seed", "data/seed.json");
  const personal = arg("personal", process.env.PERSONAL_CODE);
  const out = arg("out", "pool.json");
  if (!personal) {
    console.error("--personal <payment code> is required: without it there is no chain to derive on.");
    process.exit(2);
  }
  const identity = await StoreIdentity.fromFile(seedFile);
  const pool = buildPool(identity, personal, {
    start: +arg("start", "0"),
    count: +arg("count", "100"),
    type: arg("type", "p2pkh"),
  });
  await writeFile(out, JSON.stringify(pool, null, 2) + "\n");
  console.log(`wrote ${pool.count} signed addresses to ${out}`);
  console.log(`  indices     ${pool.start}..${pool.start + pool.count - 1}`);
  console.log(`  store code  ${pool.paymentCode}`);
  console.log(`  first       ${pool.addresses[0].address}`);
  console.log(`\nCopy ${out} to the store. It contains no private key.`);
  console.log(`Check it there with:  node pool.mjs --verify ${out} --expect ${pool.paymentCode}`);
}
