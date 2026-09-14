// =============================================================================
// The bot's own money: an ordinary BIP84 chain it can spend from.
//
// WHY THIS EXISTS, because the distinction cost a wrong design once. A BIP47
// notification transaction SPENDS an input the sender owns and PAYS an output to
// the RECEIVER's notification address. The shop wallet is the sender. So what it
// needs funding is a plain deposit address on a chain it controls — not its own
// notification address, which is where somebody else would announce a pair TO
// this bot. The bot does hold that key, so funding it there would work, and it
// would still be the wrong shape and would put a legacy address in front of the
// operator for no reason.
//
// This is the ONLY chain in the project the store can spend. Invoice addresses
// derive on the operator's personal wallet (derive.ts) and the store cannot
// touch them; that asymmetry is what lets the gateway exist. The exception is
// bounded on purpose: one input's worth of fee, spent once per network to
// announce the pair, and never funded again.
//
// BIP84, m/84'/coin'/0'/chain/index, native segwit. Two consequences, both
// wanted: the funding address is bc1…/tb1… like every other address the shop
// shows, and the twelve words restored into Samourai or Ashigaru put the money
// in the account those wallets already look in.
//
// THE RISK, stated where the choice is made. BIP47 designates the pubkey of
// input 0 as the ECDH blinding key, and an implementation that reads that pubkey
// out of the scriptSig will not find a segwit input's — it lives in the witness.
// The failure is silent in the worst direction: the notification confirms, the
// receiving wallet ignores it, and nothing starts watching. Nothing here can
// detect that, which is why testnet4 is a gate rather than a nicety — the
// notification is rehearsed there and confirmed RECEIVED by the operator's own
// wallet before a mainnet one is built. If it is not seen, the fallback is a
// legacy input from m/44'/coin'/0'/0/0 and only this file changes.
// =============================================================================
import { BIP32Factory } from "bip32";
import ecc from "@bitcoinerlab/secp256k1";
import { libNetwork, addressOfPubkey } from "./derive.ts";

const bip32 = BIP32Factory(ecc);

/**
 * SLIP-44 coin type per network.
 *
 * testnet4 is 1, the same as every other test chain: BIP-94 keeps testnet3's
 * coin type, which is the same sameness LIB_NETWORK in derive.ts is written
 * around. One seed therefore gives one testnet deposit chain, not one per
 * testnet, and the records rather than the addresses say which chain is meant.
 */
const COIN_TYPE: Record<string, number> = { bitcoin: 0, testnet4: 1, regtest: 1 };

/** The BIP84 account this bot spends from. Account 0; it needs no second. */
export function depositAccountPath(network: string): string {
  const coin = COIN_TYPE[network];
  if (coin === undefined) {
    throw new Error(`unknown network ${JSON.stringify(network)}: expected one of ${Object.keys(COIN_TYPE).join(", ")}`);
  }
  return `m/84'/${coin}'/0'`;
}

/** Receive chain or change chain, named so a caller cannot pass 0 or 1 by luck. */
export type DepositChain = "receive" | "change";

/**
 * A deposit address for the bot, on `network`.
 *
 * `chain` is "change" for the output a notification transaction sends its
 * remainder to. It is here now rather than added later because a transaction
 * builder that has nowhere to put change tends to grow one in the wrong place —
 * a second derivation, a second idea of what this wallet's paths are.
 */
export function depositAddress(
  seed: Uint8Array,
  network: string,
  { chain = "receive", index = 0 }: { chain?: DepositChain; index?: number } = {},
): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`refusing to derive a deposit address at index ${index}: must be a non-negative integer`);
  }
  const net = libNetwork(network);
  const node = bip32.fromSeed(seed, net)
    .derivePath(`${depositAccountPath(network)}/${chain === "change" ? 1 : 0}/${index}`);
  return addressOfPubkey(node.publicKey, "p2wpkh", network);
}

/**
 * The private key for a deposit address, for signing the notification input.
 *
 * Separate from depositAddress so that showing the operator where to send money
 * never touches a private key, and the one code path that produces a spending
 * key is the one that asked for exactly that.
 */
export function depositPrivateKey(
  seed: Uint8Array,
  network: string,
  { chain = "receive", index = 0 }: { chain?: DepositChain; index?: number } = {},
): Uint8Array {
  const node = bip32.fromSeed(seed, libNetwork(network))
    .derivePath(`${depositAccountPath(network)}/${chain === "change" ? 1 : 0}/${index}`);
  if (!node.privateKey) throw new Error("internal: derived a deposit node with no private key");
  return node.privateKey;
}
