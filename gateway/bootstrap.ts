// First run: the shop makes itself an identity.
//
// This is the "store PayNym bot". It is one half of a BIP47 pair; the other
// half is the operator's PERSONAL payment code. Every address a customer is
// asked to pay is derived from the two together, with the bot as sender and the
// operator's own wallet as receiver, which is why the server can say where a
// payment should go and still not be able to touch it when it arrives.
//
// The seed lives here and only here. The gateway is the one process that holds
// a key, and the web-facing backend reaches these values over the unix socket
// rather than reading the file, so a compromised front end has nothing to read.
//
// The bot does hold a little money, once. Before a stock wallet will recognise
// the pair, the sender has to announce it in an on-chain notification
// transaction, and that costs a fee. The operator funds the bot's own
// notification address, it spends that once, and it never needs funding again.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import * as bip39 from "bip39";
import { StoreIdentity } from "./identity.ts";
import { publicCode } from "./derive.ts";

export const SEED_FILE = "store-seed.json";
export const STATE_FILE = "store-identity.json";
const SEED_MODE = 0o600;

/** Everything the panel and the backend may see. Never carries the mnemonic. */
export interface IdentityState {
  paymentCode: string;
  /** Where the operator funds the bot, and what its payment code resolves to. */
  notificationAddress: string;
  /** The operator's personal payment code: the RECEIVER. Null until bound. */
  receiverPaymentCode: string | null;
  nymName: string | null;
  nymId: string | null;
  notificationTxid: string | null;
  notificationSentAt: string | null;
  createdAt: string;
}

interface SeedDoc {
  mnemonic: string;
  passphrase?: string;
  network?: string;
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
  identity: StoreIdentity;
  state: IdentityState;
  created: boolean;
}> {
  const seedPath = path.join(dataDir, SEED_FILE);
  const statePath = path.join(dataDir, STATE_FILE);

  let seed = await readJSON<SeedDoc>(seedPath);
  let created = false;
  if (!seed) {
    seed = { mnemonic: newMnemonic(), network: "bitcoin", createdAt: new Date().toISOString() };
    await writeAtomic(seedPath, JSON.stringify(seed, null, 2) + "\n", SEED_MODE);
    created = true;
  }

  const identity = StoreIdentity.fromMnemonic(
    seed.mnemonic, seed.passphrase || "", seed.network || "bitcoin");

  let state = await readJSON<IdentityState>(statePath);
  if (!state) {
    state = {
      paymentCode: identity.paymentCode(),
      notificationAddress: identity.notificationAddress(),
      receiverPaymentCode: null,
      nymName: null, nymId: null,
      notificationTxid: null, notificationSentAt: null,
      createdAt: seed.createdAt,
    };
    await writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n", 0o644);
  } else if (state.paymentCode !== identity.paymentCode()) {
    // The seed and the recorded identity disagree, which means the seed was
    // replaced under a shop that has already been running. Every address quoted
    // before now belongs to a code nobody is watching. Refuse loudly: deriving
    // on the new one would look like working software and lose money quietly.
    throw new Error(
      "the store seed no longer derives the recorded payment code " +
      `(recorded ${state.paymentCode.slice(0, 12)}…, seed derives ${identity.paymentCode().slice(0, 12)}…). ` +
      `Restore the original seed, or delete ${STATE_FILE} if this shop has never quoted an address.`);
  }

  return { identity, state, created };
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
 * Bind the operator's personal payment code as the receiver.
 *
 * Validated by actually parsing it rather than by shape: a typo that still
 * looks like a payment code would otherwise send every customer's payment to a
 * chain the operator holds no keys for, and nothing downstream would notice
 * until somebody had paid.
 */
export function bindReceiver(state: IdentityState, personalPaymentCode: string, network = "bitcoin"): IdentityState {
  const code = String(personalPaymentCode || "").trim();
  try {
    publicCode(code, network);
  } catch (e) {
    throw new Error(`that is not a usable BIP47 payment code: ${(e as Error).message}`);
  }
  if (code === state.paymentCode) {
    throw new Error(
      "the receiver cannot be the shop's own payment code: a shop paying itself derives nothing the operator can spend");
  }
  if (state.notificationTxid && state.receiverPaymentCode && state.receiverPaymentCode !== code) {
    // The notification on-chain names this pair. Re-pointing the receiver now
    // leaves that announcement describing a relationship the shop no longer
    // uses, and the new receiver's wallet was never told to watch.
    throw new Error(
      "the notification transaction for the current receiver is already on-chain; " +
      "changing the receiver now would strand it. Start a new shop identity instead.");
  }
  return { ...state, receiverPaymentCode: code };
}

/** What the shop still needs before it can quote an address to a customer. */
export function readiness(state: IdentityState): {
  ready: boolean;
  needsReceiver: boolean;
  needsNotification: boolean;
} {
  const needsReceiver = !state.receiverPaymentCode;
  const needsNotification = !state.notificationTxid;
  return { ready: !needsReceiver && !needsNotification, needsReceiver, needsNotification };
}
