#!/usr/bin/env node
// Offline end-to-end test of the backend. Spins a mock SOCKS proxy (so the
// connection gate passes without real Tor), simulates a wallet signing the
// Auth47 challenge and the pairing payload, and drives the HTTP API.
import net from "node:net";
import assert from "node:assert";
import { BIP47Factory } from "@dojo-tools/bip47";
import { bitcoinMessageFactory } from "@dojo-tools/bitcoinjs-message";
import * as bip47utils from "@dojo-tools/bip47/utils";
import ecc from "@bitcoinerlab/secp256k1";
import { mnemonicToSeedSync } from "bip39";
import os from "node:os";
import pathMod from "node:path";

// point the backend at a temp store + mock proxy BEFORE importing it
process.env.SERVER_DATA_DIR = "/tmp/dojobay-selftest";
process.env.BASE_URL = "http://exampledojobayonion.onion";
process.env.PORT = "0";
process.env.TOR_SOCKS_PORT = "19077";
// isolate the public data dir so admin approve's rebuild() never writes live data
process.env.PUBLIC_DATA_DIR = "/tmp/dojobay-selftest-data";
// make the simulated wallet's payment code an admin so /admin routes are testable
process.env.ADMIN_PAYMENT_CODES = BIP47Factory(ecc)
  .fromSeed(mnemonicToSeedSync("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"))
  .toPaymentCodePublic().toBase58();
await import("node:fs/promises").then(async (m) => {
  await m.rm(process.env.SERVER_DATA_DIR, { recursive: true, force: true });
  await m.rm(process.env.PUBLIC_DATA_DIR, { recursive: true, force: true });
  await m.mkdir(process.env.PUBLIC_DATA_DIR, { recursive: true });
  try { await m.copyFile(new URL("../data/seed.json", import.meta.url), process.env.PUBLIC_DATA_DIR + "/seed.json"); }
  catch { await m.writeFile(process.env.PUBLIC_DATA_DIR + "/seed.json", JSON.stringify({ nodes: [] })); }
});

// always-up mock SOCKS5 proxy that plays the Dojo API (login + wallet tip),
// so the authenticated connection gate passes without real Tor.
const proxy = net.createServer((s) => {
  let st = "g";
  s.on("data", (d) => {
    if (st === "g") { s.write(Buffer.from([5, 0])); st = "c"; return; }
    if (st === "c") { s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); st = "t"; return; }
    const req = d.toString("latin1");
    let body;
    if (req.includes("/auth/login")) body = JSON.stringify({ authorizations: { access_token: "tok" } });
    else if (req.includes("/wallet")) body = JSON.stringify({ info: { latest_block: { height: 900000, time: 1 } } });
    else { s.write("HTTP/1.0 404 x\r\n\r\n"); s.end(); return; }
    s.write(`HTTP/1.0 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    s.end();
  });
  s.on("error", () => {});
});
await new Promise((r) => proxy.listen(19077, "127.0.0.1", () => r(null)));

// The suite drives the server module itself. index.mjs is a launcher whose only
// job is to refuse an old Node before importing this; it is checked separately
// below rather than run here, so the suite is not gated on the host's version.
const { server } = await import("./index.ts");
await new Promise((r) => (server.listening ? r() : server.on("listening", r)));
const base = "http://127.0.0.1:" + /** @type {import("node:net").AddressInfo} */ (server.address()).port;

// --- simulated wallet ---
const bip47 = BIP47Factory(ecc), msg = bitcoinMessageFactory(ecc), net47 = bip47utils.networks.bitcoin;
const acct = bip47.fromSeed(mnemonicToSeedSync("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"));
const paymentCode = acct.toPaymentCodePublic().toBase58();
const priv = acct.getNotificationPrivateKey();
const notifAddr = acct.toPaymentCodePublic().getNotificationAddress();

let cookie = "";
async function api(path, method = "GET", body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const txt = await res.text();
  return { status: res.status, body: txt ? JSON.parse(txt) : null };
}

let passed = 0;
const ok = (c, label) => { assert.ok(c, label); passed++; console.log("  ok -", label); };

console.log("backend self-test");

// 1) login: challenge -> sign -> callback -> poll -> cookie
const ch = await api("/api/auth47/challenge", "POST", {});
ok(ch.status === 200 && ch.body.uri.startsWith("auth47://"), "challenge issued");
const signedChallenge = (() => { const u = new URL(ch.body.uri); u.searchParams.delete("c"); return decodeURIComponent(u.toString()); })();
const proofSig = Buffer.from(msg.sign(signedChallenge, priv, true, net47.messagePrefix)).toString("base64");
const cb = await api("/api/auth47/callback", "POST", { auth47_response: "1.0", challenge: signedChallenge, signature: proofSig, nym: paymentCode });
ok(cb.status === 200, "wallet proof accepted");
const poll = await api("/api/auth47/poll?nonce=" + ch.body.nonce);
ok(poll.status === 200 && poll.body.authenticated, "poll sets session");
const me = await api("/api/me");
ok(me.body.authenticated && me.body.paymentCode === paymentCode, "session bound to payment code");

// 2) wrong-signer proof is rejected
{
  const ch2 = await api("/api/auth47/challenge", "POST", {});
  const sc2 = (() => { const u = new URL(ch2.body.uri); u.searchParams.delete("c"); return decodeURIComponent(u.toString()); })();
  const bad = bip47.fromSeed(mnemonicToSeedSync("legal winner thank year wave sausage worth useful legal winner thank yellow"));
  const badSig = Buffer.from(msg.sign(sc2, bad.getNotificationPrivateKey(), true, net47.messagePrefix)).toString("base64");
  const r = await api("/api/auth47/callback", "POST", { auth47_response: "1.0", challenge: sc2, signature: badSig, nym: paymentCode });
  ok(r.status === 401, "mismatched signature rejected at login");
}

// 2b) THE RELAY. A proof is only evidence of what it was signed over, and the
//     library can check that the challenge's r parameter is a well-formed URL
//     but not that it is OURS. Without the binding, an attacker takes a live
//     nonce from this instance, shows a victim the same challenge with r
//     rewritten to their own site, and relays the signed result back here: the
//     victim's wallet displays the attacker's site, the signature verifies, and
//     a session is minted here in the victim's name.
{
  const ch3 = await api("/api/auth47/challenge", "POST", {});
  const relayed = (() => {
    const u = new URL(ch3.body.uri);
    u.searchParams.delete("c");
    u.searchParams.set("r", "http://attacker7777777777777777777777777777777777777777777.onion");
    return decodeURIComponent(u.toString());
  })();
  // Genuinely signed by the real operator, over the attacker's resource. This
  // is the whole point: the signature is valid and the nonce is live.
  const sig = Buffer.from(msg.sign(relayed, priv, true, net47.messagePrefix)).toString("base64");
  const r = await api("/api/auth47/callback", "POST",
    { auth47_response: "1.0", challenge: relayed, signature: sig, nym: paymentCode });
  ok(r.status === 401 && /different site/.test(r.body.error || ""),
     "a validly signed proof naming another site is refused: " + JSON.stringify(r.body.error));
  const p3 = await api("/api/auth47/poll?nonce=" + ch3.body.nonce);
  ok(!p3.body.authenticated, "and no session is waiting to be collected with that nonce");
}

// 2c) the binding tolerates the differences that are not differences, and only
//     those. A trailing slash and host case are the same site; a different
//     origin or a path underneath it is not.
{
  const { makeAuth47 } = await import("./crypto.ts");
  const a47 = makeAuth47(process.env.BASE_URL);
  const mk = async (resource) => {
    const ch4 = await api("/api/auth47/challenge", "POST", {});
    const u = new URL(ch4.body.uri);
    u.searchParams.delete("c");
    u.searchParams.set("r", resource);
    const c = decodeURIComponent(u.toString());
    const sg = Buffer.from(msg.sign(c, priv, true, net47.messagePrefix)).toString("base64");
    return api("/api/auth47/callback", "POST",
      { auth47_response: "1.0", challenge: c, signature: sg, nym: paymentCode });
  };
  ok((await mk(process.env.BASE_URL + "/")).status === 200,
     "a trailing slash is the same site");
  ok((await mk(process.env.BASE_URL + "/somewhere")).status === 401,
     "a path underneath it is not");
  ok((await mk(process.env.BASE_URL.replace("http://", "https://"))).status === 401,
     "nor is the same host on another scheme");

  // and the shape itself: a caller who forgets the expectation gets a refusal
  // rather than a silent pass, which is what made the original bug invisible.
  const unbound = a47.verify({ auth47_response: "1.0", challenge: "auth47://x?r=http://y.onion",
    signature: "AA==", nym: paymentCode });
  ok(!unbound.ok && /expected resource/.test(unbound.error),
     "verify refuses outright when no expected resource is given: " + JSON.stringify(unbound.error));
}

// 3) submit a Dojo with a valid signed payload -> passes both gates -> pending
const payload = {
  pairing: { type: "dojo.api", version: "1.28.0", apikey: "deadbeef", url: "http://ebtnuwk5qayotlk7brszskn2zbtzu54y24s6lmojt6j4cv7uaiwlsyad.onion/v2" },
  explorer: { type: "explorer.btc_rpc_explorer", url: "http://eaa3qxan44q2rksr23nferh5ntxsqcdcdkjmotlyo7h56widf4y3yiqd.onion" },
};
const canonical = JSON.stringify({ pairing: payload.pairing, explorer: payload.explorer });
// Real wallet exports sign the pairing JSON PLUS the BIP47 line and code (the
// full text between the markers, no trailing newline), verified against a
// genuine Samourai export. Construct blocks exactly that way.
const signedTextOf = (json, code) => `${json}\n\nBIP47:\n${code}`;
const blockOf = (msgText, addr, sig) =>
  `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${msgText}\n-----BEGIN BITCOIN SIGNATURE-----\nVersion: Bitcoin-qt (1.0)\nAddress: ${addr}\n\n${sig}\n-----END BITCOIN SIGNATURE-----`;
const signedText = signedTextOf(canonical, paymentCode);
const sigLine = Buffer.from(msg.sign(signedText, priv, true, net47.messagePrefix)).toString("base64");
const signedBlock = blockOf(signedText, notifAddr, sigLine);
// Any payload can be signed the same way. Pairing edits need a signature over
// the NEW details, so the suite must be able to produce one on demand rather
// than reusing the block that covers the payload being replaced.
const signBlockFor = (p) => {
  const text = signedTextOf(JSON.stringify({ pairing: p.pairing, explorer: p.explorer }), paymentCode);
  return blockOf(text, notifAddr, Buffer.from(msg.sign(text, priv, true, net47.messagePrefix)).toString("base64"));
};
const create = await api("/api/dojo", "POST", { network: "mainnet", name: "selftest-node", jurisdiction: "Europe", hardware: "N100 16GB", payload, signed: signedBlock });
ok(create.status === 200 && create.body.submission.status === "pending", "valid submission accepted, pending review");

// 4) signature gate failure modes, each with its own distinct error.
{
  const badSigned = signedBlock.replace(notifAddr, "1BitcoinEaterAddressDontSendf59kuE");
  const r = await api("/api/dojo", "POST", { network: "mainnet", name: "selftest-node", payload, signed: badSigned });
  ok(r.status === 400 && /signature gate/.test(r.body.error), "wrong-address signed payload rejected");

  const { verifySignedPayload } = await import("./crypto.ts");
  // Regression for the truncated-message bug: a signature covering ONLY the
  // pairing JSON (the old, wrong assumption) presented in a block that prints
  // the BIP47 lines must be refused, because the wallet signs the full text.
  const jsonOnlySig = Buffer.from(msg.sign(canonical, priv, true, net47.messagePrefix)).toString("base64");
  const oldStyle = verifySignedPayload({ signedText: blockOf(signedText, notifAddr, jsonOnlySig), expectedMessage: canonical, expectedAddress: notifAddr });
  const corrupted = verifySignedPayload({ signedText: signedBlock.replace(sigLine, sigLine.replace(/^./, (c) => c === "H" ? "I" : "H")), expectedMessage: canonical, expectedAddress: notifAddr });
  ok(!oldStyle.ok && oldStyle.error === "invalid signature" && !corrupted.ok && /invalid signature|could not be verified/.test(corrupted.error),
     "invalid signatures (truncated-coverage and corrupted) report 'invalid signature'");

  // Valid signature, but the BIP47 code inside the signed text does not derive
  // the signing address: sign a text carrying a DIFFERENT (valid) code.
  const other = bip47.fromSeed(mnemonicToSeedSync("legal winner thank year wave sausage worth useful legal winner thank yellow"));
  const otherCode = other.toBase58();
  const mixedText = signedTextOf(canonical, otherCode);
  const mixedSig = Buffer.from(msg.sign(mixedText, priv, true, net47.messagePrefix)).toString("base64");
  const mixed = verifySignedPayload({ signedText: blockOf(mixedText, notifAddr, mixedSig), expectedMessage: canonical, expectedAddress: notifAddr });
  ok(!mixed.ok && /valid, but the signing address is not the notification address/.test(mixed.error),
     "valid signature over a mismatched payment code reports the derivation failure, not 'invalid signature'");

  // Valid signature, garbage where the payment code should be.
  const junkText = signedTextOf(canonical, "PM8TJnotacode");
  const junkSig = Buffer.from(msg.sign(junkText, priv, true, net47.messagePrefix)).toString("base64");
  const junk = verifySignedPayload({ signedText: blockOf(junkText, notifAddr, junkSig), expectedMessage: canonical, expectedAddress: notifAddr });
  ok(!junk.ok && /not a valid payment code/.test(junk.error),
     "valid signature over an undecodable BIP47 line reports the invalid code");

  // Ground truth: a GENUINE wallet export (the maxtannahill node; the apikey
  // is public). This pins the real signed-text format independently of the
  // blocks this suite constructs for itself, which is exactly how the
  // truncated-message bug evaded the previous version of these tests.
  const realBlock = `-----BEGIN BITCOIN SIGNED MESSAGE-----
{"pairing":{"type":"dojo.api","version":"1.27.0","apikey":"jaf8fQuGD3QBWLjso6BqU4GEFZ8rW77hXGJfpXNq","url":"http://rwijn27ypfktrhsyrfnob66sjdgpyw6cvlk3ijzyzpj6w36emyk5x5ad.onion/v2"},"explorer":{"type":"explorer.btc_rpc_explorer","url":"http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion"}}

BIP47:
PM8TJfHaHuh5xgKoEbrkWaBtytb8qrRNYdmHzxiFcvacD6HpyyxvSV3VLKYsr6UvMxB4jvJP4xxNvCp2pRY3cJPNmLB2L8nYEttaFVszXSBjXNMy8cD9
-----BEGIN BITCOIN SIGNATURE-----
Version: Bitcoin-qt (1.0)
Address: 1HmVAPcz3hyETMnu4UzgJTw1mmrNcJKVB

H6BZzINZjJQz6LVJIduOpAtXrJUt61dNlnmEf5P6DSmUUOO78YmVOc8bg5biESMFUckk1oAJ/CP9/JLqipPb0fM=
-----END BITCOIN SIGNATURE-----`;
  const { parseSignedBlock, notificationAddress: notifOf } = await import("./crypto.ts");
  const rp = parseSignedBlock(realBlock);
  const real = verifySignedPayload({ signedText: realBlock, expectedMessage: rp.pairingText, expectedAddress: notifOf(rp.paymentCode) });
  ok(real.ok && rp.message === rp.pairingText + "\n\nBIP47:\n" + rp.paymentCode
     && notifOf(rp.paymentCode) === rp.address,
     "a genuine wallet export verifies: the signature covers json + BIP47 line + code");
}

// 5) connection gate: point the probe at a proxy that reports the onion down.
{
  const down = net.createServer((s) => {
    let st = "g";
    s.on("data", () => {
      if (st === "g") { s.write(Buffer.from([5, 0])); st = "c"; return; }
      s.write(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); s.end();  // 0x04 host unreachable
    });
    s.on("error", () => {});
  });
  await new Promise((r) => down.listen(19078, "127.0.0.1", () => r(null)));
  const { PROBE_CFG } = await import("./probe.mjs");
  PROBE_CFG.proxyPort = 19078;                 // live object, mutated in place
  // mainnet with a fresh name, rather than testnet to dodge the name conflict:
  // the shared fixture payload is a mainnet endpoint, and listing it as testnet
  // is now refused by the payload validator before the connection gate is
  // reached, which would make this test pass for the wrong reason. The signature
  // covers the payload and not the name, so renaming costs nothing.
  const r = await api("/api/dojo", "POST", { network: "mainnet", name: "unreachable-node", payload, signed: signedBlock });
  ok(r.status === 422 && /connection gate/.test(r.body.error), "unreachable node rejected by connection gate");
  PROBE_CFG.proxyPort = 19077;                 // restore the up proxy
  down.close();
}

// 6) admin moderation via the /admin API + publish
const anon = await fetch(base + "/api/admin/submissions");    // no cookie
ok(anon.status === 401, "admin route rejects anonymous");
const alist = await api("/api/admin/submissions");
ok(alist.status === 200 && alist.body.admin === true && alist.body.submissions.some((s) => s.status === "pending"),
   "admin can list pending submissions");
const pendId = alist.body.submissions.find((s) => s.status === "pending").id;
const appr = await api("/api/admin/approve", "POST", { id: pendId, paynym: "+testoperator" });
ok(appr.status === 200 && appr.body.ok && appr.body.rebuild.nodes >= 1, "admin approve publishes");
const fsp = await import("node:fs/promises");
const pub = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"));
ok(pub.nodes.some((n) => n.paynym === "+testoperator"), "approved submission appears in public dojos.json");
// ---- new-schema checks (paymentCodes[], operator names, migration) ---------

// 7) multi-code ownership: a PayNym commonly has two BIP47 code variants and
//    the wallet may sign Auth47 with either, so a record must match on
//    membership of its paymentCodes array, not equality with one code.
{
  const { store } = await import("./store.ts");   // same instance the server uses
  const rec = await store.getSubmission("mainnet-selftest-node");
  const legacyVariant = "PMlegacyVariantOfTheSameNym";
  rec.paymentCodes.push(legacyVariant);
  await store.putSubmission(rec);
  const viaPrimary = await store.submissionsFor(paymentCode);
  const viaLegacy = await store.submissionsFor(legacyVariant);
  ok(viaPrimary.some((r) => r.id === "mainnet-selftest-node")
     && viaLegacy.some((r) => r.id === "mainnet-selftest-node"),
     "both payment-code variants match the same record");
  const meAgain = await api("/api/me");
  ok(meAgain.body.submissions.some((r) => r.id === "mainnet-selftest-node"),
     "/api/me still lists the record after the second code is added");
}

// 8) name uniqueness: another operator may not take a name that is in use.
{
  const jarB = { cookie: "" };
  const apiB = async (path, method = "GET", body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(jarB.cookie ? { Cookie: jarB.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) jarB.cookie = sc.split(";")[0];
    const txt = await res.text();
    return { status: res.status, body: txt ? JSON.parse(txt) : null };
  };
  const acctB = bip47.fromSeed(mnemonicToSeedSync("legal winner thank year wave sausage worth useful legal winner thank yellow"));
  const chB = await apiB("/api/auth47/challenge", "POST", {});
  const scB = (() => { const u = new URL(chB.body.uri); u.searchParams.delete("c"); return decodeURIComponent(u.toString()); })();
  const sigB = Buffer.from(msg.sign(scB, acctB.getNotificationPrivateKey(), true, net47.messagePrefix)).toString("base64");
  await apiB("/api/auth47/callback", "POST", { auth47_response: "1.0", challenge: scB, signature: sigB, nym: acctB.toPaymentCodePublic().toBase58() });
  await apiB("/api/auth47/poll?nonce=" + chB.body.nonce);
  const ncB = await apiB("/api/dojo/name-check?network=mainnet&name=Selftest%20Node");
  ok(ncB.status === 200 && ncB.body.available === false, "name-check reports a taken name (case/punctuation-insensitive)");
  const dup = await apiB("/api/dojo", "POST", { network: "mainnet", name: "selftest-node", payload, signed: signedBlock });
  ok(dup.status === 409, "duplicate name from another operator rejected with 409");
  const ncOwner = await api("/api/dojo/name-check?network=mainnet&name=selftest-node");
  ok(ncOwner.status === 200 && ncOwner.body.available === true && ncOwner.body.update === true,
     "owner's own name reads as available (an update, keeping the record id)");
}

// 9) manage-panel ordering: /api/me returns mainnet before testnet, then
//    alphabetical by name.
{
  const { store } = await import("./store.ts");
  /**
   * @param {"mainnet"|"testnet"} network
   * @param {string} name
   * @returns {import("../types.js").StoreRecord}
   */
  const stub = (network, name) => ({
    id: `${network}-${name}`, network, name, paymentCodes: [paymentCode],
    paynym: null, payload: { pairing: { type: "dojo.api", url: "http://" + "a".repeat(56) + ".onion/v2" } },
    signed: signedBlock,
    status: "pending", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  });
  await store.putSubmission(stub("testnet", "alpha"));
  await store.putSubmission(stub("mainnet", "zulu"));
  const meOrd = await api("/api/me");
  const order = meOrd.body.submissions.map((r) => r.name);
  ok(JSON.stringify(order) === JSON.stringify(["selftest-node", "zulu", "alpha"]),
     "submissions ordered mainnet-then-testnet, then by name (" + order.join(", ") + ")");
}

// 10) migration script: dry-run prints its plan (including the code-less
//     adoption warning) and writes nothing; a real run creates owned records
//     and adopts code-less ones as admin-managed exceptions; seed.json is
//     never rewritten; a second run skips everything (byte-identical store).
{
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const MIG_DATA = "/tmp/dojobay-selftest-mig-data";
  const MIG_STORE = "/tmp/dojobay-selftest-mig-store";
  await fsp.rm(MIG_DATA, { recursive: true, force: true });
  await fsp.rm(MIG_STORE, { recursive: true, force: true });
  await fsp.mkdir(MIG_DATA, { recursive: true });
  const fixturePayload = { pairing: { type: "dojo.api", url: "http://" + "b".repeat(56) + ".onion/v2" } };
  await fsp.writeFile(MIG_DATA + "/seed.json", JSON.stringify({ nodes: [
    { id: "mainnet-fam-one", network: "mainnet", name: "Fam One", paynym: "+fam", payload: fixturePayload, signed: signedBlock },
    { id: "mainnet-fam-two", network: "mainnet", name: "Fam Two", paynym: "+fam", payload: fixturePayload, signed: signedBlock },
    { id: "testnet-keeper", network: "testnet", name: "wanderinKeeper", paynym: null, payload: fixturePayload },
    { id: "mainnet-fam-mute", network: "mainnet", name: "Fam Mute", paynym: "+fam", payload: fixturePayload },
  ] }, null, 2));
  await fsp.writeFile(MIG_DATA + "/paynym-codes.json", JSON.stringify({ mapping: {
    "+fam": { nymName: "+fam", codes: [{ code: "PMfamSegwit", segwit: true }, { code: "PMfamLegacy", segwit: false }] },
  } }, null, 2));
  const env = { ...process.env, PUBLIC_DATA_DIR: MIG_DATA, SERVER_DATA_DIR: MIG_STORE };
  const script = new URL("../scripts/migrate-seed-to-store.mjs", import.meta.url).pathname;
  const seedBefore = await fsp.readFile(MIG_DATA + "/seed.json", "utf8");

  const dry = await run(process.execPath, [script, "--dry-run"], { env });
  const storeAbsent = await fsp.access(MIG_STORE + "/store.json").then(() => false, () => true);
  ok(/create\s+mainnet-fam-one\s+name=one/.test(dry.stdout)
     && /refuse\s+testnet-keeper\s+name=wanderinKeeper/.test(dry.stdout)
     && /REFUSED: testnet-keeper no BIP47 payment code/.test(dry.stdout)
     && storeAbsent,
     "migration --dry-run: family prefix stripped, a code-less node refused, nothing written");
  ok(/refuse\s+mainnet-fam-mute/.test(dry.stdout)
     && /REFUSED: mainnet-fam-mute no signed pairing block/.test(dry.stdout)
     && /2 refused: testnet-keeper, mainnet-fam-mute/.test(dry.stdout),
     "and an owned node with no signed pairing block is refused too, and counted in the summary");

  await run(process.execPath, [script], { env });
  const store1 = await fsp.readFile(MIG_STORE + "/store.json", "utf8");
  const migrated = JSON.parse(store1).submissions;
  const seedAfter = await fsp.readFile(MIG_DATA + "/seed.json", "utf8");
  ok(migrated["mainnet-fam-one"].status === "approved"
     && migrated["mainnet-fam-one"].paymentCodes.length === 2
     && migrated["mainnet-fam-one"].source === "seed-migration"
     && !migrated["testnet-keeper"]
     && !migrated["mainnet-fam-mute"]
     && seedAfter === seedBefore,
     "migration creates owned records, never writes a code-less or unsigned one, never rewrites seed.json");

  const second = await run(process.execPath, [script], { env });
  const store2 = await fsp.readFile(MIG_STORE + "/store.json", "utf8");
  ok(/nothing to do/.test(second.stdout) && /skip\s+mainnet-fam-one/.test(second.stdout) && store2 === store1,
     "second migration run skips existing ids (store byte-identical)");
  await fsp.rm(MIG_DATA, { recursive: true, force: true });
  await fsp.rm(MIG_STORE, { recursive: true, force: true });
}

// 11) a moderation change whose publish (rebuild) fails must report the
//     failure to the admin, not swallow it: this is how an approved node
//     silently never reached the public dojos.json.
{
  const goodDir = process.env.PUBLIC_DATA_DIR;
  process.env.PUBLIC_DATA_DIR = "/dev/null/not-a-directory";     // rebuild will throw
  const rej = await api("/api/admin/reject", "POST", { id: "mainnet-selftest-node" });
  ok(rej.status === 200 && rej.body.ok && rej.body.rebuild && rej.body.rebuild.error,
     "moderation succeeds but a failed publish is reported (rebuild.error)");
  process.env.PUBLIC_DATA_DIR = goodDir;
  const reAppr = await api("/api/admin/approve", "POST", { id: "mainnet-selftest-node", paynym: "+testoperator" });
  ok(reAppr.status === 200 && reAppr.body.rebuild && !reAppr.body.rebuild.error, "publish succeeds again once writable");
}

// 12) updater reconciliation: an approved node deleted from dojos.json (the
//     approve-mid-probe-cycle clobber) is restored by reconcilePublicList(),
//     which the updater now runs at the start of every cycle.
{
  const dojosPath = process.env.PUBLIC_DATA_DIR + "/dojos.json";
  const doc = JSON.parse(await fsp.readFile(dojosPath, "utf8"));
  doc.nodes = doc.nodes.filter((n) => n.id !== "mainnet-selftest-node");
  await fsp.writeFile(dojosPath, JSON.stringify(doc, null, 2) + "\n");
  const { reconcilePublicList } = await import("../scripts/update.mjs");
  await reconcilePublicList();
  const healed = JSON.parse(await fsp.readFile(dojosPath, "utf8"));
  ok(healed.nodes.some((n) => n.id === "mainnet-selftest-node"),
     "reconcile restores an approved node clobbered out of dojos.json");
}

// 13) history grace period: delisting a node stamps its history `retired`
//     instead of deleting it; relisting within the window clears the stamp
//     with the data intact; only a long-expired retiree is deleted.
{
  const histPath = process.env.PUBLIC_DATA_DIR + "/history.json";
  const marker = [{ t: "2026-07-14 00:00", up: true }];
  const doc = JSON.parse(await fsp.readFile(histPath, "utf8"));
  doc.nodes["mainnet-selftest-node"] = { checks: marker.slice() };
  doc.nodes["mainnet-long-gone"] = { checks: marker.slice(), retired: "2026-06-01T00:00:00Z" };
  await fsp.writeFile(histPath, JSON.stringify(doc, null, 2) + "\n");

  const rej = await api("/api/admin/reject", "POST", { id: "mainnet-selftest-node" });   // delists + rebuilds
  const afterRej = JSON.parse(await fsp.readFile(histPath, "utf8")).nodes;
  ok(rej.status === 200 && afterRej["mainnet-selftest-node"]
     && afterRej["mainnet-selftest-node"].retired
     && JSON.stringify(afterRej["mainnet-selftest-node"].checks) === JSON.stringify(marker),
     "delisted node's history is retired (stamped), not deleted");
  ok(!afterRej["mainnet-long-gone"], "history retired beyond the grace window is deleted");

  await api("/api/admin/approve", "POST", { id: "mainnet-selftest-node", paynym: "+testoperator" });   // relists + rebuilds
  const afterAppr = JSON.parse(await fsp.readFile(histPath, "utf8")).nodes["mainnet-selftest-node"];
  ok(afterAppr && !afterAppr.retired
     && JSON.stringify(afterAppr.checks) === JSON.stringify(marker),
     "relisting within the grace window resurrects the history untouched");
}

// 14) display-field edits: owner can amend name and hardware; the id, status
//     and history are untouched; renames respect per-network uniqueness. The
//     Dojo version is NOT editable: a version sent in the edit is ignored and
//     the card keeps the API-derived value (here the pairing default, since no
//     live probe has run in this test).
{
  const ed = await api("/api/dojo/edit", "POST", { id: "mainnet-selftest-node", name: "selftest-node", hardware: "RPi5 8GB", version: "9.9.9-test" });
  const rec = await api("/api/me").then((r) => r.body.submissions.find((x) => x.id === "mainnet-selftest-node"));
  ok(ed.status === 200 && rec.hardware === "RPi5 8GB" && rec.version == null && rec.status === "approved",
     "owner edit updates hardware, keeps id and approved status, and cannot set a version");
  const pub = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"));
  const pubNode = pub.nodes.find((n) => n.id === "mainnet-selftest-node");
  ok(pubNode && pubNode.version === "1.28.0" && pubNode.paymentCode === rec.paymentCodes[0],
     "approved edit publishes immediately; card version stays the API-derived value, ignoring the edit");

  const clashOwn = await api("/api/dojo/edit", "POST", { id: "mainnet-selftest-node", name: "zulu" });
  const clashSeed = await api("/api/dojo/edit", "POST", { id: "mainnet-selftest-node", name: "Maxtannahill" });
  ok(clashOwn.status === 409 && clashSeed.status === 409,
     "renames rejected when colliding with own other record or the anchor seed node");

  const anon = await fetch(base + "/api/dojo/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "mainnet-selftest-node", name: "x" }) });
  const admEd = await api("/api/admin/edit", "POST", { id: "testnet-alpha", name: "alpha", hardware: "edited-by-admin" });
  const stub = await api("/api/me").then((r) => r.body.submissions.find((x) => x.id === "testnet-alpha"));
  ok(anon.status === 401 && admEd.status === 200 && stub.hardware === "edited-by-admin",
     "anonymous edit rejected; admin can edit any record via /api/admin/edit");
}

// 15) the card shows the PayNym's canonical (non-segwit) code variant when the
//     mapping identifies it, falling back to the record's first code.
{
  const { displayPaymentCode } = await import("./build-public.ts");
  const sub = { paynym: "+max", paymentCodes: ["PMsegwitVariant", "PMlegacyVariant"] };
  const mapping = { "+max": { codes: [{ code: "PMsegwitVariant", segwit: true }, { code: "PMlegacyVariant", segwit: false }] } };
  ok(displayPaymentCode(sub, mapping) === "PMlegacyVariant"
     && displayPaymentCode(sub, {}) === "PMsegwitVariant"
     && displayPaymentCode({ paymentCodes: [] }, mapping) === null,
     "display code prefers the non-segwit variant, falls back to the first, null when none");
}

// 16) intake hygiene: pasted CRLF/zero-width bytes are stripped from signed
//     blocks before verification; export endpoint merges both history windows.
//
//     The card link is gone. It let an operator point the card title anywhere
//     they had proven they controlled, which meant one listing could carry two
//     claims of identity: the verified domain badge and a title link. One is
//     enough, and it is the one with a TXT record behind it.
{
  // signed cleaning: resubmit the check-3 record with a clipboard-mangled
  // signed block (CRLF + zero-width space); it must still pass the signature
  // gate and be STORED byte-clean.
  const mangled = signedBlock.replace(/\n/g, "\r\n") + "\u200b";
  const resub = await api("/api/dojo", "POST", { network: "mainnet", name: "selftest-node", jurisdiction: "Europe", hardware: "N100 16GB", payload, signed: mangled });
  const rec = await api("/api/me").then((r) => r.body.submissions.find((x) => x.id === "mainnet-selftest-node"));
  ok(resub.status === 200 && rec.signed === signedBlock && !rec.signed.includes("\r"),
     "CRLF/zero-width paste artefacts stripped before verification; stored block byte-clean");

  // restore approved status (resubmission re-enters moderation)
  await api("/api/admin/approve", "POST", { id: "mainnet-selftest-node", paynym: "+testoperator" });

  // A verified domain is still granted here, because the checks below and the
  // published badge depend on one. Granted directly in the store, since the API
  // path needs DNS.
  const { store: st } = await import("./store.ts");
  await st.putDomain({ paymentCode, domain: "example.org", signed: "(test)",
    verified: true, verified_at: new Date().toISOString(), last_check: new Date().toISOString(),
    last_result: "ok", fail_since: null, created_at: new Date().toISOString() });

  // The card link is not merely unused, it is unreachable: a request carrying
  // one is accepted and the field ignored, rather than silently stored where a
  // future rebuild might publish it again.
  const withUrl = await api("/api/dojo/edit", "POST",
    { id: "mainnet-selftest-node", name: "selftest-node", name_url: "https://example.org/mynode" });
  const after = await api("/api/me").then((r) => r.body.submissions.find((x) => x.id === "mainnet-selftest-node"));
  const pub16 = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"))
    .nodes.find((n) => n.id === "mainnet-selftest-node");
  ok(withUrl.status === 200 && !after.name_url,
     "an edit carrying a card link succeeds and stores nothing for it");
  ok(!("name_url" in pub16) && pub16.operator_domain === "example.org",
     "and the published node has no link field at all, only the verified domain");

  // export endpoint: both windows merged, per-node filter, 404 on unknown
  const all = await api("/api/history/export");
  const one = await api("/api/history/export?id=mainnet-selftest-node");
  const none = await api("/api/history/export?id=no-such-node");
  ok(all.status === 200 && all.body.nodes["mainnet-selftest-node"]
     && Array.isArray(one.body.nodes["mainnet-selftest-node"].checks)
     && Array.isArray(one.body.nodes["mainnet-selftest-node"].days)
     && Object.keys(one.body.nodes).length === 1 && none.status === 404,
     "history export merges 24h checks and daily rollups, filters by id, 404s unknown ids");
}

// 17) update check: commits behind main, and which RELEASE we are running.
//     "Releases behind" used to count releases published after the local build
//     timestamp, so an instance running the exact commit of the newest release
//     always reported itself one behind — a tag is always created after the
//     commit it points at was built. It now resolves tags to commits.
{
  const { checkUpdates } = await import("./updates.mjs");
  const releases = [
    { tag_name: "v0.2", published_at: "2026-06-01T00:00:00Z" },
    { tag_name: "v0.1", published_at: "2025-12-01T00:00:00Z" },
  ];
  const tags = [
    { name: "v0.2", commit: { sha: "abc1234def5678900000000000000000000000a" } },
    { name: "v0.1", commit: { sha: "0000000000000000000000000000000000000b" } },
  ];
  const transportFor = (withTags) => async (apiPath) => {
    if (apiPath.startsWith("/repos/Dojobay/dojobay/compare/"))
      return { status: 200, body: JSON.stringify({ status: "behind", ahead_by: 4, behind_by: 0 }) };
    if (apiPath.startsWith("/repos/Dojobay/dojobay/releases"))
      return { status: 200, body: JSON.stringify(releases) };
    if (apiPath.startsWith("/repos/Dojobay/dojobay/tags"))
      return withTags ? { status: 200, body: JSON.stringify(tags) } : { status: 500, body: "{}" };
    return { status: 404, body: "{}" };
  };
  const setVersion = (commit, built) => fsp.writeFile(process.env.PUBLIC_DATA_DIR + "/version.json",
    JSON.stringify({ commit, built }));

  // running the exact commit of the newest release, tagged AFTER we built it
  await setVersion("abc1234", "2026-01-01T00:00:00Z");
  const onLatest = await checkUpdates({ transport: /** @type {any} */ (transportFor(true)) });
  ok(onLatest.releases_behind === 0 && onLatest.current_release === "v0.2"
     && onLatest.releases_behind_approx === false,
     "running the newest release's commit reports zero behind, however late the tag was created");

  // an untagged commit mid-cycle: no identity match, so the timestamp guess,
  // flagged as approximate rather than presented as fact
  await setVersion("deadbee", "2026-01-01T00:00:00Z");
  const midCycle = await checkUpdates({ transport: /** @type {any} */ (transportFor(true)) });
  ok(midCycle.releases_behind === 1 && midCycle.current_release === null
     && midCycle.releases_behind_approx === true,
     "an untagged commit falls back to the timestamp count and says it is approximate");

  // The tags call failing must not break the check, and must not invent a
  // number either: the timestamp guess is systematically wrong for the
  // commonest case, an instance running the very newest release.
  await setVersion("abc1234", "2026-01-01T00:00:00Z");
  const noTags = await checkUpdates({ transport: /** @type {any} */ (transportFor(false)) });
  ok(noTags.releases_behind === null && noTags.releases_behind_approx === true
     && /tag lookup/.test(noTags.releases_note || ""),
     "an unavailable tags endpoint reports unknown, with the reason, rather than a guess");

  await setVersion("abc1234", "2026-01-01T00:00:00Z");
  const u = await checkUpdates({ transport: /** @type {any} */ (transportFor(true)) });
  ok(u.commits_behind === 4 && u.latest_release === "v0.2" && u.commit === "abc1234",
     "update check still reports commits behind main and the latest release");

  const anon = await fetch(base + "/api/admin/updates");
  const admin = await api("/api/admin/updates");
  ok(anon.status === 401 && admin.status === 200 && admin.body.available === false && admin.body.error,
     "updates route: anonymous 401; unreachable GitHub reported in-band to the admin");

  // A rate-limited exit is the commonest way this check fails and the least
  // like a fault: GitHub allows sixty unauthenticated requests an hour per IP,
  // and a Tor exit is one address shared with everyone using it. An operator
  // told "HTTP 403" goes looking for a broken instance.
  const { githubRefusal } = await import("./updates.mjs");
  for (const code of [403, 429]) {
    const msg = githubRefusal("compare", code);
    ok(/rate-limit/i.test(msg) && /exit/.test(msg) && msg.includes(String(code)),
       `HTTP ${code} is explained as a rate-limited exit, with the status still in it`);
  }
  ok(/peer/i.test(githubRefusal("compare", 403)),
     "and points at the route that does not touch GitHub");
  ok(githubRefusal("compare", 500) === "compare: HTTP 500",
     "while anything else is reported as what it was, with no story attached");
  // No call-site prefix on the rate-limit message. Which of the three requests
  // hit the limit tells an operator nothing, and "compare: GitHub is
  // rate-limiting..." reads as though compare were the thing that failed.
  ok(!/^compare:/.test(githubRefusal("compare", 403)),
     "and the rate-limit message does not open with the name of the call that hit it");

  // The import routes. Their argument checking and their refusal to run two at
  // once are testable here; the fetch itself needs another instance over Tor,
  // which this suite has no way to provide, so what is asserted is everything
  // that happens before the first byte leaves the machine.
  const anonImport = await fetch(base + "/api/admin/import", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ onion: "x" }) });
  ok(anonImport.status === 401, "import route refuses anyone who is not an admin");

  const badOnion = await api("/api/admin/import", "POST", { onion: "not-an-onion", code: paymentCode });
  ok(badOnion.status === 400 && /\.onion/.test(badOnion.body.error || ""),
     "and refuses an address that is not a 56-character onion");

  // Without the peer's payment code there is nothing for the operator binding
  // to be checked against, so the import would establish only that the remote
  // signed something, not that it is the instance the operator chose to trust.
  const noCode = await api("/api/admin/import", "POST", { onion: "a".repeat(56) + ".onion" });
  ok(noCode.status === 400 && /payment code/.test(noCode.body.error || ""),
     "and refuses without the payment code of the instance being imported from");

  // A real start, which will fail at the fetch because that onion does not
  // exist. What matters is that it is a job rather than a held-open request,
  // and that the failure is reported in-band rather than as a dead panel.
  const started = await api("/api/admin/import", "POST",
    { onion: "b".repeat(56) + ".onion", code: paymentCode });
  ok(started.status === 202 && started.body.started === true && started.body.apply === false,
     "an import starts as a background job, and defaults to planning rather than writing");

  // Two imports must not run at once, and a second request is refused while the
  // first is unfinished. That is deliberately NOT asserted by firing a second
  // request and expecting 409: whether the first is still running by then
  // depends on how quickly the fetch fails, which is a property of the machine
  // rather than of this code. On a box with Tor it hangs for seconds; in CI
  // there is no Tor at all, the connection is refused on the next turn of the
  // loop, and a second import is then correctly ACCEPTED because nothing is
  // running. The first version of this test asserted 409 unconditionally and
  // failed in CI for exactly that reason.
  //
  // What is asserted instead is the rule itself, which is monotonic and does
  // not depend on timing: the guard is on the job being unfinished, and the
  // job is created before the work starts so there is no window in which two
  // could begin. Weaker than a behavioural test, and said so here rather than
  // dressed up as one.
  const idx = await fsp.readFile(new URL("./index.ts", import.meta.url), "utf8");
  const importRoute = idx.slice(idx.indexOf('route("POST", /^\\/api\\/admin\\/import$/'),
                                idx.indexOf('route("GET", /^\\/api\\/admin\\/import\\/status$/'));
  ok(/IMPORT_JOB && !IMPORT_JOB\.done\) return json\(res, 409/.test(importRoute),
     "a second import while one is running is refused rather than interleaved");
  ok(importRoute.indexOf("IMPORT_JOB = {") < importRoute.indexOf("bootstrapImport({"),
     "and the job exists before the work starts, so there is no window in which two could begin");

  for (let i = 0; i < 60; i++) {
    const st = await api("/api/admin/import/status");
    if (st.body.job && st.body.job.done) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const fin = await api("/api/admin/import/status");
  ok(fin.status === 200 && fin.body.job && fin.body.job.done === true && fin.body.job.ok === false
     && typeof fin.body.job.error === "string",
     "an unreachable peer ends the job with a reason rather than leaving it running");

  // The cache rule the "Check again" button depends on. Tested here rather
  // than through the route, because the route only fills its cache on a
  // successful check and GitHub is unreachable in this suite, so the cached
  // path is never taken and the floor would never run. A rule that cannot be
  // exercised is a rule nobody has checked.
  const { updateCacheDecision } = await import("./updates.mjs");
  const now = 1_000_000_000_000;
  const hour = 3600 * 1000;

  ok(updateCacheDecision({ cachedAt: null, now }).serveCached === false,
     "no cached answer means the check goes out");
  ok(updateCacheDecision({ cachedAt: now - 5 * hour, now }).serveCached === true,
     "an ordinary request inside six hours is answered from the cache");
  ok(updateCacheDecision({ cachedAt: now - 7 * hour, now }).serveCached === false,
     "and outside six hours it is not");

  // The button's whole purpose: an operator who pushed while already signed in
  // gets a real check rather than an answer from before their push.
  ok(updateCacheDecision({ cachedAt: now - 5 * hour, now, forced: true, forcedAt: 0 }).serveCached === false,
     "a forced check bypasses a cache that is still fresh");
  ok(updateCacheDecision({ cachedAt: now - 5 * hour, now, forced: true, forcedAt: now - 90 * 1000 }).serveCached === false,
     "and again once the floor has passed");

  // And the floor, which is what stops that button hammering GitHub through an
  // exit node shared with every other Tor user. Refusing outright would tell
  // the operator nothing, so the last known answer comes back with the wait.
  const held = updateCacheDecision({ cachedAt: now - 5 * hour, now, forced: true, forcedAt: now - 20 * 1000 });
  ok(held.serveCached === true && held.waitS === 40,
     "inside the floor the cached answer comes back with the seconds remaining: " + held.waitS);
  ok(updateCacheDecision({ cachedAt: now - 5 * hour, now, forced: false, forcedAt: now - 20 * 1000 }).waitS === 0,
     "and an unforced request is never told to wait, since it asked for nothing");
}

// 18) operator binding + bootstrap import: the binding verifies a real
//     wallet signature over "onion + BIP47 line"; the import refuses an
//     instance whose binding fails or whose code differs from the one the
//     operator trusted, and otherwise imports nodes (skipping existing ids)
//     with full code variants and carried histories.
{
  const onionHost = "b".repeat(56) + ".onion";
  const opCode = paymentCode;   // the test wallet from the Auth47 checks
  const opMessage = `http://${onionHost}/\n\nBIP47: ${opCode}`;
  const opSig = Buffer.from(msg.sign(opMessage, acct.getNotificationPrivateKey(), true, net47.messagePrefix)).toString("base64");
  const opBlock = `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${opMessage}\n-----BEGIN BITCOIN SIGNATURE-----\nAddress: ${notifAddr}\n\n${opSig}\n-----END BITCOIN SIGNATURE-----`;
  const opDoc = { onion: `http://${onionHost}/`, paymentCode: opCode, verifySigned: opBlock };

  const { verifyOperatorDoc, notificationAddresses } = await import("./crypto.ts");
  const vOk = verifyOperatorDoc(opDoc, { expectedOnion: `http://${onionHost}` });
  const vWrongOnion = verifyOperatorDoc(opDoc, { expectedOnion: "http://" + "c".repeat(56) + ".onion" });
  const vTampered = verifyOperatorDoc({ ...opDoc, verifySigned: opBlock.replace(onionHost, "c".repeat(56) + ".onion") });
  ok(vOk.ok && !vWrongOnion.ok && !vTampered.ok,
     "operator binding: valid signature accepted; wrong onion and tampered message refused");

  // The same payment code signed from a TESTNET wallet.
  //
  // A PayNym is a mainnet identity, but a wallet in testnet mode derives the
  // notification address for that network, so the same code signs from a
  // different address. Requiring the mainnet form refused perfectly good
  // bindings from anyone running a testnet wallet.
  const tnetAddr = notificationAddresses(opCode).find((a) => a !== notifAddr);
  ok(tnetAddr && tnetAddr !== notifAddr, "the code derives a second, testnet address: " + tnetAddr);
  const tnetBlock = opBlock.replace(`Address: ${notifAddr}`, `Address: ${tnetAddr}`);
  const vTestnet = verifyOperatorDoc({ ...opDoc, verifySigned: tnetBlock }, { expectedOnion: `http://${onionHost}` });
  ok(vTestnet.ok && vTestnet.address === tnetAddr,
     "operator binding accepts a testnet-derived signing address: " + JSON.stringify(vTestnet.error || ""));

  // but an address that is neither derivation is still refused, and the error
  // names both so an operator can see which their wallet actually used
  const strayAddr = notificationAddresses(bip47.fromSeed(mnemonicToSeedSync(
    "legal winner thank year wave sausage worth useful legal winner thank yellow")).toBase58())[0];
  const vStray = verifyOperatorDoc({ ...opDoc, verifySigned: opBlock.replace(`Address: ${notifAddr}`, `Address: ${strayAddr}`) },
    { expectedOnion: `http://${onionHost}` });
  ok(!vStray.ok && /on mainnet, or/.test(vStray.error) && vStray.error.includes(notifAddr),
     "an unrelated signing address is refused, naming both addresses the code could have used");

  // A terminal that swallows the newline after the BEGIN marker must not break
  // an otherwise valid binding: that newline is not part of the signed text.
  const eaten = opBlock.replace("MESSAGE-----\n", "MESSAGE-----");
  ok(verifyOperatorDoc({ ...opDoc, verifySigned: eaten }, { expectedOnion: `http://${onionHost}` }).ok,
     "operator binding survives a paste that lost the newline after the BEGIN marker");

  // A truncated paste must say so rather than blaming the wallet, and a
  // signature from the wrong account must name both addresses.
  const truncated = verifyOperatorDoc({ ...opDoc, verifySigned: opBlock.split("\n").slice(0, 3).join("\n") });
  const otherAcct = bip47.fromSeed(mnemonicToSeedSync("legal winner thank year wave sausage worth useful legal winner thank yellow"));
  const wrongSig = Buffer.from(msg.sign(opMessage, otherAcct.getNotificationPrivateKey(), true, net47.messagePrefix)).toString("base64");
  const wrongSigner = verifyOperatorDoc({ ...opDoc,
    verifySigned: `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${opMessage}\n-----BEGIN BITCOIN SIGNATURE-----\nAddress: ${otherAcct.getNotificationAddress()}\n\n${wrongSig}\n-----END BITCOIN SIGNATURE-----` });
  ok(/truncated/.test(truncated.error)
     && wrongSigner.error.includes(otherAcct.getNotificationAddress()) && wrongSigner.error.includes(notifAddr),
     "truncated paste and wrong-signer errors are diagnosable (names what is missing / both addresses)");

  // A real, portable domain proof: signed over "https://example.org/" + blank
  // line + the BIP47 line, exactly as the site produces it.
  const urlClaimText = `https://example.org/\n\nBIP47: ${paymentCode}`;
  const signedUrlBlock = `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${urlClaimText}\n` +
    `-----BEGIN BITCOIN SIGNATURE-----\nVersion: Bitcoin-qt (1.0)\nAddress: ${notifAddr}\n\n` +
    `${Buffer.from(msg.sign(urlClaimText, priv, true, net47.messagePrefix)).toString("base64")}\n` +
    `-----END BITCOIN SIGNATURE-----`;
  const remoteNodes = {
    nodes: [
      { id: "mainnet-selftest-node", network: "mainnet", name: "selftest-node",
        payload: { pairing: { type: "dojo.api", url: "http://" + "d".repeat(56) + ".onion/v2", apikey: "k" } },
        operator_domain: "example.org",
        operator_domain_proof: { domain: "example.org", paymentCode, txt_name: "_dojobay.example.org",
          txt_value: `dojobay-domain-v1 pm=${paymentCode}`, signed: signedUrlBlock, verified_at: "2026-07-01T00:00:00Z" } },
      // Signed over ITS OWN payload. It used to carry the block covering a
      // different node's pairing details and imported cleanly, because nothing
      // verified the signature: the source instance's word was the only thing
      // vouching for it.
      { id: "mainnet-imported", network: "mainnet", name: "imported", paynym: "+imp",
        paymentCode: "PMimpDisplay",
        signed: signBlockFor({ pairing: { type: "dojo.api", url: "http://" + "e".repeat(56) + ".onion/v2", apikey: "k" } }),
        payload: { pairing: { type: "dojo.api", url: "http://" + "e".repeat(56) + ".onion/v2", apikey: "k" } },
        // a forged proof: the signature does not check out against the code
        operator_domain: "evil.example",
        operator_domain_proof: { domain: "evil.example", paymentCode: "PM8T" + "9".repeat(112),
          txt_name: "_dojobay.evil.example", txt_value: "dojobay-domain-v1 pm=PM8T" + "9".repeat(112),
          signed: signedUrlBlock, verified_at: "2026-07-01T00:00:00Z" } },
      // published by an instance that does not enforce the signature rule, or
      // from before it existed. It must not enter this store.
      { id: "mainnet-hearsay", network: "mainnet", name: "hearsay", paynym: "+imp",
        paymentCode: "PMimpDisplay",
        payload: { pairing: { type: "dojo.api", url: "http://" + "f".repeat(56) + ".onion/v2", apikey: "k" } } },
      // A well-formed block that covers somebody else's payload. This is what a
      // careless or compromised directory publishes, and what taking the
      // source's word for a signature would let through.
      { id: "mainnet-forged", network: "mainnet", name: "forged", paynym: "+imp",
        paymentCode: "PMimpDisplay", signed: signedBlock,
        payload: { pairing: { type: "dojo.api", url: "http://" + "g".repeat(56) + ".onion/v2", apikey: "k" } } },
    ],
  };
  const remoteDocs = {
    "/data/operator.json": opDoc,
    "/data/dojos.json": remoteNodes,   // proofs are attached to its nodes below
    "/data/history.json": { interval_minutes: 10, window_checks: 144, nodes: {
      "mainnet-imported": { checks: [{ t: "2026-07-01 00:00", up: true }] },
      "mainnet-selftest-node": { checks: [{ t: "2026-07-01 00:00", up: false }] },
    } },
    "/data/history-daily.json": { nodes: { "mainnet-imported": { days: [{ d: "2026-07-01", pct: 99, close: 1 }] } } },
  };
  const { bootstrapImport } = await import("../scripts/bootstrap-import.mjs");
  const { store } = await import("./store.ts");
  const fetchDoc = async (p) => { if (!(p in remoteDocs)) throw new Error("404 " + p); return remoteDocs[p]; };
  const fetchCodes = async () => [{ code: "PMimpSegwit", segwit: true }, { code: "PMimpLegacy", segwit: false }];

  await ok(await bootstrapImport({
    onionHost, trustedCode: "PM8T" + "2".repeat(112), fetchDoc, fetchCodes, dataDir: process.env.PUBLIC_DATA_DIR, log: () => {},
  }).then(() => false, (e) => /DIFFERENT payment code/.test(e.message)),
     "bootstrap refuses an instance operated by a different code than the one trusted");

  // clear any claim an earlier check left behind, so the import starts clean
  await store.deleteDomain(paymentCode);
  const r = await bootstrapImport({ onionHost, trustedCode: opCode, fetchDoc, fetchCodes, dataDir: process.env.PUBLIC_DATA_DIR, log: () => {} });
  const imp = await store.getSubmission("mainnet-imported");
  const untouched = await store.getSubmission("mainnet-selftest-node");
  const histAfter = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/history.json", "utf8")).nodes;
  ok(!(await store.getSubmission("mainnet-hearsay")),
     "an unsigned node published by the remote instance is refused rather than imported");
  // The block is well-formed and genuinely signed; it just covers a different
  // node's payload. hasSignedBlock cannot tell the difference and neither can
  // putSubmission, so before the signature was verified here this imported
  // cleanly on the source instance's word alone.
  ok(!(await store.getSubmission("mainnet-forged")),
     "a well-formed block over somebody else's payload is refused: signatures are verified here, not taken on trust");

  // An import into a RUNNING instance arrives pending, so it lands in the
  // moderation queue the operator already uses. At install approved is right,
  // because choosing to bootstrap is the decision to trust that list wholesale;
  // in a running instance a listing that appeared on the site without passing
  // the queue would be another directory publishing here.
  {
    const url = "http://" + "h".repeat(56) + ".onion/v2";
    const one = { pairing: { type: "dojo.api", url, apikey: "k" } };
    const docs = {
      "/data/operator.json": opDoc,
      "/data/dojos.json": { nodes: [{ id: "mainnet-queued", network: "mainnet", name: "queued",
        paynym: "+imp", paymentCode: "PMimpDisplay", signed: signBlockFor(one), payload: one }] },
    };
    const r2 = await bootstrapImport({ onionHost, trustedCode: opCode, status: "pending",
      fetchDoc: async (pth) => { if (!(pth in docs)) throw new Error("404 " + pth); return docs[pth]; },
      fetchCodes, dataDir: process.env.PUBLIC_DATA_DIR, log: () => {} });
    const queued = await store.getSubmission("mainnet-queued");
    ok(r2.imported === 1 && queued && queued.status === "pending",
       "an import can arrive pending, for a running instance with a moderation queue: " + (queued && queued.status));
    ok(r2.plan && r2.plan.some((row) => row.id === "mainnet-queued" && row.action === "import" && row.url === url),
       "and the plan comes back as data, so a console can render it rather than parse log lines");
    await store.deleteSubmission("mainnet-queued");
  }

  // The route asks for that, rather than inheriting the installer's default.
  {
    const idx = await fsp.readFile(new URL("./index.ts", import.meta.url), "utf8");
    const block = idx.slice(idx.indexOf('route("POST", /^\\/api\\/admin\\/import$/'),
                            idx.indexOf('route("GET", /^\\/api\\/admin\\/import\\/status$/'));
    ok(block.length > 200 && /status: "pending"/.test(block),
       "the admin import route asks for pending records rather than taking the installer's default");

    // A pending record's live status comes from pending-probe.json, which only
    // the update cycle writes. Until one runs, an imported listing has no
    // status and the moderation queue shows it as inactive, which is not what
    // it is: nothing has asked it yet, and the moderator deciding whether to
    // approve is the person who needs the answer.
    const job = idx.slice(idx.indexOf('route("POST", /^\\/api\\/admin\\/import$/'),
                          idx.indexOf('route("GET", /^\\/api\\/admin\\/import\\/status$/'));
    ok(/"scripts", "update.mjs"/.test(job) && /job\.phase = "probing"/.test(job),
       "an applied import runs a probe cycle, as the installer does before declaring success");
    ok(job.indexOf("tryRebuild()") < job.indexOf('job.phase = "probing"'),
       "after the rebuild, so the cycle sees the records it is about to probe");
    ok(/is-active", "--quiet", "dojobay-update\.service"/.test(job),
       "and skips it when a cycle is already running, since there is no lock and two would race");
    ok(/\(job\.result\?\.imported \?\? 0\) > 0/.test(job),
       "nothing is probed when nothing was imported");
    ok(/dryRun: !job\.apply/.test(block),
       "and plans unless the operator explicitly asked to apply");
  }
  ok(r.imported === 1 && imp && imp.status === "approved"
     && imp.paymentCodes.includes("PMimpSegwit") && imp.paymentCodes.includes("PMimpLegacy") && imp.paymentCodes.includes("PMimpDisplay")
     && imp.source === `bootstrap-import:${onionHost}`
     && untouched && !String(untouched.source || "").startsWith("bootstrap")
     && histAfter["mainnet-imported"] && histAfter["mainnet-imported"].checks.length === 1
     && histAfter["mainnet-selftest-node"].checks[0].t !== "2026-07-01 00:00",
     "bootstrap imports new nodes with all code variants and history; existing ids untouched");

  // The duplicate an operator actually hits. Bootstrapping a new instance from a
  // directory that already lists your own node used to create a second record
  // for it, because each instance derives an id from the name it was given and
  // the two differ. The anchor is in seed.json rather than the store, so it was
  // invisible to the existing-id check: the operator's own node was the one
  // guaranteed to duplicate.
  {
    const anchorUrl = "http://" + "d".repeat(56) + ".onion/v2";
    const seedPath = process.env.PUBLIC_DATA_DIR + "/seed.json";
    const seedDoc = JSON.parse(await fsp.readFile(seedPath, "utf8"));
    const keptSeed = JSON.stringify(seedDoc);
    seedDoc.nodes[0].payload = { pairing: { type: "dojo.api", apikey: "k", url: anchorUrl } };
    const anchorId = seedDoc.nodes[0].id;
    await fsp.writeFile(seedPath, JSON.stringify(seedDoc, null, 2) + "\n");

    // the same machine, published by the remote instance under its own id
    // Cast: the checker infers a literal shape from the fixtures these replace,
    // and the import reads them as plain documents.
    remoteDocs["/data/dojos.json"] = /** @type {any} */ ({ nodes: [{
      id: "mainnet-their-name-for-it", network: "mainnet", name: "their name for it",
      paynym: "+imp", paymentCode: "PMimpDisplay", signed: signedBlock,
      payload: { pairing: { type: "dojo.api", apikey: "k", url: anchorUrl.toUpperCase() + "/" } },
    }] });
    remoteDocs["/data/history.json"] = /** @type {any} */ ({ nodes: { "mainnet-their-name-for-it": { checks: [{ t: "2026-07-02 00:00", up: true }] } } });
    remoteDocs["/data/history-daily.json"] = /** @type {any} */ ({ nodes: {} });

    const dup = await bootstrapImport({ onionHost, trustedCode: opCode, fetchDoc, fetchCodes,
      dataDir: process.env.PUBLIC_DATA_DIR, log: () => {} });
    ok(dup.imported === 0 && dup.merged === 1,
       "the operator's own node arrives as a merge rather than a second listing");
    ok(!(await store.getSubmission("mainnet-their-name-for-it")),
       "and no record is created for it under the other instance's id");
    // Upper-cased and with a trailing slash in the fixture, because neither
    // changes which endpoint is meant and both are the sort of difference that
    // would defeat a naive string compare.
    const h = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/history.json", "utf8")).nodes;
    ok(h[anchorId] && h[anchorId].checks.some((c) => c.t === "2026-07-02 00:00"),
       "its history is carried onto the id this instance uses, so months of uptime survive");

    await fsp.writeFile(seedPath, keptSeed + "\n");
  }

  // A verified domain travels with the data, because the signed statement names
  // the domain and the code but never the instance that verified it. It must NOT
  // arrive verified: importing a badge on another instance's word would let one
  // compromised directory mint verified domains across a federation.
  const claimed = await store.getDomain(paymentCode);
  ok(claimed && claimed.domain === "example.org" && claimed.signed === signedUrlBlock,
     "a domain claim published by the source is carried across intact");
  ok(claimed.verified === false && claimed.last_check === null
     && /awaiting our own DNS/.test(claimed.last_result || ""),
     "and arrives UNVERIFIED, so this instance must see the TXT record itself");

  // a proof whose signature does not check out is refused outright
  ok(r.domains_imported === 1 && r.domains_refused === 1,
     "a proof with a bad signature is refused rather than imported: " + JSON.stringify({ i: r.domains_imported, x: r.domains_refused }));
  ok((await store.getDomain("PM8T" + "9".repeat(112))) === null,
     "and nothing is stored for it");

  await store.deleteDomain(paymentCode);
}

// 19) self-update sourcing: GitHub and peer fetchers verify before trusting,
//     apply() stages a real archive, and the admin routes are gated.
{
  const { fetchFromPeer, applyUpdate } = await import("./self-update.mjs");
  const { packSource } = await import("../scripts/pack-source.mjs");

  // build a real archive to feed the peer fetcher's zip step
  const tmp = await fsp.mkdtemp(pathMod.join(os.tmpdir(), "dojobay-su-"));
  const packed = await packSource({ outDir: tmp });
  const zipBytes = await fsp.readFile(packed.out);

  // a valid peer operator binding (reuse the operator doc from check 18 shape)
  const peerOnion = "f".repeat(56) + ".onion";
  const peerMsg = `http://${peerOnion}/\n\nBIP47: ${paymentCode}`;
  const peerSig = Buffer.from(msg.sign(peerMsg, priv, true, net47.messagePrefix)).toString("base64");
  const peerBlock = `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${peerMsg}\n-----BEGIN BITCOIN SIGNATURE-----\nAddress: ${notifAddr}\n\n${peerSig}\n-----END BITCOIN SIGNATURE-----`;
  const peerOpDoc = { onion: `http://${peerOnion}/`, paymentCode, verifySigned: peerBlock };
  const fetchDoc = async (p) => {
    if (p === "/data/operator.json") return { status: 200, body: JSON.stringify(peerOpDoc) };
    if (p === "/data/version.json") return { status: 200, body: JSON.stringify({ commit: "peercommit" }) };
    throw new Error("404 " + p);
  };
  const fetchZip = async () => ({ status: 200, bodyBuf: zipBytes });

  // wrong trusted code -> refuse before fetching the zip
  await ok(await fetchFromPeer({ onionHost: peerOnion, trustedCode: "PM8T" + "3".repeat(112), fetchDoc, fetchZip, log: () => {} })
    .then(() => false, (e) => /different payment code/.test(e.message)),
    "peer update refuses a peer whose operator code differs from the trusted one");

  // correct code -> returns verified bytes, which apply() stages
  const got = await fetchFromPeer({ onionHost: peerOnion, trustedCode: paymentCode, fetchDoc, fetchZip, log: () => {} });
  // A web root with code in it, because applyUpdate now refuses to replace a
  // tree it could not back up, and an empty directory is not a tree anyone
  // updates. Instance data alongside, so the backup filter is exercised rather
  // than assumed.
  const webRoot = await fsp.mkdtemp(pathMod.join(os.tmpdir(), "dojobay-suweb-"));
  await fsp.mkdir(pathMod.join(webRoot, "server", "data"), { recursive: true });
  await fsp.mkdir(pathMod.join(webRoot, "assets"), { recursive: true });
  await fsp.writeFile(pathMod.join(webRoot, "server", "index.mjs"), "// current");
  await fsp.writeFile(pathMod.join(webRoot, "server", "data", "store.json"), "{}");
  await fsp.writeFile(pathMod.join(webRoot, "assets", "app.js"), "// current");
  const applied = await applyUpdate({ ...got, webRoot, spawnHelper: false, log: () => {} });
  const backedUpStore = await fsp.readFile(pathMod.join(applied.backupDir, "server/data/store.json")).then(() => true, () => false);
  ok(!backedUpStore, "the backup carries code but never the store, which holds sessions and node API keys");
  const stagedOk = await fsp.readFile(pathMod.join(applied.staging, "server/index.mjs")).then(() => true, () => false);
  ok(got.version === "peercommit" && stagedOk && applied.entries > 30,
     "verified peer archive is staged for apply");
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.rm(webRoot, { recursive: true, force: true });

  // admin gating of the job routes
  const anonStart = await fetch(base + "/api/admin/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const anonStatus = await fetch(base + "/api/admin/update/status");
  const adminStatus = await api("/api/admin/update/status");
  ok(anonStart.status === 401 && anonStatus.status === 401 && adminStatus.status === 200,
     "update routes require admin; status readable by admin");
}

// 20) live-detected Dojo version (X-Dojo-Version): rebuild carries the value the
//     updater wrote and folds it into the card version. The version is derived
//     entirely from the node's API detected live wins, pairing is only the
//     bootstrap fallback, and an operator edit can never change it.
{
  const { rebuild, effectiveVersion } = await import("./build-public.ts");
  const id = "mainnet-selftest-node";
  const dojosPath = process.env.PUBLIC_DATA_DIR + "/dojos.json";

  ok(effectiveVersion("1.33.7", "1.28.0") === "1.33.7"
     && effectiveVersion(null, "1.28.0") === "1.28.0"
     && effectiveVersion(null, null) === null,
     "effectiveVersion: detected live version wins, pairing is the fallback");

  // simulate the updater having recorded a live version on the node
  const snap = JSON.parse(await fsp.readFile(dojosPath, "utf8"));
  snap.nodes.find((n) => n.id === id).detected_version = "1.33.7";
  await fsp.writeFile(dojosPath, JSON.stringify(snap, null, 2) + "\n");
  await rebuild();
  let n = JSON.parse(await fsp.readFile(dojosPath, "utf8")).nodes.find((x) => x.id === id);
  ok(n.detected_version === "1.33.7" && n.version === "1.33.7",
     "rebuild carries detected_version and shows it as the card version");

  // an edit that tries to set a version is ignored; the detected value stands
  await api("/api/dojo/edit", "POST", { id, name: "selftest-node", hardware: "RPi5 8GB", version: "0.0.1-hax" });
  n = JSON.parse(await fsp.readFile(dojosPath, "utf8")).nodes.find((x) => x.id === id);
  ok(n.version === "1.33.7" && n.detected_version === "1.33.7",
     "an operator edit cannot override the live-detected version");
}

// 21) live-detected Electrum endpoint (/support/services): rebuild carries what
//     the updater read and publishes it as indexer_url, and nothing else can
//     put a URL there. A node that publishes none yields null so the card can
//     show N/A, which is why a declared URL is no longer a fallback: a healthy
//     node exposing no indexer never acquires a detected value, so the declared
//     one would have been published for good.
{
  const { rebuild, effectiveIndexer } = await import("./build-public.ts");
  const id = "mainnet-selftest-node";
  const dojosPath = process.env.PUBLIC_DATA_DIR + "/dojos.json";
  const live = "tcp://" + "i".repeat(56) + ".onion:50001";
  const declared = "ssl://" + "d".repeat(56) + ".onion:50002";

  ok(effectiveIndexer(live) === live && effectiveIndexer(null) === null
     && effectiveIndexer(undefined) === null,
     "effectiveIndexer: the probed endpoint or nothing");

  // A payload carrying an indexer must not reach a card by any route. The
  // fixture is built the way a Dojo export builds one, with both the flattened
  // indexer and the modern services[] array, because the gate used to read
  // either. `declared` exists in this test only to be refused.
  const withIdx = { pairing: { ...payload.pairing }, explorer: payload.explorer,
                    indexer: { type: "indexer", url: declared },
                    services: [{ type: "indexer", url: declared }] };
  const upd = await api("/api/dojo/pairing", "POST", { id, payload: withIdx, signed: signBlockFor(withIdx) });
  const { store: idxStore } = await import("./store.ts");
  const idxRec = await idxStore.getSubmission(id);
  ok(upd.status === 200 && Object.keys(idxRec.payload).sort().join(",") === "explorer,pairing",
     "an indexer block posted with a pairing update is discarded: the stored payload is what was signed");

  await rebuild();
  const idxNode = JSON.parse(await fsp.readFile(dojosPath, "utf8")).nodes.find((x) => x.id === id);
  ok(idxNode.indexer_url === null && !("indexer" in idxNode.payload),
     "and the card publishes N/A rather than the declared endpoint");

  const snap = JSON.parse(await fsp.readFile(dojosPath, "utf8"));
  snap.nodes.find((n) => n.id === id).detected_indexer = live;
  await fsp.writeFile(dojosPath, JSON.stringify(snap, null, 2) + "\n");
  await rebuild();
  const n = JSON.parse(await fsp.readFile(dojosPath, "utf8")).nodes.find((x) => x.id === id);
  ok(n.detected_indexer === live && n.indexer_url === live,
     "rebuild carries detected_indexer and publishes it as indexer_url");

  const other = JSON.parse(await fsp.readFile(dojosPath, "utf8")).nodes.find((x) => x.id !== id);
  ok(!other || other.indexer_url === null || typeof other.indexer_url === "string",
     "nodes without a probed endpoint publish null (card shows N/A)");
}

// 22) signature gate robustness, from real listings found by the store audit.
//     Wallets and admin panels serialise the pairing JSON differently, and a
//     PayNym signs from its mainnet notification address even for a testnet
//     node. Both used to fail the gate despite the signature being perfect.
{
  const { verifySignedPayload, sameSignedPayload, notificationAddresses } = await import("./crypto.ts");
  const sign = (text, acct) => Buffer.from(msg.sign(text, acct.getNotificationPrivateKey(), true, net47.messagePrefix)).toString("base64");
  const blockOf2 = (text, addr) => `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${text}\n-----BEGIN BITCOIN SIGNATURE-----\nAddress: ${addr}\n\n${sign(text, acct)}\n-----END BITCOIN SIGNATURE-----`;

  // pretty-printed, exactly as several real listings were signed
  const pretty = JSON.stringify(JSON.parse(canonical), null, 2);
  const prettySigned = pretty + "\n\nBIP47:\n" + paymentCode;
  const rPretty = verifySignedPayload({ signedText: blockOf2(prettySigned, notifAddr), expectedMessage: canonical, expectedAddress: notifAddr });

  // same data, keys in a different order
  const src = JSON.parse(canonical);
  const reordered = JSON.stringify({ explorer: src.explorer, pairing: Object.fromEntries(Object.keys(src.pairing).reverse().map((k) => [k, src.pairing[k]])) });
  const reSigned = reordered + "\n\nBIP47:\n" + paymentCode;
  const rReorder = verifySignedPayload({ signedText: blockOf2(reSigned, notifAddr), expectedMessage: canonical, expectedAddress: notifAddr });

  ok(rPretty.ok && rReorder.ok,
     "pretty-printed and key-reordered signatures verify: the same payload, serialised differently");

  // a changed value must still be refused
  const changed = JSON.parse(canonical); changed.pairing.version = "9.9.9";
  const chSigned = JSON.stringify(changed) + "\n\nBIP47:\n" + paymentCode;
  const rChanged = verifySignedPayload({ signedText: blockOf2(chSigned, notifAddr), expectedMessage: canonical, expectedAddress: notifAddr });
  ok(!rChanged.ok && /does not match/.test(rChanged.error)
     && !sameSignedPayload('{"a":1}', '{"a":2}') && sameSignedPayload('{"a":1,"b":2}', '{"b":2,"a":1}')
     && !sameSignedPayload('{"a":1}', '{"a":1,"b":2}'),
     "a changed value, or an added or removed field, is still refused");

  // a PayNym signs from its mainnet address even for a testnet listing
  const addrs = notificationAddresses(paymentCode);
  ok(addrs.length === 2 && addrs[0] === notifAddr,
     "notificationAddresses returns both derivations, mainnet first");
  const rTestnet = verifySignedPayload({ signedText: blockOf2(signedText, notifAddr), expectedMessage: canonical, expectedAddress: addrs, network: "testnet" });
  ok(rTestnet.ok, "a testnet listing signed with the mainnet notification address verifies");
}

// 23) the store auditor must reproduce the gate's verdict, not its own. It
//     once derived the notification address for the record's own network, so
//     every testnet listing was reported as failing while the gate accepted it.
{
  const { auditRecord } = await import("./audit-signed.mjs");
  const rec = (net) => ({ id: `${net}-audit`, network: net, name: "audit", status: "approved",
    paymentCodes: [paymentCode], payload, signed: signedBlock });
  ok(auditRecord(rec("mainnet")).bucket === "VERIFIED", "auditor verifies a good mainnet record");
  ok(auditRecord(rec("testnet")).bucket === "VERIFIED",
     "auditor verifies a testnet record signed with the mainnet notification address (mirrors the gate)");
  ok(auditRecord({ ...rec("mainnet"), signed: null }).bucket === "UNSIGNED", "auditor reports an unsigned record");
  ok(auditRecord({ ...rec("mainnet"), payload: { ...payload, pairing: { ...payload.pairing, apikey: "changed" } } }).bucket === "FAILED",
     "auditor fails a record whose payload no longer matches what was signed");
}

// 24) verified operator domains: the pure parts (normalisation, the TXT record,
//     the DoH answer shape and the grace policy), then the API path with DNS
//     stubbed, since a self-test must not depend on the internet.
{
  const dom = await import("./domains.ts");
  const dns = await import("./dns.ts");
  const { store: st } = await import("./store.ts");

  // normalisation: accept what an operator is likely to type, reject the rest
  ok(dom.normaliseDomain("Example.COM").domain === "example.com"
     && dom.normaliseDomain("https://example.com/").domain === "example.com"
     && dom.normaliseDomain(" https://sub.example.com/path?q=1 ").domain === "sub.example.com"
     && dom.normaliseDomain("xn--bcher-kva.de").domain === "xn--bcher-kva.de",
     "domain normalisation reduces what operators type to a bare ASCII host");
  ok(!dom.normaliseDomain("").ok && !dom.normaliseDomain("localhost").ok
     && !dom.normaliseDomain("192.168.0.1").ok && !dom.normaliseDomain("example.com:8080").ok
     && !dom.normaliseDomain("abc.onion").ok && !dom.normaliseDomain("nodots").ok
     && /onion address cannot be verified/.test(dom.normaliseDomain("abc.onion").error),
     "domain normalisation refuses IPs, ports, localhost, bare labels and onions");

  // the TXT record: strict about the code, tolerant of quoting and whitespace
  const rec = dom.txtValue(paymentCode);
  ok(dom.txtName("example.com") === "_dojobay.example.com"
     && dom.txtMatches(rec, paymentCode)
     && dom.txtMatches('"' + rec + '"', paymentCode)
     && dom.txtMatches(rec.replace(" ", "   "), paymentCode)
     && !dom.txtMatches(rec.replace(/pm=PM8T/, "pm=PM8Tx"), paymentCode)
     && !dom.txtMatches("v=spf1 include:example.com", paymentCode)
     && !dom.txtMatches("dojobay-domain-v1", paymentCode),
     "the TXT record matcher accepts real-world quoting but pins the payment code");

  // DoH answers, including a long record split across quoted strings
  ok(JSON.stringify(dns.parseTxtAnswer(JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '"a" "b"' }] }))) === '["ab"]'
     && JSON.stringify(dns.parseTxtAnswer(JSON.stringify({ Status: 3 }))) === "[]"
     && dns.parseTxtAnswer(JSON.stringify({ Status: 2 })) === null
     && dns.parseTxtAnswer("not json") === null,
     "DoH answers parse: split strings joined, NXDOMAIN empty, SERVFAIL unusable");

  // the signed claim reuses the operator-binding shape
  const claim = dom.signingText("example.com", paymentCode);
  ok(claim === `https://example.com/\n\nBIP47: ${paymentCode}`, "the text to sign is the URL, a blank line, then the BIP47 line");
  const { verifySignedUrlClaim } = await import("./crypto.ts");
  const blockFor = (text) => `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${text}\n-----BEGIN BITCOIN SIGNATURE-----\nAddress: ${notifAddr}\n\n${Buffer.from(msg.sign(text, priv, true, net47.messagePrefix)).toString("base64")}\n-----END BITCOIN SIGNATURE-----`;
  const good = verifySignedUrlClaim({ signed: blockFor(claim), expectedUrl: "https://example.com", paymentCode });
  const wrongDomain = verifySignedUrlClaim({ signed: blockFor(claim), expectedUrl: "https://other.com", paymentCode });
  const tampered = verifySignedUrlClaim({ signed: blockFor(claim).replace("example.com/", "evil.com/"), expectedUrl: "https://evil.com", paymentCode });
  ok(good.ok && !wrongDomain.ok && /this claim is for/.test(wrongDomain.error)
     && !tampered.ok && /invalid signature|does not/.test(tampered.error),
     "a signed domain claim verifies, and is refused for another domain or if altered");

  // grace policy: a badge survives an unreachable resolver, and only drops after
  // a sustained failure, keeping the claim so a restored record restores it
  /** @type {import("../types.js").DomainClaim} */
  const base = { paymentCode, domain: "example.com", signed: "(test)", verified: true,
    verified_at: "2026-01-01T00:00:00Z", last_check: "2026-01-01T00:00:00Z", last_result: "ok",
    fail_since: null, created_at: "2026-01-01T00:00:00Z" };
  const now = Date.parse("2026-07-01T00:00:00Z");
  const inc = dom.applyRecheck(base, { ok: false, inconclusive: true, error: "tor down" }, now);
  const failed1 = dom.applyRecheck(base, { ok: false, inconclusive: false, error: "no TXT record" }, now);
  const failedLong = dom.applyRecheck({ ...base, fail_since: "2026-06-01T00:00:00Z" }, { ok: false, inconclusive: false, error: "no TXT record" }, now);
  const recovered = dom.applyRecheck(failedLong, { ok: true, inconclusive: false }, now);
  ok(inc.verified === true && inc.fail_since === null && /inconclusive/.test(inc.last_result),
     "an unreachable resolver never strips a badge");
  ok(failed1.verified === true && failed1.fail_since
     && failedLong.verified === false
     && recovered.verified === true && recovered.fail_since === null,
     `a missing record drops the badge only after ${dom.GRACE_DAYS} days, and restoring it recovers without re-signing`);

  ok(dom.urlOnDomain("https://example.com/x", "example.com")
     && dom.urlOnDomain("https://a.example.com/", "example.com")
     && !dom.urlOnDomain("https://notexample.com/", "example.com")
     && !dom.urlOnDomain("https://example.com.evil.net/", "example.com")
     && !dom.urlOnDomain("javascript:alert(1)", "example.com"),
     "a card link is only on-domain for the domain itself or a true subdomain");

  // API: prepare returns the exact record and text; submission verifies with DNS
  // stubbed, and admin revocation clears the badge
  const prep = await api("/api/domain/prepare", "POST", { domain: "Example.COM" });
  ok(prep.status === 200 && prep.body.txt_name === "_dojobay.example.com"
     && prep.body.txt_value === rec && prep.body.sign_text === claim,
     "prepare returns the exact TXT record and text to sign");

  await st.deleteDomain(paymentCode);
  const listed = await api("/api/admin/domains");
  ok(listed.status === 200 && Array.isArray(listed.body.domains), "admin can list domain claims");

  await st.putDomain({ paymentCode, domain: "example.org", signed: "(test)", verified: true,
    verified_at: new Date().toISOString(), last_check: new Date().toISOString(), last_result: "ok",
    fail_since: null, created_at: new Date().toISOString() });
  const revoked = await api("/api/admin/domain/revoke", "POST", { paymentCode });
  const after = await st.getDomain(paymentCode);
  const { rebuild: rb } = await import("./build-public.ts");
  await rb();
  const node = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"))
    .nodes.find((n) => n.id === "mainnet-selftest-node");
  ok(revoked.status === 200 && after.verified === false && after.revoked === true
     && node.operator_domain === null && !("name_url" in node),
     "admin revocation drops the badge on the next rebuild, and there is no card link "
     + "left to withhold: the domain badge is the only claim a card carries");
}

// 25) the launcher: server/index.mjs must keep existing and must refuse an old
//     Node before importing the TypeScript server. self-update.mjs sanity-checks
//     an archive by looking for server/index.mjs, and systemd, npm start and the
//     README all name it, so renaming it would break more than it appears.
{
  const launcher = await fsp.readFile(new URL("./index.mjs", import.meta.url), "utf8");
  ok(/process\.versions\.node/.test(launcher) && /< 24/.test(launcher) && /process\.exit\(1\)/.test(launcher),
     "index.mjs refuses Node older than 24 with a message, before importing index.ts");
  ok(/await import\("\.\/index\.ts"\)/.test(launcher) && !/^import .*index\.ts/m.test(launcher),
     "the launcher imports the server dynamically, so the version check runs first");
  ok(/export const server/.test(launcher), "the launcher re-exports the server for callers");

  // build-public.mjs is the same pattern, and its name is depended on from
  // further away: the deploy workflow, npm run build-public, install.mjs and
  // apply-update.mjs, which spawns it DURING a self-update while still running
  // the old copy of itself. A rename would break an instance mid-update.
  const bp = await fsp.readFile(new URL("./build-public.mjs", import.meta.url), "utf8");
  ok(/< 24/.test(bp) && /await import\("\.\/build-public\.ts"\)/.test(bp),
     "build-public.mjs guards the Node version, then imports build-public.ts dynamically");
  ok(/export const rebuild/.test(bp) && /pathToFileURL/.test(bp),
     "the rebuild launcher re-exports rebuild and still runs it when invoked directly");
}

// 26) whitespace repair: the signature covers the blank line before the BIP47
//     line, and copying a block through chat, a form or a mail client routinely
//     eats it. A reconstruction is accepted ONLY if it verifies against an
//     address the declared code derives, so this is search, not trust.
{
  const { repairSignedBlock, verifySignedPayload, notificationAddresses } = await import("./crypto.ts");
  const intact = signedBlock;                                  // json + blank line + BIP47 line
  const mangled = intact.replace(`${canonical}\n\nBIP47:`, `${canonical}\nBIP47:`);
  ok(mangled !== intact, "the fixture really did lose its blank line");

  const before = verifySignedPayload({ signedText: mangled, expectedMessage: canonical, expectedAddress: notifAddr });
  ok(!before.ok && /invalid signature/.test(before.error),
     "a block that lost its blank line fails verification as supplied");

  const fixed = repairSignedBlock(mangled);
  ok(fixed && /blank line/.test(fixed.note || ""), "the repair reports what it changed");
  const after = verifySignedPayload({ signedText: fixed.block, expectedMessage: canonical, expectedAddress: notifAddr });
  ok(after.ok, "the repaired block verifies, so it is safe to store");

  // an intact block is returned unchanged, with nothing to report
  const untouched = repairSignedBlock(intact);
  ok(untouched && untouched.note === null, "an intact block is passed through unrepaired");

  // repair must never rescue a genuinely bad signature, or one whose code does
  // not own the signing address
  const corrupt = mangled.replace(sigLine, sigLine.replace(/^./, (c) => (c === "H" ? "I" : "H")));
  ok(repairSignedBlock(corrupt) === null, "a corrupted signature is not rescued by repair");
  const otherCode = bip47.fromSeed(mnemonicToSeedSync("legal winner thank year wave sausage worth useful legal winner thank yellow")).toBase58();
  ok(repairSignedBlock(intact.replace(paymentCode, otherCode)) === null,
     "a block whose BIP47 code does not derive the signing address is refused");
}

// 27) retention: a rejected submission is kept briefly so a maintainer can undo
//     a mistake, then removed. Nothing used to remove one, so the store kept the
//     payment code, pairing payload, apikey and signature of every operator ever
//     turned down, indefinitely.
{
  const { store: st } = await import("./store.ts");
  /**
   * @param {string} id
   * @param {"pending"|"approved"|"rejected"} status
   * @param {string|undefined} updated
   * @returns {import("../types.js").StoreRecord}
   */
  const mk = (id, status, updated) => ({ id, network: "mainnet", name: id, status,
    paymentCodes: [paymentCode], payload, signed: signedBlock, updated_at: updated });
  const day = 86400 * 1000, now = Date.now();
  await st.putSubmission(mk("mainnet-rej-old", "rejected", new Date(now - 30 * day).toISOString()));
  await st.putSubmission(mk("mainnet-rej-new", "rejected", new Date(now - 2 * day).toISOString()));
  await st.putSubmission(mk("mainnet-rej-nodate", "rejected", undefined));
  await st.putSubmission(mk("mainnet-keep-approved", "approved", new Date(now - 400 * day).toISOString()));
  await st.putSubmission(mk("mainnet-keep-pending", "pending", new Date(now - 400 * day).toISOString()));

  const gone = await st.pruneRejected(14, now);
  const left = (await st.listSubmissions()).map((r) => r.id);
  ok(gone.includes("mainnet-rej-old") && !left.includes("mainnet-rej-old"),
     "a rejection older than the retention window is removed");
  ok(!gone.includes("mainnet-rej-new") && left.includes("mainnet-rej-new"),
     "a recent rejection is kept, so a mistaken rejection can be undone");
  ok(gone.includes("mainnet-rej-nodate"),
     "a rejection with no usable timestamp is removed rather than kept forever");
  ok(left.includes("mainnet-keep-approved") && left.includes("mainnet-keep-pending"),
     "approved and pending records are never touched, however old");

  const stored = await fsp.readFile(process.env.SERVER_DATA_DIR + "/store.json", "utf8");
  ok(!stored.includes("mainnet-rej-old"),
     "the removed record is gone from the store file, apikey and signature included");
  for (const id of ["mainnet-rej-new", "mainnet-rej-nodate", "mainnet-keep-approved", "mainnet-keep-pending"]) {
    await st.deleteSubmission(id);
  }
}

// 28) the domain badge publishes its own proof, so a reader can check the claim
//     with their own tools rather than trusting this instance's tick.
{
  const { store: st } = await import("./store.ts");
  const { rebuild: rb } = await import("./build-public.ts");
  const dojosPath = process.env.PUBLIC_DATA_DIR + "/dojos.json";
  await st.putDomain({ paymentCode, domain: "example.org", signed: signedBlock, verified: true,
    verified_at: "2026-07-01T00:00:00Z", last_check: "2026-07-02T00:00:00Z", last_result: "ok",
    fail_since: null, created_at: "2026-07-01T00:00:00Z" });
  await rb();
  const n = JSON.parse(await fsp.readFile(dojosPath, "utf8")).nodes.find((x) => x.id === "mainnet-selftest-node");
  const pf = n.operator_domain_proof;
  ok(pf && pf.domain === "example.org" && pf.paymentCode === paymentCode,
     "the proof names the domain and the payment code it is bound to");
  ok(pf.txt_name === "_dojobay.example.org" && pf.txt_value === `dojobay-domain-v1 pm=${paymentCode}`,
     "it publishes the exact TXT record a reader should look up");
  ok(pf.signed === signedBlock && pf.verified_at === "2026-07-01T00:00:00Z",
     "and the signed statement, so the signature half can be checked independently");

  // a node whose operator has no verified domain publishes nothing
  await st.deleteDomain(paymentCode);
  await rb();
  const n2 = JSON.parse(await fsp.readFile(dojosPath, "utf8")).nodes.find((x) => x.id === "mainnet-selftest-node");
  ok(n2.operator_domain === null && n2.operator_domain_proof === null,
     "no verified domain means no badge and no proof");
}

// 29) the submission gate repairs a paste that lost its blank line, end to end.
//     Operators paste into a web form, which mangles whitespace exactly as a
//     chat window does, and the signature covers that blank line.
{
  const mangled = signedBlock.replace(`${canonical}\n\nBIP47:`, `${canonical}\nBIP47:`);
  ok(mangled !== signedBlock, "the fixture really did lose its blank line");

  const r = await api("/api/dojo", "POST", {
    network: "mainnet", name: "paste-repair", jurisdiction: "Testland",
    payload, signed: mangled,
  });
  ok(r.status === 200, "a submission whose paste lost the blank line is accepted: " + JSON.stringify(r.body?.error || ""));

  // and what is STORED is the repaired block, so a later audit verifies
  const { store: st } = await import("./store.ts");
  const { auditRecord } = await import("./audit-signed.mjs");
  const rec = (await st.listSubmissions()).find((x) => x.name === "paste-repair");
  ok(rec && rec.signed !== mangled, "the repaired block is stored, not the mangled paste");
  ok(auditRecord(rec).bucket === "VERIFIED", "so the stored record passes a later audit");

  // repair must not rescue a signature that is actually wrong
  const corrupt = mangled.replace(sigLine, sigLine.replace(/^./, (c) => (c === "H" ? "I" : "H")));
  const bad = await api("/api/dojo", "POST", {
    network: "mainnet", name: "paste-repair-bad", jurisdiction: "Testland",
    payload, signed: corrupt,
  });
  ok(bad.status === 400 && /signature gate/.test(bad.body.error),
     "a genuinely bad signature is still refused: " + JSON.stringify(bad.body?.error || ""));

  await st.deleteSubmission(rec.id);
}

// 30) updating pairing details: an operator whose onion changes keeps their
//     listing. Approval binds to the payment code that owns the record, not to
//     a particular address, so the moderation status, the id and therefore the
//     reliability history all survive.
{
  const { store: st } = await import("./store.ts");
  const id = "mainnet-selftest-node";
  const before = await st.getSubmission(id);
  ok(before.status === "approved", "the record under test starts approved");

  const movedUrl = "http://" + "m".repeat(56) + ".onion/v2";
  const moved = { pairing: { ...payload.pairing, url: movedUrl }, explorer: payload.explorer };

  const r = await api("/api/dojo/pairing", "POST", { id, payload: moved, signed: signBlockFor(moved) });
  const after = await st.getSubmission(id);
  ok(r.status === 200 && after.payload.pairing.url === movedUrl,
     "the pairing payload is replaced: " + JSON.stringify(r.body?.error || ""));
  ok(after.status === "approved" && after.id === id,
     "and the listing keeps its approval and its id, so its history survives");

  // published immediately, rather than waiting for the next probe cycle
  const pub = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"))
    .nodes.find((n) => n.id === id);
  ok(pub && pub.payload.pairing.url === movedUrl, "and the card shows the new address at once");

  // a signature, when supplied, must cover the payload being submitted
  const bad = await api("/api/dojo/pairing", "POST", { id, payload: moved, signed: signedBlock });
  ok(bad.status === 400 && /signature gate/.test(bad.body.error),
     "a signature that does not cover the new payload is refused");

  // and omitting it entirely is refused rather than nulling the stored one. An
  // edit with no block used to assign rec.signed = null, which is how a
  // verified listing could quietly become an unattested one.
  const none = await api("/api/dojo/pairing", "POST", { id, payload: moved });
  const stillSigned = await st.getSubmission(id);
  ok(none.status === 400 && /cannot carry over/.test(none.body.error) && stillSigned.signed,
     "an edit with no signed block is refused, told why the old one will not do, and the "
     + "stored signature survives: " + JSON.stringify(none.body?.error || ""));

  // an unreachable address never replaces a working one: point the prober at the
  // proxy that reports "host unreachable", as the submission gate test does
  const dead = { pairing: { ...payload.pairing, url: "http://" + "z".repeat(56) + ".onion/v2" }, explorer: payload.explorer };
  const { PROBE_CFG: PC } = await import("./probe.mjs");
  PC.proxyPort = 19078;
  const down = await api("/api/dojo/pairing", "POST", { id, payload: dead, signed: signBlockFor(dead) });
  PC.proxyPort = 19077;
  const stillThere = await st.getSubmission(id);
  ok(down.status === 422 && /connection gate/.test(down.body.error)
     && stillThere.payload.pairing.url === movedUrl,
     "an unreachable node is refused and the current listing is left alone");

  // and only the owner may do it
  const otherRec = { ...before, id: "mainnet-not-mine", name: "not-mine", paymentCodes: ["PM8T" + "7".repeat(112)] };
  await st.putSubmission(otherRec);
  const notMine = await api("/api/dojo/pairing", "POST", { id: "mainnet-not-mine", payload: moved, signed: signBlockFor(moved) });
  ok(notMine.status === 404, "a record owned by another payment code is not editable");
  await st.deleteSubmission("mainnet-not-mine");

  // restore for later checks
  before.payload = payload; await st.putSubmission(before);
}

// 31) the admin panel shows the same reliability data as the cards. It used to
//     read only pending-probe.json, which the updater stops writing once a
//     record is approved, so every approved listing said "not yet probed" and
//     showed a strip frozen at whatever it had when it was approved.
{
  const dir = process.env.PUBLIC_DATA_DIR;
  const id = "mainnet-selftest-node";
  const dojos = JSON.parse(await fsp.readFile(dir + "/dojos.json", "utf8"));
  const n = dojos.nodes.find((x) => x.id === id);
  n.status = "active"; n.block_height = 906123; n.checked_at = "2026-08-05 00:00";
  n.detected_version = "1.31.0";
  await fsp.writeFile(dir + "/dojos.json", JSON.stringify(dojos, null, 2) + "\n");
  await fsp.writeFile(dir + "/history.json", JSON.stringify({
    interval_minutes: 10, window_checks: 144,
    nodes: { [id]: { checks: Array.from({ length: 12 }, (_, i) => ({ t: "2026-08-05T0" + i, up: true })) } },
  }, null, 2) + "\n");

  const r = await api("/api/admin/submissions");
  const row = r.body.submissions.find((x) => x.id === id);
  ok(row && row.probe && row.probe_source === "published",
     "an approved record's probe data comes from the published view");
  ok(row.probe.status === "active" && row.probe.block_height === 906123,
     "so its live status and chain tip are what the card shows");
  ok(Array.isArray(row.probe.checks) && row.probe.checks.length === 12,
     "and its reliability strip has the full window, not a single block");
  ok(row.version === "1.31.0",
     "the version shown is the live-detected one, not the pairing payload's");
}

// 32) a listing without a BIP47 payment code is structurally impossible. The
//     store is the single chokepoint every write passes through, so refusing
//     there is what makes it impossible rather than merely discouraged, and the
//     rebuild withholds any that predate the rule instead of publishing them.
{
  const { store: st } = await import("./store.ts");
  const { rebuild: rb } = await import("./build-public.ts");
  const base = { network: "mainnet", name: "orphan", status: "approved", payload };

  let threw = null;
  try { await st.putSubmission(/** @type {any} */ ({ ...base, id: "mainnet-orphan", paymentCodes: [] })); }
  catch (e) { threw = e; }
  ok(threw && /must carry a BIP47 payment code/.test(threw.message),
     "the store refuses a record with no payment code");

  let threw2 = null;
  try { await st.putSubmission(/** @type {any} */ ({ ...base, id: "mainnet-orphan2" })); }
  catch (e) { threw2 = e; }
  ok(threw2, "and one with no paymentCodes field at all");
  ok((await st.getSubmission("mainnet-orphan")) === null, "nothing is written when it refuses");

  // A record that predates the rule, injected past putSubmission, is withheld
  // from the published list rather than shown. Injected into the LOADED store,
  // not into store.json: the store holds itself in memory as a single writer
  // and load() returns that cache, so a record written to the file behind a
  // running process is invisible to the rebuild. This test used to write the
  // file, which meant it asserted that a record the rebuild had never heard of
  // did not appear — true, and no evidence of anything.
  const loaded = await st.get();
  loaded.submissions["mainnet-legacy-orphan"] =
    /** @type {any} */ ({ ...base, id: "mainnet-legacy-orphan", paymentCodes: [], signed: signedBlock });
  await rb();
  const pub = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"));
  ok(!pub.nodes.some((n) => n.id === "mainnet-legacy-orphan"),
     "a code-less record already in the store is withheld from the published list");

  delete loaded.submissions["mainnet-legacy-orphan"];
  await rb();
}

// 33) minimum Dojo version, judged on what the node reports live and applied to
//     registration only. The version inside a pairing payload is frozen when
//     that payload was generated, so a current node can honestly declare an
//     ancient one; judging on the declared value would refuse working nodes and
//     admit old ones.
{
  const dv = await import("./dojo-version.ts");

  ok(dv.compareVersions("1.27", "1.27.0") === 0
     && dv.compareVersions("1.29.2", "1.27.0") === 1
     && dv.compareVersions("1.4.5", "1.27.0") === -1
     && dv.compareVersions("v1.28.0-rc1", "1.28.0") === 0,
     "versions compare numerically, so 1.4.5 is below 1.27.0 and 1.27 equals 1.27.0");

  ok(dv.meetsMinimum("1.27.0", "1.27.0") && dv.meetsMinimum("1.31.0", "1.27.0")
     && !dv.meetsMinimum("1.26.1", "1.27.0") && dv.meetsMinimum("1.0.0", ""),
     "an empty minimum disables the check entirely");

  // the detected version wins over a stale declared one, in both directions
  const stale = dv.judgeVersion("1.26.1", "1.29.9", "1.27.0");
  const current = dv.judgeVersion("1.29.2", "1.4.5", "1.27.0");
  ok(!stale.ok && stale.source === "detected"
     && current.ok && current.source === "detected" && current.version === "1.29.2",
     "the live-detected version decides, not the payload's frozen claim");

  const silent = dv.judgeVersion(null, null, "1.27.0");
  ok(!silent.ok && silent.version === null && /did not report a version/.test(silent.reason || ""),
     "a node reporting no version at all is refused, and told why");

  // registration is gated; an existing operator updating a listing is not
  const { store: st } = await import("./store.ts");
  const before = await st.getSubmission("mainnet-selftest-node");
  const resubmit = await api("/api/dojo", "POST", {
    network: "mainnet", name: "selftest-node", jurisdiction: "Testland", payload, signed: signedBlock,
  });
  ok(resubmit.status === 200,
     "an operator updating a listing they already hold is not re-judged: " + JSON.stringify(resubmit.body?.error || ""));
  ok((await st.getSubmission("mainnet-selftest-node")).id === before.id,
     "and keeps the same record");
}

// 34) the resource diagnostic must not hand an operator-set path to a
//     subprocess. It used to run `df ... $WEB_ROOT` and `du -sb $PUBLIC_DIR`,
//     which CodeQL flagged as js/shell-command-injection-from-environment and
//     which really does misbehave: df and du read a leading hyphen as an option,
//     so WEB_ROOT=-x measured something other than what was asked for and said
//     nothing about it. statfs() and a walk answer both questions inside Node.
//     Two of the checks below read the source rather than the behaviour, because
//     the point is that the dataflow is gone and not merely escaped; the rest
//     assert on values, which is the better instrument wherever it is available.
{
  const cr = await import("./check-resources.ts");
  const src = await fsp.readFile(new URL("./check-resources.ts", import.meta.url), "utf8");

  // every sh() call site takes a literal command and a literal argument list.
  // A variable in either is the regression this exists to catch. One identifier
  // is allowed through: `unit`, which the loop takes from the exported UNITS.
  // Anything else must be a string literal, so reinstating `sh("du", ["-sb", p])`
  // fails here rather than shipping. Widening the allowlist should require an
  // argument about where that value comes from.
  const ALLOWED = new Set(["UNITS", "unit"]);
  const calls = [...src.matchAll(/\bsh\(([^)]*?)\)/gs)].map((m) => m[1]);
  ok(calls.length >= 2, "the diagnostic still shells out for what only a binary can answer");
  const identifiers = calls.flatMap((c) =>
    [...c.replace(/"(?:[^"\\]|\\.)*"/g, "").matchAll(/[A-Za-z_$][\w$.]*/g)].map((m) => m[0]));
  ok(identifiers.every((i) => ALLOWED.has(i)) && !calls.some((c) => c.includes("`")),
     "no sh() call site passes anything but a string literal and a known unit name: "
     + JSON.stringify(identifiers));

  // UNITS is checked as a value, not as text. The previous version of this
  // matched the declaration with a regex whose repeated group could match the
  // same input two ways, which CodeQL flagged as js/redos and which really was
  // exponential: 24 quoted tokens with no closing bracket took 356 ms, doubling
  // every two. Nothing untrusted ever reached it, but a test asserting on the
  // spelling of a line was the wrong instrument for the question anyway.
  ok(Array.isArray(cr.UNITS) && cr.UNITS.length >= 2
     && cr.UNITS.every((u) => typeof u === "string" && u.endsWith(".service") && !u.includes("/")),
     "the units the diagnostic asks systemctl about are a fixed list: " + cr.UNITS.join(", "));
  const decl = src.slice(src.indexOf("export const UNITS"), src.indexOf("];", src.indexOf("export const UNITS")));
  ok(decl.length > 0 && !/process\.env|`|\$\{|\(/.test(decl),
     "and that list is written out in the file, not read from the environment");
  ok(!/sh\(\s*"(?:du|df|sh|bash)"/.test(src),
     "df, du and a shell are gone: nothing spawns a process that parses a path");

  // dirSize replaces `du -sb`, so it must agree with it, and it must not follow
  // a symlink out of the tree it was asked about.
  const root = pathMod.join(os.tmpdir(), "dojobay-dirsize-" + Date.now());
  await fsp.mkdir(pathMod.join(root, "nested"), { recursive: true });
  await fsp.writeFile(pathMod.join(root, "a.bin"), Buffer.alloc(1000));
  await fsp.writeFile(pathMod.join(root, "nested", "b.bin"), Buffer.alloc(2000));
  const outside = pathMod.join(os.tmpdir(), "dojobay-dirsize-outside-" + Date.now());
  await fsp.writeFile(outside, Buffer.alloc(9_000_000));
  await fsp.symlink(outside, pathMod.join(root, "link.bin"));
  const size = await cr.dirSize(root);
  const linkSize = (await fsp.lstat(pathMod.join(root, "link.bin"))).size;
  ok(size === 3000 + linkSize,
     `dirSize sums a tree and counts a symlink without following it: ${size}`);
  ok(await cr.dirSize(pathMod.join(root, "missing")) === null,
     "a path that is not there reports nothing rather than zero");

  // the bug itself: a root whose name begins with a hyphen. du read that as an
  // option and reported the wrong tree; nothing in Node cares.
  const cwd = process.cwd();
  process.chdir(os.tmpdir());
  const hyphen = "-dojobay-" + Date.now();
  await fsp.mkdir(hyphen, { recursive: true });
  await fsp.writeFile(pathMod.join(hyphen, "c.bin"), Buffer.alloc(4096));
  ok(await cr.dirSize(hyphen) === 4096,
     "a path beginning with a hyphen is measured, not parsed as an option");
  await fsp.rm(hyphen, { recursive: true, force: true });
  process.chdir(cwd);

  // diskUsage replaces `df`, and the identity it must keep is df's: available
  // excludes the root reserve, so it is never more than what is unused.
  const du = await cr.diskUsage(os.tmpdir());
  ok(du && du.size > 0 && du.used >= 0 && du.avail >= 0 && du.used + du.avail <= du.size,
     "diskUsage reports a filesystem's size, used and available consistently");
  ok(await cr.diskUsage(pathMod.join(root, "nowhere", "at", "all")) === null,
     "and reports nothing for a path on no filesystem it can see");

  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { force: true });
}

// 35) a listing without a signed pairing block is structurally impossible, on
//     the same three-point pattern as the payment-code rule in 32: the gates
//     refuse it with something an operator can act on, the store refuses it
//     however the record was assembled, and the rebuild withholds anything that
//     predates the rule rather than publishing it. The signature is the only
//     part of a listing a visitor can check without trusting this site, so a
//     listing without one asks for trust that cannot be earned.
{
  const { store: st } = await import("./store.ts");
  const { rebuild: rb } = await import("./build-public.ts");
  const base = { network: "mainnet", name: "mute", status: "approved",
                 paymentCodes: [paymentCode], payload };

  let threw = null;
  try { await st.putSubmission(/** @type {any} */ ({ ...base, id: "mainnet-mute" })); }
  catch (e) { threw = e; }
  ok(threw && /must carry a signed pairing block/.test(threw.message),
     "the store refuses a record with no signed block");
  ok(threw && /remove-listing/.test(threw.message),
     "and says what to do about it rather than only that it refused");
  ok((await st.getSubmission("mainnet-mute")) === null, "nothing is written when it refuses");

  // a shape check, not a verification: whether the block verifies is settled at
  // the gates, which have the session and the canonical message to hand.
  let threw2 = null;
  try { await st.putSubmission(/** @type {any} */ ({ ...base, id: "mainnet-mute2", signed: "I promise it is mine" })); }
  catch (e) { threw2 = e; }
  ok(threw2, "and refuses a signed field that is not a signed-message block at all");

  // the submit gate refuses first, before the connection gate spends thirty
  // seconds probing a node whose submission cannot be accepted anyway
  const noSig = await api("/api/dojo", "POST", {
    network: "mainnet", name: "gate-mute", jurisdiction: "Testland", payload,
  });
  ok(noSig.status === 400 && /signature gate/.test(noSig.body.error)
     && /PayNym/.test(noSig.body.error),
     "the submit gate refuses an unsigned submission and says how to sign: "
     + JSON.stringify(noSig.body?.error || ""));
  ok(!(await st.getSubmission("mainnet-gate-mute")), "and no record is created by the attempt");

  // a record that predates the rule, injected past the store, is withheld from
  // the published list rather than shown
  const legacy = /** @type {any} */ ({ ...base, id: "mainnet-legacy-mute", name: "legacy-mute" });
  const loaded = await st.get();
  loaded.submissions["mainnet-legacy-mute"] = legacy;
  await rb();
  const pub = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"));
  ok(!pub.nodes.some((n) => n.id === "mainnet-legacy-mute"),
     "an unsigned record already in the store is withheld from the published list");

  // and the audit calls it a failure now, rather than leaving it as a decision
  const { auditRecord } = await import("./audit-signed.mjs");
  ok(auditRecord(legacy).bucket === "UNSIGNED",
     "the auditor still buckets it as UNSIGNED, which now exits non-zero");

  delete loaded.submissions["mainnet-legacy-mute"];
  await rb();
}

// 34a) signing in discards the cached update check. The cache lives in the
//      process, not the session, so signing out and back in did not clear it
//      and only a service restart would: an operator who had just pushed was
//      told they were up to date with no way to say otherwise.
{
  const idx = await fsp.readFile(new URL("./index.ts", import.meta.url), "utf8");
  const cb = idx.slice(idx.indexOf('/api\\/auth47\\/callback'), idx.indexOf("/api\\/auth47\\/poll"));
  ok(/UPDATES_CACHE = null/.test(cb),
     "the Auth47 callback clears it, which is the moment somebody is about to look");
  // and the declaration precedes the use, so reordering the file cannot turn
  // this into a dead-zone error at runtime
  ok(idx.indexOf("let UPDATES_CACHE = null;") < idx.indexOf("UPDATES_CACHE = null;",
     idx.indexOf("let UPDATES_CACHE = null;") + 10),
     "and is declared above the code that clears it");
  // The TTL itself lives in updateCacheDecision's default, with the floor, and
  // its behaviour is asserted in section 17 rather than by matching a literal.
  // What matters here is that the route does not carry a second copy: two
  // definitions of a cache window disagree eventually, and the disagreement is
  // invisible until somebody wonders why a check is older than it should be.
  const upd = await fsp.readFile(new URL("./updates.mjs", import.meta.url), "utf8");
  ok(/ttlMs = 6 \* 3600 \* 1000/.test(upd) && !/6 \* 3600 \* 1000/.test(idx),
     "the unattended TTL is defined once, in updates.mjs: six hours is right for a background check over Tor");
  ok(/updateCacheDecision\(/.test(idx),
     "and the route asks for the decision rather than reimplementing the window");
}

// 34b) the flag on a card is inferred from the one free-text answer an operator
//      gives about where they are, and nothing is enforced. There used to be a
//      separate code field, sliced to two characters and upper-cased, which
//      rejected nothing: "FIN" silently became "FI" and was published as
//      whichever country those letters name, while a single letter or half a
//      pasted flag emoji were stored as given and rendered as letterboxes.
{
  const { countryFor } = await import("./dojo-version.ts");
  ok(countryFor("Finland") === "FI" && countryFor("Helsinki, Finland") === "FI",
     "a country is recognised, in a sentence or on its own");
  ok(countryFor("UK") === "GB", "including the one that is not a code");
  ok(countryFor("Europe") === null && countryFor("Ancapistan") === null,
     "and a generic or invented answer is allowed, with no flag and no complaint");
  ok(countryFor("XX") === null, "an unassigned pair is not a flag");

  const idx = await fsp.readFile(new URL("./index.ts", import.meta.url), "utf8");
  ok(/country: countryFor\(body\.jurisdiction\)/.test(idx),
     "the gate infers from the location answer rather than asking separately");
  ok(!/slice\(0, 2\)\.toUpperCase\(\)/.test(idx), "the old truncation is gone");

  await api("/api/dojo", "POST", { network: "mainnet", name: "cc-node",
    jurisdiction: "Ancapistan", payload, signed: signedBlock });
  const { store: st34b } = await import("./store.ts");
  const rec = await st34b.getSubmission("mainnet-cc-node");
  ok(!rec || rec.country === null,
     "a location that names nowhere stores no code: " + JSON.stringify(rec && rec.country));
  ok(!rec || rec.jurisdiction === "Ancapistan",
     "while the answer itself is kept exactly as written");
}

// 35a) a listing's endpoint must be for the network it claims. A Dojo serves
//      testnet under a `test` path segment and mainnet without one, so the two
//      are checkable against each other, and a crossed pair is wrong in a way
//      nothing downstream catches: it answers, reports a height, and probes
//      green forever. The installer applies the same rule from the same
//      function; this is the other door into the same store.
{
  const { pairingNetwork } = await import("./dojo-version.ts");
  const onion = "b3krcphqdbrzkblvti2eiuogfrx6b5lynenv5dxjwsw7hq47dlrc4pid";
  ok(pairingNetwork(`http://${onion}.onion/test/v2`) === "testnet", "a /test/ segment reads as testnet");
  ok(pairingNetwork(`http://${onion}.onion/v2`) === "mainnet", "and its absence as mainnet");
  // a whole segment, never a substring: an onion address is base32 and can carry
  // those four letters by chance, and /v2/testing is not a testnet endpoint
  ok(pairingNetwork(`http://test${onion.slice(4)}.onion/v2`) === "mainnet",
     "letters inside the onion address are not a path segment");
  ok(pairingNetwork(`http://${onion}.onion/v2/testing`) === "mainnet",
     "nor is a segment that merely begins with them");

  const testnetPayload = { pairing: { type: "dojo.api", version: "1.29.2", apikey: "k",
    url: `http://${onion}.onion/test/v2` } };
  const crossed = await api("/api/dojo", "POST",
    { network: "mainnet", name: "crossed-node", payload: testnetPayload, signed: signedBlock });
  ok(crossed.status === 400 && /testnet endpoint/.test(crossed.body.error || ""),
     "a testnet endpoint submitted as mainnet is refused: " + JSON.stringify(crossed.body.error));

  const otherWay = await api("/api/dojo", "POST",
    { network: "testnet", name: "crossed-node", payload, signed: signedBlock });
  ok(otherWay.status === 400 && /mainnet endpoint/.test(otherWay.body.error || ""),
     "and a mainnet endpoint submitted as testnet: " + JSON.stringify(otherWay.body.error));
  ok(/test\/v2/.test(otherWay.body.error || ""),
     "with the shape the operator should be looking for, not just a refusal");

  const { store: st35a } = await import("./store.ts");
  ok(!(await st35a.getSubmission("mainnet-crossed-node"))
     && !(await st35a.getSubmission("testnet-crossed-node")),
     "and neither attempt leaves a record behind");
}

// 35b) the archive download must ask for a media type the endpoint will serve.
//      It asked for application/octet-stream, and GitHub's archive route
//      answers 415 to that, so self-update failed on its first request and was
//      never once seen to work. Checked against the live endpoint while fixing
//      it: octet-stream 415, application/vnd.github+json 302, */* 302, and the
//      302 goes to codeload, which this transport already follows.
{
  const { githubRequestHead } = await import("./updates.mjs");
  const head = (opts) => githubRequestHead("/repos/Dojobay/dojobay/zipball/abc", "api.github.com", opts);

  const accept = (h) => (h.match(/\r\nAccept:\s*([^\r\n]+)/) || [])[1];
  ok(accept(head({ binary: true })) === "*/*",
     "a download asks for anything the route serves: " + JSON.stringify(accept(head({ binary: true }))));
  ok(!/octet-stream/.test(head({ binary: true })),
     "and specifically not octet-stream, which this endpoint refuses outright");
  ok(accept(head({})) === "application/vnd.github+json",
     "while metadata calls keep the type that pins the API version");

  // the rest of the request has to stay a well-formed HTTP/1.1 head, since the
  // reply parser depends on Connection: close and on identity encoding.
  const h = head({ binary: true });
  ok(/^GET \/repos\/Dojobay\/dojobay\/zipball\/abc HTTP\/1\.1\r\n/.test(h), "request line intact");
  ok(/\r\nHost: api\.github\.com\r\n/.test(h), "Host is the hop's host, not a constant");
  ok(/\r\nAccept-Encoding: identity\r\n/.test(h) && /\r\nConnection: close\r\n\r\n$/.test(h),
     "identity encoding and Connection: close, which the reply parser relies on");
}

// 36) the published file is produced by an allowlist, and only by that
//     allowlist. The store holds moderation status, the owning payment codes,
//     submission timestamps, the probe result recorded at submission and import
//     provenance, none of which belong to the public. A redaction list would be
//     wrong by default and would need updating every time the store grew a
//     field; naming the output instead is right by default. These checks are
//     what stop that property being lost quietly.
{
  const { store: st } = await import("./store.ts");
  const { rebuild: rb, PUBLIC_NODE_KEYS } = await import("./build-public.ts");
  const loaded = await st.get();

  // A record carrying every field the store type knows about, plus four it does
  // not. The extras are the point: store.json is JSON, so the TypeScript
  // interface constrains what we WRITE and not what is there, and a field added
  // by a future endpoint, a migration or a hand edit is exactly the case an
  // allowlist has to survive.
  loaded.submissions["mainnet-allowlist"] = /** @type {any} */ ({
    id: "mainnet-allowlist", network: "mainnet", name: "allowlist", status: "approved",
    paymentCodes: [paymentCode, "PMsecondCodeNobodyShouldSee"], payload, signed: signedBlock,
    jurisdiction: "Testland", country: "TL", hardware: "a box", paynym: "+al", name_url: null,
    last_probe: { up: true, reason: "http", ms: 5 },
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-02T00:00:00Z",
    source: "bootstrap-import:some.onion",
    // not in StoreRecord at all
    moderator_note: "operator was rude in DMs",
    session_hint: "sid-should-never-be-published",
    internal_score: 0.42,
    admin_only: { reviewer: "max" },
  });
  await rb();
  const pub = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"));
  const node = pub.nodes.find((n) => n.id === "mainnet-allowlist");
  ok(node, "the record is published at all, so the rest of this is meaningful");

  // The exact key set. Not a subset check: a field appearing in the output
  // without being named here must fail, which is the whole request.
  const keys = Object.keys(node).sort();
  ok(JSON.stringify(keys) === JSON.stringify([...PUBLIC_NODE_KEYS].sort()),
     "the published node's keys are exactly the allowlist. Unexpected: "
     + JSON.stringify(keys.filter((k) => !PUBLIC_NODE_KEYS.includes(k)))
     + " missing: " + JSON.stringify(PUBLIC_NODE_KEYS.filter((k) => !keys.includes(k))));

  // And named, so a failure says which secret escaped rather than only that the
  // shape changed.
  for (const k of ["moderator_note", "session_hint", "internal_score", "admin_only",
                   "last_probe", "created_at", "updated_at", "source", "paymentCodes"]) {
    ok(!(k in node), `${k} is not published`);
  }
  // The moderation status is published as a FIELD, but never with a moderation
  // VALUE: the public status is a liveness state written by the probe, and the
  // store's pending/approved/rejected must not reach it.
  ok(!["pending", "approved", "rejected"].includes(node.status),
     "the public status is a liveness state, not a moderation state: " + node.status);
  // Ownership is published as one display code, never the full set.
  ok(typeof node.paymentCode === "string" && !JSON.stringify(pub).includes("PMsecondCodeNobodyShouldSee"),
     "only the display payment code is published, not every code the owner holds");

  // The seed anchor is held to the same allowlist. It used to be published as
  // it sits in seed.json, so the file had two producers and one filter.
  const seedPath = process.env.PUBLIC_DATA_DIR + "/seed.json";
  const seedDoc = JSON.parse(await fsp.readFile(seedPath, "utf8"));
  seedDoc.nodes[0].operator_private_note = "not for publication";
  await fsp.writeFile(seedPath, JSON.stringify(seedDoc, null, 2) + "\n");
  await rb();
  const pub2 = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"));
  const anchor = pub2.nodes.find((n) => n.id === seedDoc.nodes[0].id);
  ok(anchor, "the seed anchor is published");
  ok(!("operator_private_note" in anchor),
     "a field added to seed.json is not published just because it is in seed.json");
  ok(JSON.stringify(Object.keys(anchor).sort()) === JSON.stringify([...PUBLIC_NODE_KEYS].sort()),
     "and the anchor's keys are the same allowlist as any other node: "
     + JSON.stringify(Object.keys(anchor).sort()));

  delete loaded.submissions["mainnet-allowlist"];
  delete seedDoc.nodes[0].operator_private_note;
  await fsp.writeFile(seedPath, JSON.stringify(seedDoc, null, 2) + "\n");
  await rb();
}

// 37) one definition of the canonical pairing string. crypto.ts owns it, and
//     every other file under server/ must import it rather than write the
//     expression again. This has already gone wrong twice: the string lived in
//     the submission gate and in audit-signed.mjs, the second carrying a comment
//     warning it MUST mirror the first, and after that consolidation two more
//     copies appeared in apply-signed-payload.ts and diagnose-signed.mjs. A
//     canonical message with several definitions eventually disagrees with
//     itself, and the disagreement is silent in the worst direction: a signature
//     accepted at submission and reported invalid by a later audit.
//
//     Scoped to non-test source under server/. The expression is deliberately
//     reimplemented twice in this file, so a test does not check the code
//     against itself, and assets/js/app.js writes its own because it cannot
//     import server code and is building display text, not a message to verify.
{
  const dir = new URL("./", import.meta.url);
  const sources = (await fsp.readdir(dir))
    .filter((f) => /\.(ts|mjs)$/.test(f) && f !== "selftest.mjs")
    .sort();
  ok(sources.includes("crypto.ts") && sources.length >= 10,
     `the scan sees the server source: ${sources.length} files`);

  // JSON.stringify over an object literal naming both keys, whatever the
  // payload is called and whichever order they are in. Matching on the shape
  // rather than an exact string is the point: a copy that renamed its argument
  // is still a copy.
  const stringifyLiterals = (src) =>
    [...src.matchAll(/JSON\.stringify\(\s*\{([^{}]*)\}/g)]
      .map((m) => m[1])
      .filter((body) => /\bpairing\s*:/.test(body) && /\bexplorer\s*:/.test(body));

  // Comment lines are dropped before any of this runs. The scan is about
  // bindings and uses in code, and a file is entitled to discuss the canonical
  // string in prose without being told to import it: build-public.ts explains
  // in a comment that the signature does not cover the declared indexer, names
  // canonicalPairing while doing so, and imports nothing. Only whole-line
  // comments are removed, so a trailing comment can still hide a use from the
  // scan; that direction is a missed alarm rather than a false one.
  const codeOnly = (src) => {
    const out = [];
    let inBlock = false;
    for (const line of src.split("\n")) {
      const t = line.trim();
      if (inBlock) { if (t.includes("*/")) inBlock = false; continue; }
      if (t.startsWith("/*")) { if (!t.includes("*/")) inBlock = true; continue; }
      if (t.startsWith("//") || t.startsWith("*")) continue;
      out.push(line);
    }
    return out.join("\n");
  };

  const defines = [], redeclares = [], missingImport = [];
  for (const f of sources) {
    const src = codeOnly(await fsp.readFile(new URL(f, dir), "utf8"));
    if (stringifyLiterals(src).length) defines.push(f);
    if (!/\bcanonicalPairing\b/.test(src)) continue;
    // A local binding of that name shadows the shared one and defeats the check
    // above the moment it is written any other way.
    if (f !== "crypto.ts" && /(?:const|let|var|function)\s+canonicalPairing\b/.test(src)) redeclares.push(f);
    if (f !== "crypto.ts" && !/import\s*\{[^}]*\bcanonicalPairing\b[^}]*\}\s*from\s*["']\.\/crypto\.ts["']/.test(src)) missingImport.push(f);
  }

  ok(defines.length === 1 && defines[0] === "crypto.ts",
     `the canonical pairing expression is written once, in crypto.ts (found in: ${defines.join(", ") || "nothing"})`);
  ok(!redeclares.length,
     `no file redeclares canonicalPairing locally (offenders: ${redeclares.join(", ") || "none"})`);
  ok(!missingImport.length,
     `every user of canonicalPairing imports it from crypto.ts (offenders: ${missingImport.join(", ") || "none"})`);

  // And the shared definition is the one the gate actually verifies against, so
  // the files above are not merely agreeing with each other about the wrong text.
  const { canonicalPairing: cp } = await import("./crypto.ts");
  ok(cp(payload) === JSON.stringify({ pairing: payload.pairing, explorer: payload.explorer }),
     "crypto.ts's canonicalPairing produces the text this suite signs");
}

await fsp.rm(process.env.PUBLIC_DATA_DIR, { recursive: true, force: true });

console.log(`\nall ${passed} checks passed`);
proxy.close();
process.exit(0);
