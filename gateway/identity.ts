// =============================================================================
// The store's own BIP47 identity, and the signature it puts on every address it
// issues.
//
// WHAT THE SIGNATURE IS FOR, precisely, because claiming more than this would
// be worse than claiming nothing. It binds an address to the store's payment
// code, which a customer already knows from data/store.json and can check
// against the store's PayNym. That defeats a compromised WEB SERVER swapping in
// an attacker's address, because the web server has no key.
//
// It does NOT defend against a compromised GATEWAY, which by construction holds
// the key that makes signatures. An attacker who owns this process can sign
// their own address and the customer's check will pass. The defence against
// that case is pool.mjs, where the addresses are derived and signed offline by
// the operator's personal wallet and this process never holds a key at all.
//
// The key here cannot spend. An attacker who steals the seed learns every
// address the store will ever issue — a real and permanent privacy breach — but
// cannot move a satoshi, because spending needs the personal wallet's key. That
// asymmetry is why this service can exist at all.
// =============================================================================
import { readFile } from "node:fs/promises";
import { bitcoinMessageFactory } from "@dojo-tools/bitcoinjs-message";
import ecc from "@bitcoinerlab/secp256k1";
import * as bip39 from "bip39";
import { storeIdentity, publicCode, type AddressType } from "./derive.ts";
import type { PaymentCodePrivate } from "@dojo-tools/bip47";

const message = bitcoinMessageFactory(ecc);

/** An address the gateway has issued, with the attestation a customer checks. */
export interface SignedAddress {
  /** Record format, so a future change is detectable rather than ambiguous. */
  v: 1;
  address: string;
  index: number;
  type: AddressType;
  network: string;
  /** The store's payment code: what the signature is checked against. */
  paymentCode: string;
  /** Base64 signature over canonicalAddress(this). */
  signed: string;
}

/**
 * The exact text signed and checked, in one place.
 *
 * Dojobay learned this the expensive way: a canonical message that exists twice
 * is a canonical message waiting to disagree with itself, and the failure is
 * quiet in the worst direction — signatures accepted at issue and reported
 * invalid by a later audit, or the reverse. Every producer and every verifier
 * in this project calls this function.
 *
 * Key order is fixed by listing the fields explicitly rather than by spreading
 * a record, so a caller cannot change the signed bytes by reordering an object
 * literal somewhere else.
 */
export function canonicalAddress(rec: Omit<SignedAddress, "signed">): string {
  return JSON.stringify({
    v: rec.v,
    address: rec.address,
    index: rec.index,
    type: rec.type,
    network: rec.network,
    paymentCode: rec.paymentCode,
  });
}

/** The store's identity, loaded from its seed. Holds private keys. */
export class StoreIdentity {
  code: PaymentCodePrivate;
  network: string;

  constructor(seed: Uint8Array, network: string = "bitcoin") {
    this.code = storeIdentity(seed, { network });
    this.network = network;
  }

  /** Load from a BIP39 mnemonic. The passphrase, if any, is part of the seed. */
  static fromMnemonic(mnemonic: string, passphrase: string = "", network: string = "bitcoin"): StoreIdentity {
    const words = String(mnemonic || "").trim().replace(/\s+/g, " ");
    if (!bip39.validateMnemonic(words)) {
      throw new Error("that is not a valid BIP39 mnemonic; refusing to derive an identity from it");
    }
    return new StoreIdentity(bip39.mnemonicToSeedSync(words, passphrase), network);
  }

  /**
   * Load from a seed file: a JSON object carrying the mnemonic.
   *
   * The file is the store's identity, so a caller that cannot read it gets the
   * error rather than a gateway that silently starts with a different key and
   * issues addresses on a chain nobody is watching.
   */
  static async fromFile(path: string): Promise<StoreIdentity> {
    let doc;
    try { doc = JSON.parse(await readFile(path, "utf8")); }
    catch (e) {
      throw new Error(`cannot read the store seed at ${path}: ${(e as Error).message}`);
    }
    if (!doc || typeof doc.mnemonic !== "string") {
      throw new Error(`${path} does not contain a "mnemonic"; the gateway has no identity to run as`);
    }
    return StoreIdentity.fromMnemonic(doc.mnemonic, doc.passphrase || "", doc.network || "bitcoin");
  }

  paymentCode(): string { return this.code.toBase58(); }

  /** Where a verifier checks this store's signatures. Derived, never stored. */
  notificationAddress(): string { return this.code.getNotificationAddress(); }

  /**
   * Sign an address record with the notification key.
   *
   * The notification key is the right one because it is the key a payment code
   * publicly commits to: a verifier holding only the store's payment code can
   * derive the matching address and check the signature, with nothing else from
   * us. It is the same key and the same check Dojobay uses for its operator
   * binding and its pairing payloads.
   */
  signAddress(rec: Omit<SignedAddress, "signed">): SignedAddress {
    const priv = this.code.getNotificationPrivateKey();
    const sig = message.sign(canonicalAddress(rec), priv, true);
    return { ...rec, signed: Buffer.from(sig).toString("base64") };
  }
}

/**
 * Check a signed address against a payment code the caller already trusts.
 *
 * The expected payment code is REQUIRED and is the whole point: a verifier that
 * takes only the record can answer "is this signed?" but never "is this signed
 * by the store I am buying from?", and the second question is the one a
 * customer needs answered. Dojobay's Auth47 verifier carried exactly this hole
 * before it was closed, and the missing binding was invisible rather than a
 * missing argument.
 */
export function verifySignedAddress(
  rec: SignedAddress | null | undefined,
  expectedPaymentCode: string,
): { ok: boolean; error?: string } {
  if (!rec || typeof rec !== "object") return { ok: false, error: "no address record" };
  if (rec.v !== 1) return { ok: false, error: `unsupported record version ${rec.v}` };
  if (!expectedPaymentCode) return { ok: false, error: "internal: no expected payment code, refusing to verify an unbound record" };
  if (rec.paymentCode !== expectedPaymentCode) {
    return { ok: false, error: "this address was signed by a different store than the one you are buying from" };
  }
  let expectedAddress: string;
  try { expectedAddress = publicCode(expectedPaymentCode, rec.network || "bitcoin").getNotificationAddress(); }
  catch { return { ok: false, error: "the expected payment code is not a valid BIP47 code" }; }

  const { signed, ...unsigned } = rec;
  try {
    if (!message.verify(canonicalAddress(unsigned), expectedAddress, signed)) {
      return { ok: false, error: "the signature does not match this address record" };
    }
  } catch (e) {
    return { ok: false, error: `signature check failed: ${(e as Error).message}` };
  }
  return { ok: true };
}
