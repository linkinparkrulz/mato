// Auth47 login and BIP47 signed-payload verification for The Dojo Bay backend.
// Thin wrappers over the audited Samourai libraries; the exact call shapes here
// were verified against the libraries end to end (see selftest.mjs).
import { Auth47Verifier } from "@dojo-tools/auth47";
import { BIP47Factory } from "@dojo-tools/bip47";
import { bitcoinMessageFactory } from "@dojo-tools/bitcoinjs-message";
import * as bip47utils from "@dojo-tools/bip47/utils";
import ecc from "@bitcoinerlab/secp256k1";

/** Outcome of a signature check: either accepted, or refused with a reason an
 *  operator can act on. */
export type VerifyResult =
  | { ok: true; error?: undefined; address?: string; paymentCode?: string | null }
  | { ok: false; error: string; address?: undefined; paymentCode?: undefined };

/** The parts of a wallet-exported signed block. */
export interface ParsedBlock {
  /** Everything the signature covers, including the BIP47 tail. */
  message: string;
  /** The pairing JSON alone. */
  pairingText: string;
  /** The payment code inside the signed text, when present. */
  paymentCode: string | null;
  address: string;
  signature: string;
}

const bip47 = BIP47Factory(ecc);
const message = bitcoinMessageFactory(ecc);

// ---- Auth47 ----------------------------------------------------------------
// The verifier needs to know its own callback URL. We build it from the site's
// base URL (the .onion origin) at construction time.
export function makeAuth47(baseUrl) {
  const callback = new URL("/api/auth47/callback", baseUrl).toString();
  const verifier = new Auth47Verifier(ecc, callback);

  // Full challenge URI shown to the wallet (includes the callback `c`).
  function challengeURI(nonce, expires, resource) {
    return verifier.generateURI({ nonce, expires, resource });
  }

  // Per the spec, the wallet signs the challenge WITHOUT the callback param.
  // Given the full URI we generated, produce the value the proof must contain.
  function signedForm(fullUri) {
    const u = new URL(fullUri);
    u.searchParams.delete("c");
    return decodeURIComponent(u.toString());
  }

  // Two URLs naming the same resource. Compared as parsed URLs rather than as
  // strings, so a trailing slash or a difference in host case is not treated as
  // a different site, while a different origin or path is. Anything that does
  // not parse is not equal to anything.
  function sameResource(a: string, b: string): boolean {
    try {
      const norm = (u: string) => {
        const x = new URL(u);
        return x.origin.toLowerCase() + x.pathname.replace(/\/+$/, "") + x.search;
      };
      return norm(a) === norm(b);
    } catch { return false; }
  }

  // Verify a posted proof. Returns { ok, paymentCode } or { ok:false, error }.
  //
  // expectedResource is REQUIRED, and the shape is the point. A signature is
  // only ever evidence of what it was made over, so a verifier that takes only
  // the thing being verified can answer "is this signed?" but never "is this
  // signed FOR ME?". The other three verifiers in this file all take an
  // expectation for that reason: verifySignedPayload takes expectedMessage and
  // expectedAddress, verifySignedUrlClaim takes expectedUrl, verifyOperatorDoc
  // takes expectedOnion. This one did not, and the missing binding was
  // invisible rather than a missing argument.
  //
  // What it prevents: the library checks that the challenge's r parameter is a
  // well-formed http(s) URL, but it cannot know which URL is ours. Without this
  // comparison an attacker could take a live nonce from this instance, show a
  // victim the same challenge with r rewritten to their own site, and relay the
  // resulting proof back here. The victim's wallet would display the attacker's
  // site, the signature would verify, and a session would be minted here in the
  // victim's name. The r parameter exists so a person can see what they are
  // signing into, and this check is what makes that display mean anything.
  function verify(proof: unknown, { expectedResource }: { expectedResource?: string } = {}): VerifyResult {
    // Fail closed rather than throwing: a caller who forgot this is a bug, but
    // a 500 from an auth endpoint is a worse way to find out than a refusal
    // that names the omission.
    if (!expectedResource) {
      return { ok: false, error: "internal: no expected resource supplied, refusing to verify an unbound proof" };
    }
    const res = verifier.verifyProof(proof);
    if (res.result !== "ok") return { ok: false, error: res.error };
    // Read the resource from the challenge the signature actually covers, not
    // from anything the caller passed alongside it.
    const challenge = (proof as { challenge?: unknown }).challenge;
    let resource: string | null = null;
    try { resource = new URL(String(challenge)).searchParams.get("r"); } catch { /* unparseable */ }
    if (!resource || !sameResource(resource, expectedResource)) {
      return { ok: false, error: `proof was signed for a different site (${resource || "no resource"}), not this one` };
    }
    // Auth47 defines two proof shapes: a nym proof carrying a payment code, and
    // an address proof carrying a plain address. Only the former identifies an
    // operator here, and reading .nym off the wrong one would bind a session to
    // undefined, so require it explicitly rather than assuming.
    const nym = (res.data as { nym?: string }).nym;
    if (typeof nym !== "string" || !nym) {
      return { ok: false, error: "proof does not carry a payment code (an address proof cannot identify an operator)" };
    }
    return { ok: true, paymentCode: nym };
  }

  return { challengeURI, signedForm, verify, callback };
}

// ---- payment code -> notification address ----------------------------------
export function notificationAddress(paymentCode: string, network: string = "bitcoin"): string {
  const net = bip47utils.networks[network];
  return bip47.fromBase58(paymentCode, net).getNotificationAddress();
}

// The exact text an operator signs to attest to a pairing payload, and the
// exact text every gate checks a signature against.
//
// It lives here because it had grown two copies, in the submission gate and in
// audit-signed.mjs, the second carrying a comment warning that it MUST mirror
// the first. A canonical message that exists twice is a canonical message
// waiting to disagree with itself, and the failure would be quiet in the worst
// direction: signatures accepted at submission and reported as invalid by a
// later audit, or the reverse. The installer needs it too, which would have
// made three.
export function canonicalPairing(payload: { pairing?: unknown; explorer?: unknown } | null | undefined): string {
  return JSON.stringify({ pairing: payload?.pairing, explorer: payload?.explorer });
}

// Every address a given payment code could legitimately have signed from.
// A PayNym is a MAINNET identity: an operator listing a testnet node still
// signs with their mainnet notification address, because that is the only key
// their wallet holds for that code. Deriving on testnet yields an "m…" address
// that can never match, which silently made every testnet listing unverifiable.
// Both derivations come from the same code, so accepting either is no weaker.
export function notificationAddresses(paymentCode: string): string[] {
  const out: string[] = [];
  for (const net of ["bitcoin", "testnet"]) {
    try { const a = notificationAddress(paymentCode, net); if (!out.includes(a)) out.push(a); } catch { /* skip */ }
  }
  return out;
}

// ---- lab-style signed pairing payload verification -------------------------
// The submitted `signed` blob is a BIP-signed message. We require it to be
// signed by the notification address of the operator's authenticated payment
// code, over the exact pairing JSON they are submitting. This is the same
// verify() the paymentcode.io lab uses.
//
// The signed message format Samourai/Ashigaru export wraps the payload between
// BEGIN/END markers. CRITICAL, verified against a real wallet export: the text
// the wallet signs is EVERYTHING between the markers, i.e. the pairing JSON
// PLUS the trailing "BIP47:" line and payment code (no trailing newline). An
// earlier revision excised the BIP47 tail before verifying, which made every
// genuine wallet signature fail as "invalid signature"; the selftest did not
// catch it because it constructed its own blocks under the same assumption.
// Because the BIP47 line is inside the signed text, the payment code is
// covered by the signature and can itself be verified against the signing
// address (see verifySignedPayload).
// Repair a signed block whose whitespace was mangled in transit.
//
// The signature covers the exact bytes between the markers, and the blank line
// before the "BIP47:" line is part of them. Copying a block through a chat
// window, a web form or a mail client routinely collapses that blank line, at
// which point a perfectly good signature stops verifying and the operator is
// told their signature is invalid, which is both wrong and unhelpful.
//
// This is safe rather than a fudge: a candidate is accepted ONLY if it verifies
// cryptographically against an address the declared payment code derives, so
// nothing is taken on trust. The repaired block is what gets stored, so later
// audits verify too. Returns null when no candidate verifies.
export function repairSignedBlock(text: unknown): { block: string; note: string | null } | null {
  const raw = String(text || "").replace(/\r\n/g, "\n");
  const addrM = raw.match(/Address:\s*(\S+)/);
  const sigM = raw.match(/\n([A-Za-z0-9+\/=]{80,})\n*-----END BITCOIN SIGNATURE/);
  const innerM = raw.match(/SIGNED MESSAGE-----[ \t]*\n([\s\S]*?)\n-----BEGIN BITCOIN SIGNATURE/);
  if (!addrM || !sigM || !innerM) return null;
  const address = addrM[1].trim(), signature = sigM[1].trim();
  const inner = innerM[1];
  const codeM = inner.match(/BIP47:\s*(PM8T[1-9A-HJ-NP-Za-km-z]+)/);
  const json = inner.replace(/\n*[ \t]*BIP47:[\s\S]*$/, "").replace(/\n+$/, "");
  const code = codeM ? codeM[1] : null;

  const candidates: [string, string][] = [["", inner]];
  if (code) {
    candidates.push(
      ["a blank line before the BIP47 line was restored", `${json}\n\nBIP47: ${code}`],
      ["a blank line before the BIP47 line was restored", `${json}\n\nBIP47:\n${code}`],
    );
  }
  const accept = code ? notificationAddresses(code) : [];
  if (code && !accept.includes(address)) return null;   // the code does not own this address
  const net = bip47utils.networks.bitcoin;
  for (const [note, candidate] of candidates) {
    let ok = false;
    try { ok = message.verify(candidate, address, signature, net.messagePrefix); } catch { ok = false; }
    if (!ok) continue;
    const block = `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${candidate}\n` +
      `-----BEGIN BITCOIN SIGNATURE-----\nVersion: Bitcoin-qt (1.0)\nAddress: ${address}\n\n${signature}\n` +
      `-----END BITCOIN SIGNATURE-----`;
    return { block, note: note || null };
  }
  return null;
}

export function parseSignedBlock(text: unknown): ParsedBlock | null {
  if (!text || typeof text !== "string") return null;
  const t = text.replace(/\r\n/g, "\n");
  const msgM = t.match(/BEGIN BITCOIN SIGNED MESSAGE-----\n([\s\S]*?)\n-----BEGIN BITCOIN SIGNATURE/);
  const addrM = t.match(/Address:\s*(\S+)/);
  const sigM = t.match(/\n([A-Za-z0-9+/=]{80,})\n-----END BITCOIN SIGNATURE/);
  if (!msgM || !addrM || !sigM) return null;
  const message = msgM[1].trim();                       // the full signed text
  const tail = message.match(/^([\s\S]*?)\n\s*BIP47:\s*\n?(\S+)$/);
  return {
    message,                                            // what the signature covers
    pairingText: tail ? tail[1].trim() : message,       // the pairing JSON alone
    paymentCode: tail ? tail[2] : null,                 // code inside the signed text
    address: addrM[1].trim(),
    signature: sigM[1].trim(),
  };
}

// Verify a signed pairing block. Checks, in order, with distinct errors:
//   1. the block parses at all;
//   2. the pairing JSON inside it matches the payload being submitted;
//   3. the signature is cryptographically valid over the FULL signed text;
//   4. (signature now known valid) the BIP47 payment code inside the signed
//      text is a valid code whose notification address IS the signing address;
//   5. the signing address matches the authenticated payment code's
//      notification address (the session binding the API supplies).
// Does the signed pairing text describe the same payload being submitted?
//
// Wallets and admin panels serialise this JSON differently: pretty-printed with
// newlines and indentation, or with the object keys in another order. All of
// those are the SAME payload, and a byte-exact comparison against our own
// re-serialisation rejects them, which is what made genuine, correctly signed
// listings fail the gate. So compare the parsed structures instead: identical
// keys and identical values, order-insensitive, at every level. Anything that
// is not valid JSON, or that differs in any value or key, still fails.
export function sameSignedPayload(signedText: string, expected: string): boolean {
  const a = String(signedText).trim(), b = String(expected).trim();
  if (a === b) return true;
  let pa, pb;
  try { pa = JSON.parse(a); pb = JSON.parse(b); } catch { return false; }
  return stableStringify(pa) === stableStringify(pb);
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

export function verifySignedPayload({ signedText, expectedMessage, expectedAddress, network = "bitcoin" }: {
  signedText: string;
  expectedMessage?: string | null;
  expectedAddress?: string | string[] | null;
  network?: string;
}): VerifyResult {
  const parsed = parseSignedBlock(signedText);
  if (!parsed) return { ok: false, error: "unrecognised signed message format" };
  if (expectedMessage != null && !sameSignedPayload(parsed.pairingText, expectedMessage)) {
    return { ok: false, error: "signed message does not match the submitted pairing code" };
  }
  const net = bip47utils.networks[network];
  let verified = false;
  try {
    verified = message.verify(parsed.message, parsed.address, parsed.signature, net.messagePrefix);
  } catch (e) {
    return { ok: false, error: "signature could not be verified (" + e.message + ")" };
  }
  if (!verified) return { ok: false, error: "invalid signature" };
  if (parsed.paymentCode) {
    const derived = notificationAddresses(parsed.paymentCode);
    if (!derived.length) {
      return { ok: false, error: "signature is valid, but the BIP47 line inside the signed message is not a valid payment code" };
    }
    if (!derived.includes(parsed.address)) {
      return { ok: false, error: "signature is valid, but the signing address is not the notification address of the payment code inside the message" };
    }
  }
  // expectedAddress may be a single address or every address the authenticated
  // code could have signed from (see notificationAddresses).
  const accept = expectedAddress == null ? null : (Array.isArray(expectedAddress) ? expectedAddress : [expectedAddress]);
  if (accept && !accept.includes(parsed.address)) {
    return { ok: false, error: "signed by a different address than the authenticated payment code" };
  }
  return { ok: true, address: parsed.address, paymentCode: parsed.paymentCode };
}

// ---- operator binding (data/operator.json) ----------------------------------
// A Dojo Bay instance MUST prove who runs it: operator.json binds the onion
// address to the operator's payment code via a wallet signature over the text
//
//     http://<onion>/
//
//     BIP47: <payment code>
//
// (unlike pairing blocks, the BIP47 line here is INSIDE the signed message:
// the operator pastes the whole text into the wallet's Sign tool). Verified at
// install, at bootstrap import before trusting a remote instance's data, and
// on every rebuild.
// ---- signed URL claims -----------------------------------------------------
// A verified operator domain is proven the same way the instance's own onion is:
// the operator signs the URL, a blank line, then "BIP47: <their code>". Same
// shape, same wallet procedure (PayNym → Sign message), so nothing new to learn
// and no new crypto. This is deliberately a separate field from the pairing
// payload: the pairing block attests to pairing data only, and operators
// stuffing identity material into it is exactly what this feature replaces.
export function claimText(url: string, paymentCode: string): string {
  return `${String(url).replace(/\/+$/, "")}/\n\nBIP47: ${paymentCode}`;
}

// Verify a signed claim over `expectedUrl` by `paymentCode`. Returns
// { ok } or { ok: false, error } with errors an operator can act on.
export function verifySignedUrlClaim({ signed, expectedUrl, paymentCode }: {
  signed: string;
  expectedUrl: string;
  paymentCode: string;
}): VerifyResult {
  if (!signed) return { ok: false, error: "no signed block supplied" };
  if (!paymentCode) return { ok: false, error: "no payment code supplied" };
  const t = String(signed).replace(/\r\n/g, "\n");
  const msgM = t.match(/BEGIN BITCOIN SIGNED MESSAGE-----[ \t]*\n?([\s\S]*?)\n-----BEGIN BITCOIN SIGNATURE/);
  const addrM = t.match(/Address:\s*(\S+)/);
  const sigM = t.match(/\n([A-Za-z0-9+\/=]{80,})\n*-----END BITCOIN SIGNATURE/);
  if (!msgM || !addrM || !sigM) {
    const missing = [
      !msgM && "the BEGIN BITCOIN SIGNED MESSAGE section",
      !addrM && "the Address: line",
      !sigM && "the signature line before END BITCOIN SIGNATURE",
    ].filter(Boolean).join(", ");
    return { ok: false, error: `not a recognisable signed block (missing ${missing}) — the paste may have been truncated` };
  }
  const signedMessage = msgM[1].replace(/\n+$/, "");
  const norm = (u) => String(u || "").trim().replace(/\/+$/, "").toLowerCase();
  const firstLine = signedMessage.split("\n")[0].trim();
  if (norm(firstLine) !== norm(expectedUrl)) {
    return { ok: false, error: `the signed message starts with ${firstLine || "(nothing)"}, but this claim is for ${expectedUrl}` };
  }
  const bipM = signedMessage.match(/BIP47:\s*(PM8T[1-9A-HJ-NP-Za-km-z]+)/);
  if (!bipM) return { ok: false, error: "the signed message has no BIP47: line" };
  if (bipM[1] !== paymentCode) {
    return { ok: false, error: "the BIP47 line inside the signed message is a different payment code from the one you are signed in with" };
  }
  const accept = notificationAddresses(paymentCode);
  if (!accept.includes(addrM[1].trim())) {
    return { ok: false, error: `signed by ${addrM[1].trim()}, but your payment code's notification address is ${accept[0]} — sign under PayNym → Sign message, which uses your PayNym's notification address` };
  }
  const net = bip47utils.networks.bitcoin;
  try {
    if (!message.verify(signedMessage, addrM[1].trim(), sigM[1].trim(), net.messagePrefix)) {
      return { ok: false, error: "invalid signature" };
    }
  } catch (e) {
    return { ok: false, error: "signature could not be verified (" + e.message + ")" };
  }
  return { ok: true, address: addrM[1].trim() };
}

export function verifyOperatorDoc(doc: any, { expectedOnion }: { expectedOnion?: string } = {}): VerifyResult {
  if (!doc || typeof doc !== "object") return { ok: false, error: "operator.json missing or unreadable" };
  if (!doc.paymentCode) return { ok: false, error: "operator.json has no paymentCode" };
  if (!doc.verifySigned) return { ok: false, error: "operator.json has no verifySigned block" };
  const t = String(doc.verifySigned).replace(/\r\n/g, "\n");
  // The newline after the BEGIN marker is optional: some terminals swallow it
  // when a block is pasted. It is not part of the signed text either way, so
  // tolerating it recovers the correct message rather than changing it.
  const msgM = t.match(/BEGIN BITCOIN SIGNED MESSAGE-----[ \t]*\n?([\s\S]*?)\n-----BEGIN BITCOIN SIGNATURE/);
  const addrM = t.match(/Address:\s*(\S+)/);
  const sigM = t.match(/\n([A-Za-z0-9+\/=]{80,})\n*-----END BITCOIN SIGNATURE/);
  if (!msgM || !addrM || !sigM) {
    // Name what is missing: a truncated or line-dropped paste is by far the
    // most common cause, and "not recognisable" alone sends people hunting
    // for a problem with their wallet instead of re-pasting.
    const missing = [
      !msgM && "the BEGIN BITCOIN SIGNED MESSAGE section",
      !addrM && "the Address: line",
      !sigM && "the signature line before END BITCOIN SIGNATURE",
    ].filter(Boolean).join(", ");
    return { ok: false, error: `verifySigned is not a recognisable signed block (missing ${missing}) — the paste may have been truncated; paste the whole block again` };
  }
  const signedMessage = msgM[1].replace(/\n+$/, "");
  const norm = (u) => String(u || "").trim().replace(/\/+$/, "");
  const firstLine = signedMessage.split("\n")[0].trim();
  if (norm(firstLine) !== norm(doc.onion)) return { ok: false, error: "signed message does not match the declared onion" };
  if (expectedOnion && norm(doc.onion) !== norm(expectedOnion)) {
    return { ok: false, error: "declared onion does not match the address this document was fetched from" };
  }
  const bipM = signedMessage.match(/BIP47:\s*(PM8T[1-9A-HJ-NP-Za-km-z]+)/);
  if (!bipM || bipM[1] !== doc.paymentCode) {
    return { ok: false, error: "the BIP47 line inside the signed message does not match the declared payment code" };
  }
  // Accept either derivation of the notification address.
  //
  // A PayNym is a mainnet identity, but a wallet running on testnet derives the
  // notification address for THAT network, so the same payment code signs from
  // a different address depending on which mode the operator's wallet is in.
  // Insisting on the mainnet form refused perfectly good bindings from anyone
  // running a testnet wallet — the same defect fixed for listing signatures,
  // which this path missed.
  const accept = notificationAddresses(doc.paymentCode);
  const signer = addrM[1].trim();
  if (!accept.includes(signer)) {
    // Naming the addresses matters: the usual cause is signing from a different
    // account than the payment code entered, and the operator can only spot
    // that if they can see which address their wallet actually used.
    const expected = accept.length > 1
      ? `${accept[0]} on mainnet, or ${accept[1]} from a testnet wallet`
      : accept[0] || "(the code could not be decoded)";
    return { ok: false, error: `signed by ${signer}, but the payment code's notification address is ${expected} — sign under PayNym → Sign message, which uses your PayNym's notification address` };
  }
  const net = bip47utils.networks.bitcoin;   // the message prefix is the same on both
  try {
    if (!message.verify(signedMessage, signer, sigM[1].trim(), net.messagePrefix)) {
      return { ok: false, error: "invalid signature" };
    }
  } catch (e) { return { ok: false, error: "signature could not be verified (" + e.message + ")" }; }
  return { ok: true, address: signer };
}
