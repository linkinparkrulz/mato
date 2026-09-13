#!/usr/bin/env node
// =============================================================================
// Gateway self-test.
//
// The derivation tests here are the most important in the project: a bug in
// derive.ts sends a customer's payment to an address nobody can spend, and
// nothing downstream would notice. So they assert against the BIP47
// specification's own Alice/Bob vectors, never against our implementation's
// output — a test that compares the code to itself passes just as happily when
// the code is wrong.
//
//   node gateway/selftest.mjs
// =============================================================================
import assert from "node:assert/strict";
import * as bip39 from "bip39";
import {
  storeIdentity, publicCode, addressFor, spendingKeyFor,
  addressOfPubkey, pubkeyOf, DEFAULT_ADDRESS_TYPE,
} from "./derive.ts";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

// ---- BIP47 specification test vectors ---------------------------------------
// Alice is the SENDER (our store). Bob is the RECEIVER (the operator's personal
// wallet). Bob's payment addresses are what the specification publishes, and
// they are what a customer would be asked to pay.
const ALICE_MNEMONIC = "response seminar brave tip suit recall often sound stick owner lottery motion";
const BOB_MNEMONIC = "reward upper indicate eight swift arch injury crystal super wrestle already dentist";

const ALICE_CODE = "PM8TJTLJbPRGxSbc8EJi42Wrr6QbNSaSSVJ5Y3E4pbCYiTHUskHg13935Ubb7q8tx9GVbh2UuRnBc3WSyJHhUrw8KhprKnn9eDznYGieTzFcwQRya4GA";
const BOB_CODE = "PM8TJS2JxQ5ztXUpBBRnpTbcUXbUHy2T1abfrb3KkAAtMEGNbey4oumH7Hc578WgQJhPjBxteQ5GHHToTYHE3A1w6p7tU6KSoFmWBVbFGjKPisZDbP97";
const BOB_NOTIFICATION = "1ChvUUvht2hUQufHBXF8NgLhW8SwE2ecGV";

// Bob's receiving addresses 0..9 when Alice pays him. From the BIP47 text.
const BOB_PAYMENT_ADDRESSES = [
  "141fi7TY3h936vRUKh1qfUZr8rSBuYbVBK", "12u3Uued2fuko2nY4SoSFGCoGLCBUGPkk6",
  "1FsBVhT5dQutGwaPePTYMe5qvYqqjxyftc", "1CZAmrbKL6fJ7wUxb99aETwXhcGeG3CpeA",
  "1KQvRShk6NqPfpr4Ehd53XUhpemBXtJPTL", "1KsLV2F47JAe6f8RtwzfqhjVa8mZEnTM7t",
  "1DdK9TknVwvBrJe7urqFmaxEtGF2TMWxzD", "16DpovNuhQJH7JUSZQFLBQgQYS4QB9Wy8e",
  "17qK2RPGZMDcci2BLQ6Ry2PDGJErrNojT5", "1GxfdfP286uE24qLZ9YRP3EWk2urqXgC4s",
];

const aliceSeed = bip39.mnemonicToSeedSync(ALICE_MNEMONIC);
const bobSeed = bip39.mnemonicToSeedSync(BOB_MNEMONIC);
const store = storeIdentity(aliceSeed);      // the store: sender, holds a key that cannot spend
const personal = storeIdentity(bobSeed);     // the operator's personal wallet: receiver

console.log("\nBIP47 specification vectors");

test("the store's payment code matches the published Alice code", () => {
  assert.equal(store.toBase58(), ALICE_CODE);
});

test("the personal payment code matches the published Bob code", () => {
  assert.equal(personal.toBase58(), BOB_CODE);
});

test("the personal notification address matches the published one", () => {
  assert.equal(personal.getNotificationAddress(), BOB_NOTIFICATION);
});

test("invoice addresses 0..9 match the published payment addresses", () => {
  for (let i = 0; i < BOB_PAYMENT_ADDRESSES.length; i++) {
    assert.equal(addressFor(store, BOB_CODE, i), BOB_PAYMENT_ADDRESSES[i], `index ${i}`);
  }
});

test("the default address type is the legacy, universally-scanned one", () => {
  assert.equal(DEFAULT_ADDRESS_TYPE, "p2pkh");
});

// ---- the property the whole design promises ---------------------------------
// Matching a vector proves we derive the same string as the specification. It
// does NOT prove the operator can spend what arrives there. This does.
console.log("\nSpendability");

test("the personal wallet holds the spending key for every derived address", () => {
  for (const type of ["p2pkh", "p2wpkh"]) {
    for (let i = 0; i < 5; i++) {
      const invoice = addressFor(store, BOB_CODE, i, type);
      const key = spendingKeyFor(personal, ALICE_CODE, i);
      assert.equal(addressOfPubkey(pubkeyOf(key), type), invoice, `${type} index ${i}`);
    }
  }
});

test("the store cannot spend what it derives", () => {
  // The store's own key derives a DIFFERENT address set. If the store's chain
  // ever produced an invoice address, the store could sweep its own customers'
  // payments — so assert the two sets are disjoint rather than merely unequal.
  const invoices = new Set();
  for (let i = 0; i < 20; i++) invoices.add(addressFor(store, BOB_CODE, i));
  for (let i = 0; i < 20; i++) {
    const storeChain = publicCode(ALICE_CODE).getPaymentAddress(personal, i, "p2pkh");
    assert.ok(!invoices.has(storeChain), `store-chain address ${storeChain} appeared in the invoice set`);
  }
});

// ---- the trap in derive.ts's header -----------------------------------------
console.log("\nDerivation direction");

test("calling on the wrong side yields a different, wrong-chain address", () => {
  // This is the mistake derive.ts exists to make unrepeatable. It does not
  // throw and the result is a perfectly valid address; it simply belongs to the
  // store's chain, where the operator's wallet will never look. Asserting the
  // inequality keeps the distinction visible to anyone refactoring.
  const right = addressFor(store, BOB_CODE, 0);
  const wrong = publicCode(ALICE_CODE).getPaymentAddress(personal, 0, "p2pkh");
  assert.notEqual(right, wrong);
  assert.equal(right, BOB_PAYMENT_ADDRESSES[0]);
});

test("both library call directions agree when the receiver is the same", () => {
  // Whoever holds the private key, the address lands on `this`'s chain. Proving
  // it here is what licenses derive.ts to use whichever side has the key.
  const viaPublic = publicCode(BOB_CODE).getPaymentAddress(store, 3, "p2pkh");
  const viaPrivate = personal.getPaymentAddress(publicCode(ALICE_CODE), 3, "p2pkh");
  assert.equal(viaPublic, viaPrivate);
  assert.equal(viaPublic, BOB_PAYMENT_ADDRESSES[3]);
});

// ---- input handling ----------------------------------------------------------
console.log("\nInput handling");

test("a negative or fractional index is refused rather than coerced", () => {
  assert.throws(() => addressFor(store, BOB_CODE, -1), /non-negative integer/);
  assert.throws(() => addressFor(store, BOB_CODE, 1.5), /non-negative integer/);
});

test("a malformed payment code throws rather than returning an address", () => {
  assert.throws(() => addressFor(store, "not-a-payment-code", 0));
});

test("distinct indices give distinct addresses", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(addressFor(store, BOB_CODE, i));
  assert.equal(seen.size, 50);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
