// =============================================================================
// BIP47 invoice-address derivation.
//
// This is the one module where a mistake costs a customer their money rather
// than costing the site a page render, so it states its invariants loudly and
// selftest.mjs holds it to the published BIP47 test vectors rather than to its
// own output.
//
// WHAT AN INVOICE ADDRESS IS. The store derives addresses on the OPERATOR'S
// PERSONAL wallet chain: the customer pays there, and only the personal wallet
// can spend. The store's own key never controls a satoshi of it.
//
//   address_i = P_i + SHA256( store_priv₀ × P_i )·G      P = personal code
//
// THE TRAP, and the reason every call here goes through one function. The
// library's two classes both expose getPaymentAddress(counterparty, idx), and
// both directions return the SAME address, so a wrong call does not throw and
// does not look wrong — it silently returns an address on the wrong chain. The
// rule that decides it:
//
//   the address lands on the chain of the object the method is called ON.
//   the argument is the counterparty.
//
// So the receiving side is `this`, always. We want the personal wallet to
// receive, therefore the call is personalPublic.getPaymentAddress(storePrivate).
// Calling it the other way round — storePrivate.getPaymentAddress(personalPublic)
// — returns an address on the STORE's chain, which the store can spend and the
// operator's wallet will never see. It verifies, it is a valid BIP47 address,
// and it is the wrong one. selftest.mjs asserts both directions explicitly so
// the distinction cannot be lost to a refactor.
// =============================================================================
import { BIP47Factory } from "@dojo-tools/bip47";
import * as utils from "@dojo-tools/bip47/utils";
import ecc from "@bitcoinerlab/secp256k1";
import type { PaymentCodePrivate, PaymentCodePublic } from "@dojo-tools/bip47";

/** The address encodings BIP47 counterparties may use for a payment chain. */
export type AddressType = "p2pkh" | "p2sh" | "p2wpkh";

/**
 * The default encoding for INVOICE addresses: native segwit.
 *
 * Customers pay less in fees and the transaction is smaller, and the wallets
 * this shop is built around — Samourai and Ashigaru — scan the segwit chain.
 *
 * The cost is real and worth stating where the choice is made: a receiving
 * wallet that does NOT scan p2wpkh sees nothing, and the shop cannot detect
 * that. A payment lands at an address the operator's wallet never looks at,
 * there is no error anywhere, and the money is not lost but is invisible until
 * someone rescans with the right derivation. The type stays configurable for an
 * operator whose wallet needs the legacy form.
 *
 * This is the invoice address only. The NOTIFICATION address is p2pkh and is
 * not a choice: BIP47 defines it as the P2PKH address of the notification key,
 * so a wallet hunting a notification transaction looks nowhere else. Making it
 * segwit would mean nobody ever finds the announcement.
 */
export const DEFAULT_ADDRESS_TYPE: AddressType = "p2wpkh";

const ADDRESS_TYPES: readonly AddressType[] = ["p2pkh", "p2sh", "p2wpkh"];

/**
 * Read an address type from operator configuration, refusing anything else.
 *
 * A typo in this setting must not fall back to the default: the operator would
 * get a chain their wallet may not scan while believing they had chosen the one
 * it does, and the first sign of trouble would be a customer's payment that
 * nobody can see. An empty value means "unset", and takes the default.
 */
export function parseAddressType(value: string | undefined | null): AddressType {
  const v = String(value ?? "").trim();
  if (!v) return DEFAULT_ADDRESS_TYPE;
  const found = ADDRESS_TYPES.find((t) => t === v);
  if (!found) {
    throw new Error(`unknown address type ${JSON.stringify(v)}: expected one of ${ADDRESS_TYPES.join(", ")}`);
  }
  return found;
}

const bip47 = BIP47Factory(ecc);

/**
 * Our network names to the library's.
 *
 * testnet4 (BIP-94) uses testnet3's address version bytes, bech32 HRP and coin
 * type, so the library needs no testnet4 entry and derivation is unchanged
 * between them. We still name the chain testnet4 everywhere else, because that
 * sameness is exactly the hazard: an address is valid on both testnets, so
 * nothing catches a shop configured for one talking to a node on the other, and
 * the coins do not carry across. The records have to say which chain they mean
 * since the addresses cannot.
 *
 * This is the only place the two vocabularies meet. Anything outside derive.ts
 * speaks our names.
 */
const LIB_NETWORK: Record<string, string> = { bitcoin: "bitcoin", testnet4: "testnet", regtest: "regtest" };

/**
 * The library's network object for one of our network names.
 *
 * Exported because the deposit chain (deposit.ts) needs the same object for its
 * bip32 version bytes, and a second copy of this mapping is exactly the bug the
 * comment above is written to prevent: two places deciding what testnet4 means
 * can disagree, and the disagreement is an address on the wrong chain.
 */
export function libNetwork(network: string) {
  const name = LIB_NETWORK[network];
  if (!name) throw new Error(`unknown network ${JSON.stringify(network)}: expected one of ${Object.keys(LIB_NETWORK).join(", ")}`);
  return utils.networks[name];
}

/** Load the store's own identity from its BIP39 seed. Holds private keys. */
export function storeIdentity(seed: Uint8Array, { segwit = false, network = "bitcoin" } = {}): PaymentCodePrivate {
  return bip47.fromSeed(seed, segwit, libNetwork(network));
}

/** Parse a counterparty's payment code. Public material only. */
export function publicCode(paymentCode: string, network: string = "bitcoin"): PaymentCodePublic {
  return bip47.fromBase58(paymentCode, libNetwork(network));
}

/**
 * The invoice address at `index`, payable by anyone and spendable ONLY by the
 * wallet behind `personalPaymentCode`.
 *
 * `store` must be the store's PRIVATE identity: the ECDH needs one private key,
 * and it is deliberately the store's, because the alternative is putting the
 * operator's spending key on a server. A caller passing a public-only store
 * identity gets a throw from the library rather than a wrong address.
 */
export function addressFor(
  store: PaymentCodePrivate,
  personalPaymentCode: string,
  index: number,
  type: AddressType = DEFAULT_ADDRESS_TYPE,
  network: string = "bitcoin",
): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`refusing to derive at index ${index}: must be a non-negative integer`);
  }
  // `this` is the personal code, so the address lands on the personal wallet's
  // chain. See the header; this argument order is the whole point of the file.
  return publicCode(personalPaymentCode, network).getPaymentAddress(store, index, type);
}

/**
 * The private key for an address this store derived, given the PERSONAL wallet's
 * private identity. The store never calls this and must never be able to: it is
 * here so the self-test can prove that a derived address is actually spendable
 * by the operator, which is the property the whole design promises and the one
 * thing a vector comparison alone does not establish.
 */
export function spendingKeyFor(
  personal: PaymentCodePrivate,
  storePaymentCode: string,
  index: number,
  network: string = "bitcoin",
): Uint8Array {
  return personal.derivePaymentPrivateKey(publicCode(storePaymentCode, network), index);
}

/** The address a public key encodes to, for checking a derivation end to end. */
export function addressOfPubkey(pubkey: Uint8Array, type: AddressType, network: string = "bitcoin"): string {
  const net = libNetwork(network);
  switch (type) {
    case "p2pkh": return utils.getP2pkhAddress(pubkey, net);
    case "p2sh": return utils.getP2shAddress(pubkey, net);
    case "p2wpkh": return utils.getP2wpkhAddress(pubkey, net);
    default: throw new Error(`unknown address type: ${type}`);
  }
}

/** The compressed public key a private key corresponds to. */
export function pubkeyOf(priv: Uint8Array): Uint8Array {
  const pub = ecc.pointFromScalar(priv, true);
  if (!pub) throw new Error("could not derive a public key from that private key");
  return pub;
}
