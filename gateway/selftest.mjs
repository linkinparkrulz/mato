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
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import * as bip39 from "bip39";
import {
  storeIdentity, publicCode, addressFor, spendingKeyFor,
  addressOfPubkey, pubkeyOf, parseAddressType, DEFAULT_ADDRESS_TYPE,
} from "./derive.ts";
import { StoreIdentity, canonicalAddress, verifySignedAddress } from "./identity.ts";
import { IndexStore, RECLAIM_QUARANTINE_MS } from "./index-state.ts";
import { makeHandler, serve } from "./gateway.mjs";
import { buildPool, verifyPool } from "./pool.mjs";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
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
    // "p2pkh" explicitly: these are the addresses the BIP publishes. Inheriting
    // the default would stop this testing the specification and start it testing
    // whatever the default currently is.
    assert.equal(addressFor(store, BOB_CODE, i, "p2pkh"), BOB_PAYMENT_ADDRESSES[i], `index ${i}`);
  }
});

test("invoice addresses default to segwit, notification addresses never do", () => {
  assert.equal(DEFAULT_ADDRESS_TYPE, "p2wpkh");
  // Not a stylistic mismatch to tidy up later: BIP47 defines the notification
  // address as the P2PKH address of the notification key. A wallet looking for
  // a notification transaction looks there and nowhere else, so this one stays
  // legacy however the invoice default moves.
  assert.match(personal.toPaymentCodePublic().getNotificationAddress(), /^[13mn2]/);
  assert.equal(publicCode(BOB_CODE).getNotificationAddress(), BOB_NOTIFICATION);
});

// ---- the property the whole design promises ---------------------------------
// Matching a vector proves we derive the same string as the specification. It
// does NOT prove the operator can spend what arrives there. This does.
console.log("\nSpendability");

test("the personal wallet holds the spending key for every derived address", () => {
  for (const type of /** @type {const} */ (["p2pkh", "p2wpkh"])) {
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
  const right = addressFor(store, BOB_CODE, 0, "p2pkh");
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

test("an unknown address type is refused rather than defaulted", () => {
  // Falling back to the default would give the operator a chain their wallet
  // may not scan while they believe they chose the one it does, and the first
  // symptom would be a customer's payment nobody can see.
  assert.throws(() => parseAddressType("p2tr"), /unknown address type/);
  assert.throws(() => parseAddressType("P2PKH"), /unknown address type/);
  assert.equal(parseAddressType(""), DEFAULT_ADDRESS_TYPE);
  assert.equal(parseAddressType(undefined), DEFAULT_ADDRESS_TYPE);
  assert.equal(parseAddressType("p2wpkh"), "p2wpkh");
});

test("distinct indices give distinct addresses", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(addressFor(store, BOB_CODE, i));
  assert.equal(seen.size, 50);
});

// ---- the store's identity and its attestation -------------------------------
console.log("\nSigned addresses");

const storeId = StoreIdentity.fromMnemonic(ALICE_MNEMONIC);

test("a store identity loads from its mnemonic and matches the derivation module", () => {
  assert.equal(storeId.paymentCode(), ALICE_CODE);
  assert.equal(storeId.notificationAddress(), store.getNotificationAddress());
});

test("a nonsense mnemonic is refused rather than silently seeding a wrong chain", () => {
  assert.throws(() => StoreIdentity.fromMnemonic("not actually a mnemonic at all"), /valid BIP39/);
});

test("a signed address verifies against the store's payment code", () => {
  // Derived with the type the record declares. They have to agree: the
  // signature covers both, so a record claiming p2pkh while carrying a segwit
  // address is a lie the customer is asked to check an address against.
  const rec = storeId.signAddress({
    v: 1, address: addressFor(store, BOB_CODE, 0, "p2pkh"), index: 0,
    type: "p2pkh", network: "bitcoin", paymentCode: ALICE_CODE,
  });
  assert.equal(rec.address, BOB_PAYMENT_ADDRESSES[0]);
  assert.deepEqual(verifySignedAddress(rec, ALICE_CODE), { ok: true });
});

test("a segwit invoice signs and verifies the same way, being the default now", () => {
  const address = addressFor(store, BOB_CODE, 0);
  assert.match(address, /^bc1/, "the default is native segwit: " + address);
  assert.notEqual(address, BOB_PAYMENT_ADDRESSES[0], "a different chain from the legacy vector");
  const rec = storeId.signAddress({
    v: 1, address, index: 0, type: "p2wpkh", network: "bitcoin", paymentCode: ALICE_CODE,
  });
  assert.deepEqual(verifySignedAddress(rec, ALICE_CODE), { ok: true });
});

test("a record signed by a different store is refused", () => {
  // The attack this closes: a compromised web server hands the customer an
  // address signed by a key it controls. The customer checks against the
  // payment code they already know, so the substitution has to fail.
  const impostor = StoreIdentity.fromMnemonic(BOB_MNEMONIC);
  const rec = impostor.signAddress({
    v: 1, address: "1imposterAddress", index: 0,
    type: "p2pkh", network: "bitcoin", paymentCode: BOB_CODE,
  });
  const v = verifySignedAddress(rec, ALICE_CODE);
  assert.equal(v.ok, false);
  assert.match(v.error, /different store/);
});

test("tampering with any signed field breaks the signature", () => {
  const base = storeId.signAddress({
    v: 1, address: addressFor(store, BOB_CODE, 5), index: 5,
    type: "p2pkh", network: "bitcoin", paymentCode: ALICE_CODE,
  });
  for (const [field, value] of [["address", BOB_PAYMENT_ADDRESSES[6]], ["index", 6], ["type", "p2wpkh"]]) {
    const v = verifySignedAddress({ ...base, [field]: value }, ALICE_CODE);
    assert.equal(v.ok, false, `tampering with ${field} was accepted`);
  }
});

test("verifying without an expected payment code is refused, not assumed", () => {
  const rec = storeId.signAddress({
    v: 1, address: addressFor(store, BOB_CODE, 0), index: 0,
    type: "p2pkh", network: "bitcoin", paymentCode: ALICE_CODE,
  });
  assert.equal(verifySignedAddress(rec, "").ok, false);
});

test("the canonical message fixes key order regardless of object construction", () => {
  const a = /** @type {const} */ ({ v: 1, address: "x", index: 1, type: "p2pkh", network: "bitcoin", paymentCode: ALICE_CODE });
  const b = /** @type {const} */ ({ paymentCode: ALICE_CODE, network: "bitcoin", type: "p2pkh", index: 1, address: "x", v: 1 });
  assert.equal(canonicalAddress(a), canonicalAddress(b));
});

// ---- index allocation --------------------------------------------------------
console.log("\nIndex allocation");

const tmp = await mkdtemp(path.join(os.tmpdir(), "gw-selftest-"));

await testAsync("indices are handed out in order and never repeat", async () => {
  const ix = new IndexStore(path.join(tmp, "a"), "bitcoin");
  const got = [];
  for (let i = 0; i < 5; i++) got.push(await ix.allocate());
  assert.deepEqual(got, [0, 1, 2, 3, 4]);
  assert.equal((await ix.status()).issued, 5);
});

await testAsync("a released index is quarantined before it can be reissued", async () => {
  // Reissuing immediately is the cross-crediting bug: a customer paying an
  // expired invoice late would land on an address now held by another order.
  const ix = new IndexStore(path.join(tmp, "b"), "bitcoin");
  const first = await ix.allocate();
  assert.equal(await ix.release(first), true);
  assert.equal(await ix.allocate(), 1, "a freshly released index was reissued inside its quarantine");
  const later = Date.now() + RECLAIM_QUARANTINE_MS + 1000;
  assert.equal(await ix.allocate(later), first, "the index was not reissued after its quarantine");
});

await testAsync("releasing twice does not put an index in the free list twice", async () => {
  const ix = new IndexStore(path.join(tmp, "c"), "bitcoin");
  const idx = await ix.allocate();
  assert.equal(await ix.release(idx), true);
  assert.equal(await ix.release(idx), false, "a second release was accepted");
  const later = Date.now() + RECLAIM_QUARANTINE_MS + 1000;
  assert.equal(await ix.allocate(later), idx);
  assert.notEqual(await ix.allocate(later), idx, "the same index came back twice");
});

await testAsync("a settled index is never reissued", async () => {
  // It was paid. Reusing it would publish a link between two customers' orders.
  const ix = new IndexStore(path.join(tmp, "d"), "bitcoin");
  const idx = await ix.allocate();
  await ix.settle(idx);
  const later = Date.now() + RECLAIM_QUARANTINE_MS * 10;
  for (let i = 0; i < 5; i++) assert.notEqual(await ix.allocate(later), idx);
});

await testAsync("the counter survives a restart", async () => {
  const dir = path.join(tmp, "e");
  const first = new IndexStore(dir, "bitcoin");
  for (let i = 0; i < 3; i++) await first.allocate();
  const reopened = new IndexStore(dir, "bitcoin");
  assert.equal(await reopened.allocate(), 3, "a restart reissued an index it had already handed out");
});

// ---- the daemon, over a real socket ------------------------------------------
console.log("\nGateway daemon");

const sock = path.join(tmp, "gw.sock");
const handler = makeHandler({
  identity: storeId,
  personalCode: BOB_CODE,
  indexStore: new IndexStore(path.join(tmp, "daemon"), "bitcoin"),
  addressType: "p2pkh",
});
const server = await serve(handler, sock);

/** One request/response over the socket, the way the store server will do it. */
function rpc(req) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = "";
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) { c.end(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    c.on("error", reject);
  });
}

await testAsync("the daemon issues signed, verifiable, spendable addresses", async () => {
  const rec = await rpc({ op: "next" });
  assert.equal(rec.address, BOB_PAYMENT_ADDRESSES[rec.index]);
  assert.deepEqual(verifySignedAddress(rec, ALICE_CODE), { ok: true });
  const key = spendingKeyFor(personal, ALICE_CODE, rec.index);
  assert.equal(addressOfPubkey(pubkeyOf(key), "p2pkh"), rec.address);
});

await testAsync("consecutive requests never repeat an address", async () => {
  const seen = new Set();
  for (let i = 0; i < 6; i++) seen.add((await rpc({ op: "next" })).address);
  assert.equal(seen.size, 6);
});

await testAsync("peek derives without consuming an index", async () => {
  const before = await rpc({ op: "status" });
  const peeked = await rpc({ op: "peek", index: 0 });
  assert.equal(peeked.address, BOB_PAYMENT_ADDRESSES[0]);
  assert.deepEqual(verifySignedAddress(peeked, ALICE_CODE), { ok: true });
  assert.equal((await rpc({ op: "status" })).next, before.next);
});

await testAsync("status reports the identity a customer verifies against", async () => {
  const s = await rpc({ op: "status" });
  assert.equal(s.paymentCode, ALICE_CODE);
  assert.equal(s.notificationAddress, storeId.notificationAddress());
  assert.equal(s.personalCode, BOB_CODE);
});

await testAsync("an unknown op is refused rather than ignored", async () => {
  assert.match((await rpc({ op: "sweep-funds" })).error, /unknown op/);
});

await testAsync("malformed input does not take the daemon down", async () => {
  await new Promise((resolve) => {
    const c = net.connect(sock);
    c.on("connect", () => c.write("this is not json\n"));
    c.on("data", () => { c.end(); resolve(); });
  });
  assert.equal((await rpc({ op: "status" })).paymentCode, ALICE_CODE);
});

await testAsync("the socket is not readable by other accounts", async () => {
  // The socket's permissions are the whole access control; there is no
  // authentication inside the protocol.
  const mode = (await stat(sock)).mode & 0o777;
  assert.equal(mode, 0o600, `socket mode is ${mode.toString(8)}, expected 600`);
});

await testAsync("a gateway with no personal code refuses to start", async () => {
  // It would otherwise derive on a chain nobody owns, and every payment into it
  // would be unspendable by anyone.
  assert.throws(
    () => makeHandler({ identity: storeId, personalCode: "", indexStore: new IndexStore(path.join(tmp, "z"), "bitcoin") }),
    /chain nobody owns/,
  );
});

// ---- the air-gapped alternative ---------------------------------------------
console.log("\nPre-signed pool");

test("a pool's addresses match the live gateway's for the same indices", () => {
  // The two modes must be interchangeable: an operator moving between them
  // cannot have the address for index 7 change underneath an unpaid invoice.
  const pool = buildPool(storeId, BOB_CODE, { start: 0, count: 10 });
  for (const rec of pool.addresses) {
    assert.equal(rec.address, BOB_PAYMENT_ADDRESSES[rec.index], `index ${rec.index}`);
  }
});

test("every record in a pool verifies against the store payment code", () => {
  const pool = buildPool(storeId, BOB_CODE, { start: 0, count: 25 });
  assert.deepEqual(verifyPool(pool, ALICE_CODE), { ok: true, checked: 25, problems: [] });
});

test("a pool signed by another store is refused wholesale", () => {
  const impostor = StoreIdentity.fromMnemonic(BOB_MNEMONIC);
  const pool = buildPool(impostor, ALICE_CODE, { start: 0, count: 3 });
  assert.equal(verifyPool(pool, ALICE_CODE).ok, false);
});

test("a tampered pool entry is located rather than merely failing", () => {
  const pool = buildPool(storeId, BOB_CODE, { start: 0, count: 5 });
  pool.addresses[3].address = BOB_PAYMENT_ADDRESSES[4];
  const r = verifyPool(pool, ALICE_CODE);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /index 3/);
});

test("a pool starting at an offset covers exactly the indices it claims", () => {
  const pool = buildPool(storeId, BOB_CODE, { start: 100, count: 5 });
  assert.deepEqual(pool.addresses.map((a) => a.index), [100, 101, 102, 103, 104]);
  assert.equal(verifyPool(pool, ALICE_CODE).ok, true);
});

test("a nonsensical pool range is refused", () => {
  assert.throws(() => buildPool(storeId, BOB_CODE, { start: -1, count: 5 }), /--start/);
  assert.throws(() => buildPool(storeId, BOB_CODE, { start: 0, count: 0 }), /--count/);
});

// ---- index state is per chain -----------------------------------------------
console.log("\nper-network index state");
{
  const dir = await mkdtemp(path.join(os.tmpdir(), "mise-ix-net-"));
  const main = new IndexStore(dir, "bitcoin");
  const test = new IndexStore(dir, "testnet4");

  await testAsync("each chain writes its own file", async () => {
    await main.allocate();
    await test.allocate();
    assert.notEqual(main.file, test.file);
    assert.match(main.file, /index-state\.bitcoin\.json$/);
    assert.match(test.file, /index-state\.testnet4\.json$/);
    await stat(main.file);
    await stat(test.file);
  });

  await testAsync("an allocation on one chain does not advance the other", async () => {
    // Sharing a file would have testnet eating mainnet indices: the next real
    // customer gets an index the operator's wallet is not expecting, and the
    // gap-limit bookkeeping has been counting the wrong chain's traffic.
    const a = await main.allocate();
    const b = await main.allocate();
    const t = await test.allocate();
    assert.equal(b, a + 1, "mainnet advances by its own allocations");
    assert.ok(t < b, `testnet is on its own count, got ${t} against mainnet ${b}`);
  });

  await testAsync("a store must be told its network rather than guessing one", async () => {
    // @ts-expect-error deliberately omitted: this is the mistake being prevented
    assert.throws(() => new IndexStore(dir), /must be told its network/);
    assert.throws(() => new IndexStore(dir, ""), /must be told its network/);
  });

  await rm(dir, { recursive: true, force: true });
}

// ---- first-run identity -----------------------------------------------------
console.log("\nfirst-run identity");
{
  const {
    loadOrCreate, saveState, revealMnemonic, bindReceiver, setDojo, setActive,
    readiness, newMnemonic, NETWORKS, SEED_FILE, STATE_FILE,
  } = await import("./bootstrap.ts");
  const { readFile, writeFile } = await import("node:fs/promises");

  const dir = await mkdtemp(path.join(os.tmpdir(), "mise-identity-"));

  await testAsync("one seed yields an identity on every network, distinct on each", async () => {
    const { state, created } = await loadOrCreate(dir);
    assert.equal(created, true);
    assert.deepEqual(Object.keys(state.networks).sort(), [...NETWORKS].sort());
    const main = state.networks.bitcoin, tnet = state.networks.testnet4;
    assert.notEqual(main.paymentCode, tnet.paymentCode);
    assert.notEqual(main.notificationAddress, tnet.notificationAddress);
    // Encoded for their own chain: mainnet P2PKH starts 1, testnet m or n.
    assert.match(main.notificationAddress, /^1/);
    assert.match(tnet.notificationAddress, /^[mn]/);
    assert.equal(state.active, "bitcoin");
  });

  await testAsync("the generated mnemonic is twelve valid BIP39 words", async () => {
    const words = await revealMnemonic(dir);
    assert.equal(words.trim().split(/\s+/).length, 12);
    assert.ok(bip39.validateMnemonic(words));
    assert.notEqual(words, newMnemonic());     // not a constant
  });

  await testAsync("the seed file is 0600: it is a spending key once the bot is funded", async () => {
    const st = await stat(path.join(dir, SEED_FILE));
    assert.equal(st.mode & 0o777, 0o600, (st.mode & 0o777).toString(8));
  });

  await testAsync("a second load returns the same identities and does not rewrite the seed", async () => {
    const first = await readFile(path.join(dir, SEED_FILE), "utf8");
    const a = await loadOrCreate(dir);
    const b = await loadOrCreate(dir);
    for (const n of NETWORKS) {
      assert.equal(a.state.networks[n].paymentCode, b.state.networks[n].paymentCode);
    }
    assert.equal(b.created, false);
    assert.equal(await readFile(path.join(dir, SEED_FILE), "utf8"), first);
  });

  await testAsync("the identity state never carries the mnemonic", async () => {
    const raw = await readFile(path.join(dir, STATE_FILE), "utf8");
    const words = await revealMnemonic(dir);
    assert.ok(!raw.includes(words));
    for (const w of words.split(/\s+/)) assert.ok(!new RegExp(`"[^"]*\\b${w}\\b`).test(raw), w);
  });

  await testAsync("binding a receiver touches only that network", async () => {
    let { state } = await loadOrCreate(dir);
    assert.equal(readiness(state, "bitcoin").needsReceiver, true);
    state = bindReceiver(state, "bitcoin", BOB_CODE);
    assert.equal(state.networks.bitcoin.receiverPaymentCode, BOB_CODE);
    assert.equal(state.networks.testnet4.receiverPaymentCode, null,
      "binding mainnet must not bind testnet: they are different wallets");
    assert.equal(readiness(state, "bitcoin").needsReceiver, false);
    assert.equal(readiness(state, "testnet4").needsReceiver, true);
    await saveState(dir, state);
  });

  await testAsync("a payment code carries no network, so binding records what it derives", async () => {
    // This is the uncomfortable truth the panel has to work around: the SAME
    // code parses on both chains and simply derives a different notification
    // address. A mainnet code pasted into the testnet slot cannot be rejected.
    // So the binding records the address it derives, and the operator confirms
    // that against their wallet — that is the only check there is.
    const { state } = await loadOrCreate(dir);
    const onMain = bindReceiver(state, "bitcoin", BOB_CODE).networks.bitcoin;
    const onTest = bindReceiver(state, "testnet4", BOB_CODE).networks.testnet4;
    assert.equal(onMain.receiverPaymentCode, onTest.receiverPaymentCode, "same code, accepted on both");
    assert.notEqual(onMain.receiverNotificationAddress, onTest.receiverNotificationAddress);
    assert.match(onMain.receiverNotificationAddress, /^1/);
    assert.match(onTest.receiverNotificationAddress, /^[mn]/);
  });

  await testAsync("text that is not a payment code at all is still refused", async () => {
    const { state } = await loadOrCreate(dir);
    assert.throws(() => bindReceiver(state, "bitcoin", "PM8Tnotacode"), /not a usable BIP47 payment code/);
    assert.throws(() => bindReceiver(state, "bitcoin", ""), /not a usable BIP47 payment code/);
    assert.throws(() => bindReceiver(state, "bitcoin", "1ChvUUvht2hUQufHBXF8NgLhW8SwE2ecGV"),
      /not a usable BIP47 payment code/);
  });

  await testAsync("a shop cannot make itself its own receiver", async () => {
    const { state } = await loadOrCreate(dir);
    assert.throws(() => bindReceiver(state, "bitcoin", state.networks.bitcoin.paymentCode),
      /cannot be the shop's own/);
  });

  await testAsync("the receiver cannot change once that network's notification is on-chain", async () => {
    let { state } = await loadOrCreate(dir);
    state = bindReceiver(state, "bitcoin", BOB_CODE);
    state = { ...state, networks: { ...state.networks, bitcoin: {
      ...state.networks.bitcoin, notificationTxid: "f".repeat(64), notificationSentAt: new Date().toISOString() } } };
    assert.throws(() => bindReceiver(state, "bitcoin", ALICE_CODE), /already on-chain/);
    // Re-binding the SAME receiver is not a change, so it is allowed.
    assert.equal(bindReceiver(state, "bitcoin", BOB_CODE).networks.bitcoin.receiverPaymentCode, BOB_CODE);
    assert.equal(readiness(state, "bitcoin").ready, true);
    // ...and the other network is untouched by any of it.
    assert.equal(readiness(state, "testnet4").ready, false);
  });

  await testAsync("switching the active network destroys nothing on either side", async () => {
    let { state } = await loadOrCreate(dir);
    state = bindReceiver(state, "bitcoin", BOB_CODE);
    const before = JSON.stringify(state.networks);
    state = setActive(state, "testnet4");
    assert.equal(state.active, "testnet4");
    assert.equal(JSON.stringify(state.networks), before, "a toggle is a view, not an edit");
    // The union type already rejects this at compile time; the runtime guard is
    // for callers that arrive as JSON over the socket, where types do not apply.
    const bogus = /** @type {any} */ ("signet");
    assert.throws(() => setActive(state, bogus), /unknown network/);
  });

  await testAsync("a directory-sourced Dojo is recorded as such", async () => {
    let { state } = await loadOrCreate(dir);
    assert.equal(readiness(state, "bitcoin").needsDojo, true);
    state = setDojo(state, "bitcoin", {
      url: "http://" + "a".repeat(56) + ".onion/v2", apikey: "k", label: "someone else's", source: "directory" });
    assert.equal(state.networks.bitcoin.dojo.source, "directory",
      "the panel warns on this, so it has to survive the round trip");
    assert.equal(readiness(state, "bitcoin").needsDojo, false);
    assert.equal(state.networks.testnet4.dojo, null);
  });

  await testAsync("a swapped seed is refused on EITHER network, not just the active one", async () => {
    const swapped = await mkdtemp(path.join(os.tmpdir(), "mise-identity-"));
    const { state } = await loadOrCreate(swapped);
    // Keep the mainnet code recorded but put a different seed under it, which is
    // what restoring the wrong backup looks like.
    await writeFile(path.join(swapped, SEED_FILE),
      JSON.stringify({ mnemonic: newMnemonic(), createdAt: state.createdAt }), { mode: 0o600 });
    await assert.rejects(() => loadOrCreate(swapped), /no longer derives the recorded/);
    await rm(swapped, { recursive: true, force: true });
  });

  await rm(dir, { recursive: true, force: true });
}

server.close();
await rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
