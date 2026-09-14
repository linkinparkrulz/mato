// First run: the shop makes itself an identity, on every network it can trade on.
//
// This is the "store PayNym bot". It is one half of a BIP47 pair; the other
// half is the operator's PERSONAL payment code. Every address a customer is
// asked to pay is derived from the two together, with the bot as sender and the
// operator's own wallet as receiver, which is why the server can say where a
// payment should go and still not be able to touch it when it arrives.
//
// The seed lives here and only here. The gateway is the one process that holds
// a key; the web-facing backend reaches these values over the unix socket
// rather than reading the file, so a compromised front end has nothing to read.
//
// ONE SEED, BOTH NETWORKS. The same twelve words derive a distinct identity per
// network — different payment code, different notification address — so both
// are created at setup and the operator switches between them. One backup
// covers both, and testnet4 is a real chain to rehearse the notification
// transaction on before mainnet money is involved.
//
// The test chain is testnet4. It shares testnet3's address version bytes, bech32
// HRP and coin type, so derivation is identical between them and the library
// needs no testnet4 entry — see LIB_NETWORK in derive.ts, the one place the two
// vocabularies meet. The records say testnet4 anyway, because that sameness is
// the hazard: an address is valid on both testnets and the coins are not, so
// nothing but the record itself says which chain a payment was quoted for.
//
// regtest is absent as a block. Its notification addresses match testnet's (same
// p2pkh version byte), but its invoice addresses do NOT: regtest's bech32 HRP is
// bcrt, testnet's is tb, and invoice addresses have been segwit since ea6e193.
// So a regtest deployment is its own chain in practice; it is left out rather
// than pretended to be testnet4 with different-looking addresses.
//
// The bot does hold a little money, once per network. Before a stock wallet will
// recognise the pair, the SENDER has to announce it in an on-chain notification
// transaction: it spends an input of its own and pays an output to the
// RECEIVER's notification address. That costs a fee, so the bot needs an
// ordinary chain it can spend from — its deposit address, see deposit.ts. The
// operator funds that, the bot spends it once to make the announcement, and it
// never needs funding again.
//
// Not its own notification address, which is a different role: that is where
// somebody else would announce a pair TO this bot, and where a customer checks
// the signature on an address the shop quoted. The bot holds that key too, so
// funding it there would work, which is precisely why the two are worth keeping
// apart in writing.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import * as bip39 from "bip39";
import { StoreIdentity } from "./identity.ts";
import { publicCode } from "./derive.ts";
import { depositAddress } from "./deposit.ts";

export const SEED_FILE = "store-seed.json";
export const STATE_FILE = "store-identity.json";
const SEED_MODE = 0o600;

/** The networks a shop keeps an identity for. */
export const NETWORKS = ["bitcoin", "testnet4"] as const;
export type Network = (typeof NETWORKS)[number];

export function isNetwork(value: unknown): value is Network {
  return typeof value === "string" && (NETWORKS as readonly string[]).includes(value);
}

/** Which node this network's chain work goes through. */
export interface DojoChoice {
  url: string;
  apikey: string;
  label: string | null;
  /**
   * "own" is the operator's own node. "directory" is one picked from a Dojo Bay
   * list, and is recorded as such because it is a different trust position: that
   * node's operator sees every address this shop watches.
   */
  source: "own" | "directory";
}

/** One network's half of the shop's identity. Never carries the mnemonic. */
export interface NetworkIdentity {
  paymentCode: string;
  /**
   * What this payment code resolves to: where another wallet would announce a
   * pair to this bot, and the address a customer checks its signatures against.
   * NOT where the operator sends money — that is depositAddress.
   */
  notificationAddress: string;
  /**
   * The bot's own spendable address, and the only money it ever holds. Funded
   * once per network to pay for the notification transaction. See deposit.ts.
   */
  depositAddress: string;
  /** The operator's personal payment code on THIS network: the RECEIVER. */
  receiverPaymentCode: string | null;
  /**
   * The notification address that code derives ON THIS NETWORK. Stored so the
   * panel can show it: it is the only way an operator can tell they pasted the
   * right code, since the code itself says nothing about which chain it is for.
   */
  receiverNotificationAddress: string | null;
  nymName: string | null;
  nymId: string | null;
  notificationTxid: string | null;
  notificationSentAt: string | null;
  dojo: DojoChoice | null;
}

export interface IdentityState {
  /** Which network the shop is currently trading on. */
  active: Network;
  createdAt: string;
  networks: Record<Network, NetworkIdentity>;
}

interface SeedDoc {
  mnemonic: string;
  passphrase?: string;
  createdAt: string;
}

/**
 * 128 bits, twelve words: what Samourai and Ashigaru produce, so an operator
 * restoring the bot by hand is typing something their own wallet accepts.
 */
export function newMnemonic(): string {
  return bip39.generateMnemonic(128, (size) => randomBytes(size));
}

async function writeAtomic(file: string, text: string, mode: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode });
  await chmod(tmp, mode);          // umask can clear bits writeFile asked for
  await rename(tmp, file);
}

async function readJSON<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Derive the identity for one network from the seed. */
export function identityFor(seed: SeedDoc, network: Network): StoreIdentity {
  return StoreIdentity.fromMnemonic(seed.mnemonic, seed.passphrase || "", network);
}

/** The BIP39 seed bytes, for the one chain that is not a BIP47 derivation. */
function seedBytes(seed: SeedDoc): Uint8Array {
  return bip39.mnemonicToSeedSync(seed.mnemonic.trim().replace(/\s+/g, " "), seed.passphrase || "");
}

/** The bot's funding address on one network. Public; derived, never stored as truth. */
export function depositFor(seed: SeedDoc, network: Network): string {
  return depositAddress(seedBytes(seed), network);
}

function blankBlock(id: StoreIdentity, deposit: string): NetworkIdentity {
  return {
    paymentCode: id.paymentCode(),
    notificationAddress: id.notificationAddress(),
    depositAddress: deposit,
    receiverPaymentCode: null,
    receiverNotificationAddress: null,
    nymName: null, nymId: null,
    notificationTxid: null, notificationSentAt: null,
    dojo: null,
  };
}

/**
 * Load the identity, making one the first time.
 *
 * Generation is not a separate command an operator could forget: a shop with no
 * identity cannot quote an address, so the first call creates one. It is also
 * deliberately not re-entrant past creation. If a seed exists it is used, never
 * replaced — regenerating would orphan every address already quoted to a
 * customer, and the symptom would be payments that simply never arrive.
 */
export async function loadOrCreate(dataDir: string): Promise<{
  identities: Record<Network, StoreIdentity>;
  state: IdentityState;
  created: boolean;
}> {
  const seedPath = path.join(dataDir, SEED_FILE);
  const statePath = path.join(dataDir, STATE_FILE);

  let seed = await readJSON<SeedDoc>(seedPath);
  let created = false;
  if (!seed) {
    seed = { mnemonic: newMnemonic(), createdAt: new Date().toISOString() };
    await writeAtomic(seedPath, JSON.stringify(seed, null, 2) + "\n", SEED_MODE);
    created = true;
  }

  const identities = Object.fromEntries(
    NETWORKS.map((n) => [n, identityFor(seed!, n)]),
  ) as Record<Network, StoreIdentity>;

  let state = await readJSON<IdentityState>(statePath);
  if (!state) {
    state = {
      active: "bitcoin",
      createdAt: seed.createdAt,
      networks: Object.fromEntries(
        NETWORKS.map((n) => [n, blankBlock(identities[n], depositFor(seed!, n))]),
      ) as Record<Network, NetworkIdentity>,
    };
    await writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n", 0o644);
  } else {
    // The seed and the recorded identity must agree on EVERY network, not just
    // the active one: a seed that derives one but not the other is still the
    // wrong seed, and the half that disagrees is the half whose addresses were
    // quoted to somebody. Deriving on a new one would look like working
    // software and lose money quietly, so this refuses instead.
    for (const n of NETWORKS) {
      const recorded = state.networks?.[n]?.paymentCode;
      const derived = identities[n].paymentCode();
      if (recorded && recorded !== derived) {
        throw new Error(
          `the store seed no longer derives the recorded ${n} payment code ` +
          `(recorded ${recorded.slice(0, 12)}…, seed derives ${derived.slice(0, 12)}…). ` +
          `Restore the original seed, or delete ${STATE_FILE} if this shop has never quoted an address.`);
      }
    }
    // A state written before a network existed gains its block here, which is
    // additive: nothing already recorded is touched.
    let grew = false;
    for (const n of NETWORKS) {
      if (!state.networks?.[n]) {
        state.networks = {
          ...(state.networks || {}),
          [n]: blankBlock(identities[n], depositFor(seed!, n)),
        } as Record<Network, NetworkIdentity>;
        grew = true;
        continue;
      }
      // A state written before the shop had a deposit chain gains one here. It
      // is a derived value, so backfilling is not a migration in any meaningful
      // sense: the address was always implied by the seed, it simply was not
      // written down. Nothing already recorded is touched, and the payment-code
      // guard above has already established that this IS the right seed.
      if (!state.networks[n].depositAddress) {
        state.networks[n].depositAddress = depositFor(seed!, n);
        grew = true;
      }
    }
    if (grew) await writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n", 0o644);
  }

  return { identities, state, created };
}

export async function saveState(dataDir: string, state: IdentityState): Promise<void> {
  await writeAtomic(path.join(dataDir, STATE_FILE), JSON.stringify(state, null, 2) + "\n", 0o644);
}

/**
 * Read the mnemonic back, for the one screen that shows it.
 *
 * Deliberately separate from loadOrCreate, which never returns the words:
 * everything else this module does works without holding them, so the only code
 * path that can disclose the seed is the one that asked for exactly that.
 */
export async function revealMnemonic(dataDir: string): Promise<string> {
  const seed = await readJSON<SeedDoc>(path.join(dataDir, SEED_FILE));
  if (!seed) throw new Error("this shop has no identity yet");
  return seed.mnemonic;
}

/**
 * Bind the operator's personal payment code as the receiver, for one network.
 *
 * Per network because the mainnet and testnet receivers are different wallets:
 * a testnet code cannot receive mainnet money and binding one to both would be
 * a silent misdirection of real funds.
 *
 * Parsing is all this can check, and it is worth being honest about how little
 * that is: a BIP47 payment code carries NO network. The same string parses on
 * both chains and simply derives a different notification address — 1… on
 * mainnet, m/n… on testnet. So a mainnet code pasted into the testnet slot is
 * accepted here and cannot be rejected by any amount of inspection.
 *
 * What catches it is confirmation, not validation. The address that code
 * derives on this network is recorded and shown, and an operator who pasted the
 * wrong one sees a notification address their wallet does not know. That is the
 * check; the parse only rejects text that is not a payment code at all.
 */
export function bindReceiver(state: IdentityState, network: Network, personalPaymentCode: string): IdentityState {
  const block = state.networks[network];
  if (!block) throw new Error(`unknown network: ${network}`);
  const code = String(personalPaymentCode || "").trim();
  let receiverNotificationAddress: string;
  try {
    receiverNotificationAddress = publicCode(code, network).getNotificationAddress();
  } catch (e) {
    throw new Error(`that is not a usable BIP47 payment code: ${(e as Error).message}`);
  }
  if (code === block.paymentCode) {
    throw new Error(
      "the receiver cannot be the shop's own payment code: a shop paying itself derives nothing the operator can spend");
  }
  if (block.notificationTxid && block.receiverPaymentCode && block.receiverPaymentCode !== code) {
    // The notification on-chain names this pair. Re-pointing the receiver now
    // leaves that announcement describing a relationship the shop no longer
    // uses, and the new receiver's wallet was never told to watch.
    throw new Error(
      `the ${network} notification transaction for the current receiver is already on-chain; ` +
      "changing the receiver now would strand it. Start a new shop identity instead.");
  }
  return {
    ...state,
    networks: {
      ...state.networks,
      [network]: { ...block, receiverPaymentCode: code, receiverNotificationAddress },
    },
  };
}

/** Record which node this network's chain work goes through. */
export function setDojo(state: IdentityState, network: Network, dojo: DojoChoice | null): IdentityState {
  const block = state.networks[network];
  if (!block) throw new Error(`unknown network: ${network}`);
  return { ...state, networks: { ...state.networks, [network]: { ...block, dojo } } };
}

/** Switch which network the shop trades on. Destroys nothing on either side. */
export function setActive(state: IdentityState, network: Network): IdentityState {
  if (!state.networks[network]) throw new Error(`unknown network: ${network}`);
  return { ...state, active: network };
}

/** What this network still needs before it can quote an address to a customer. */
export function readiness(state: IdentityState, network: Network): {
  ready: boolean;
  needsReceiver: boolean;
  needsNotification: boolean;
  needsDojo: boolean;
} {
  const block = state.networks[network];
  if (!block) throw new Error(`unknown network: ${network}`);
  const needsReceiver = !block.receiverPaymentCode;
  const needsNotification = !block.notificationTxid;
  // A Dojo is not needed to DERIVE an address — that is pure maths and touches
  // no chain. It is needed to notice the payment, so a shop without one can
  // quote and not settle, which is worth saying separately.
  const needsDojo = !block.dojo;
  return { ready: !needsReceiver && !needsNotification, needsReceiver, needsNotification, needsDojo };
}
