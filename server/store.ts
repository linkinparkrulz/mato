// Tiny JSON-file store for the backend. Single-writer (one server process),
// atomic writes, no external database. Holds submissions, live sessions and
// outstanding Auth47 nonces.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { StoreRecord, DomainClaim, ProductRecord, InvoiceRecord } from "../types.js";

/** A short-lived, single-use Auth47 nonce. */
export interface Nonce { expires: number; [k: string]: unknown }
/** A signed-in operator's session, keyed by a random cookie id. */
export interface Session { paymentCode: string; expires: number; [k: string]: unknown }

interface StoreShape {
  submissions: Record<string, StoreRecord>;
  sessions: Record<string, Session>;
  nonces: Record<string, Nonce>;
  domains: Record<string, DomainClaim>;
  products: Record<string, ProductRecord>;
  invoices: Record<string, InvoiceRecord>;
}

/**
 * How far apart an invoice's locked rate and its creation may be.
 *
 * Checked against created_at rather than against now, deliberately. "The rate
 * was fresh when this invoice was written" is a property of the record that
 * stays true forever and can be re-checked at any time; "the rate is fresh now"
 * would be true at creation and false an hour later, so enforcing it on every
 * write would make an ordinary status update fail on a perfectly good invoice.
 */
export const RATE_MAX_AGE_MS = +(process.env.RATE_MAX_AGE_MS || 15 * 60 * 1000);

const DIR = process.env.SERVER_DATA_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");
const FILE = path.join(DIR, "store.json");

const EMPTY: StoreShape = { submissions: {}, sessions: {}, nonces: {}, domains: {}, products: {}, invoices: {} };
let cache: StoreShape | null = null;

// Whether a record carries a signed pairing block at all. A shape check, not a
// verification: the submit gate decided whether the block verifies against the
// operator's own payment code, and re-deriving that at every read would mean
// the store and the rebuild silently dropping listings over a cryptographic
// judgement made elsewhere. This asks only what a caller is entitled to ask
// here, which is whether there is anything for a visitor to check.
// server/audit-signed.mjs is the tool that re-runs the real verification over
// the whole store. It lives in this file rather than beside the verifier so
// that store.ts stays on node builtins alone: remove-listing.ts and the
// migration scripts import the store, and should not have to pull in secp256k1
// to ask a question about a string.
export function hasSignedBlock(rec: { signed?: string | null } | null | undefined): boolean {
  const signed = typeof rec?.signed === "string" ? rec.signed.trim() : "";
  return signed.includes("BEGIN BITCOIN SIGNED MESSAGE") && signed.includes("BEGIN BITCOIN SIGNATURE");
}

// A submission's ownership is a paymentCodes ARRAY, because one PayNym often
// carries two BIP47 codes (segwit and legacy variants) and the wallet may sign
// Auth47 with either. Records written before this schema carried a scalar
// paymentCode; normalise those on read so old store files keep working.
function normaliseSubmission<T>(rec: T): T {
  if (!rec || typeof rec !== "object") return rec;
  const r = rec as { paymentCodes?: unknown; paymentCode?: string };
  if (!Array.isArray(r.paymentCodes)) {
    r.paymentCodes = r.paymentCode ? [r.paymentCode] : [];
  }
  r.paymentCodes = [...new Set((r.paymentCodes as unknown[]).filter((c): c is string => typeof c === "string" && !!c))];
  delete r.paymentCode;
  return rec;
}

async function load(): Promise<StoreShape> {
  if (cache) return cache;
  await mkdir(DIR, { recursive: true });
  try {
    cache = { ...EMPTY, ...JSON.parse(await readFile(FILE, "utf8")) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    cache = structuredClone(EMPTY);
  }
  for (const rec of Object.values(cache.submissions)) normaliseSubmission(rec);
  return cache;
}

// A temporary name no other writer can take; see build-public.ts. The store has
// a single writer by design, but the backend and a maintenance script can both
// be pointed at it, and that is precisely when a shared temporary name bites.
let tmpSeq = 0;
async function persist() {
  const tmp = `${FILE}.${process.pid}.${(tmpSeq = (tmpSeq + 1) % 1e6)}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2) + "\n");
  await rename(tmp, FILE);
}

export const store = {
  async get() { return load(); },
  async save() { await persist(); },

  // --- nonces (single-use, short lived) ---
  async putNonce(nonce: string, data: Nonce) { (await load()).nonces[nonce] = data; await persist(); },
  async takeNonce(nonce: string): Promise<Nonce | null> {
    const s = await load();
    const n = s.nonces[nonce];
    if (n) { delete s.nonces[nonce]; await persist(); }
    return n || null;
  },
  async gcNonces(now: number = Date.now()) {
    const s = await load();
    let changed = false;
    for (const [k, v] of Object.entries(s.nonces)) {
      if (!v || v.expires < now) { delete s.nonces[k]; changed = true; }
    }
    if (changed) await persist();
  },

  // --- sessions ---
  async putSession(data: Session): Promise<string> {
    const s = await load();
    const id = randomBytes(32).toString("hex");
    s.sessions[id] = data;
    await persist();
    return id;
  },
  async getSession(id: string | null | undefined): Promise<Session | null> {
    if (!id) return null;
    const s = await load();
    const sess = s.sessions[id];
    if (!sess) return null;
    if (sess.expires < Date.now()) { delete s.sessions[id]; await persist(); return null; }
    return sess;
  },
  async dropSession(id: string) {
    const s = await load();
    if (s.sessions[id]) { delete s.sessions[id]; await persist(); }
  },

  // --- submissions (keyed by network + name slug; owned by paymentCodes[]) ---
  async listSubmissions(): Promise<StoreRecord[]> { return Object.values((await load()).submissions); },
  async submissionsFor(paymentCode: string): Promise<StoreRecord[]> {
    return Object.values((await load()).submissions)
      .filter((r) => Array.isArray(r.paymentCodes) && r.paymentCodes.includes(paymentCode));
  },
  // Every record must carry at least one BIP47 payment code and a signed
  // pairing block. This is the single chokepoint through which every write to
  // the store passes, so enforcing both here is what makes an unowned or
  // unattested listing structurally impossible rather than merely discouraged:
  // the payment code is the identity the directory rests on, and the signature
  // is what lets a visitor check the pairing details against that identity
  // without trusting this site at all. A listing without one cannot be owned,
  // edited, verified or recognised by a visitor; a listing without the other
  // asks the visitor to take our word for an onion address and an API key,
  // which is the one thing this directory exists not to require. Historically a
  // few pre-Auth47 records existed without a code, and rather more predate the
  // signature gate; both doors are now closed.
  async putSubmission(rec: StoreRecord): Promise<StoreRecord> {
    const normalised = normaliseSubmission(rec);
    const codes = (normalised as StoreRecord).paymentCodes;
    // An emptiness guard, deliberately, not a validator: whether a code is a
    // real BIP47 payment code is settled at the gates that admit it — an Auth47
    // session proves possession, and the signature checks derive its
    // notification address. What must be impossible HERE is a listing with no
    // owner at all.
    if (!Array.isArray(codes) || !codes.some((c) => typeof c === "string" && /^PM\w{6,}/.test(c.trim()))) {
      throw new Error(`refusing to store ${rec?.id}: a listing must carry a BIP47 payment code`);
    }
    // The same kind of guard for the signature: a shape check, not a
    // verification. Whether the block verifies against the record's own code is
    // settled at the submit and pairing-edit gates, which have the session and
    // the canonical message to hand and can say precisely what is wrong. What
    // must be impossible HERE is a record whose pairing details nobody has
    // attested to, however it was assembled — by an admin action, an import, a
    // migration or a future endpoint that has not been written yet.
    if (!hasSignedBlock(normalised)) {
      throw new Error(`refusing to store ${rec?.id}: a listing must carry a signed pairing block. ` +
        `Ask the operator to sign their pairing payload, or remove the listing with server/remove-listing.ts.`);
    }
    const s = await load();
    s.submissions[rec.id] = normalised;
    await persist();
    return rec;
  },
  async getSubmission(id: string): Promise<StoreRecord | null> {
    const rec = (await load()).submissions[id] || null;
    return rec ? normaliseSubmission(rec) : null;
  },
  // Retention: a rejected submission is kept briefly so a maintainer can reverse
  // a mistake, then deleted. Nothing else ever removed one, so the store
  // accumulated the payment code, pairing payload and signature of every
  // operator ever turned down — including the apikey, which is a live
  // credential to their Dojo, not merely metadata. Returns the ids removed.
  async pruneRejected(days: number, now: number = Date.now()): Promise<string[]> {
    const s = await load();
    const cutoff = now - days * 86400 * 1000;
    const gone: string[] = [];
    for (const [id, rec] of Object.entries(s.submissions)) {
      if (rec?.status !== "rejected") continue;
      const stamp = Date.parse(rec.updated_at || rec.created_at || "");
      // A record with no usable timestamp is pruned rather than kept forever.
      if (Number.isFinite(stamp) && stamp > cutoff) continue;
      delete s.submissions[id];
      gone.push(id);
    }
    if (gone.length) await persist();
    return gone;
  },

  async deleteSubmission(id: string) {
    const s = await load();
    if (s.submissions[id]) { delete s.submissions[id]; await persist(); }
  },

  // --- products --------------------------------------------------------------
  async listProducts(): Promise<ProductRecord[]> { return Object.values((await load()).products || {}); },
  async getProduct(id: string): Promise<ProductRecord | null> { return ((await load()).products || {})[id] || null; },

  /**
   * The one door every product write passes through.
   *
   * The guards are about what a catalogue may not contain rather than about
   * taste: a price that is not a whole number of cents is money represented as
   * a binary fraction, and it will undercharge or overcharge by a cent
   * eventually; negative inventory sells stock that does not exist. Both are
   * cheap to prevent here and expensive to discover from an invoice.
   */
  async putProduct(rec: ProductRecord): Promise<ProductRecord> {
    if (!rec?.id || typeof rec.id !== "string") {
      throw new Error("refusing to store a product with no id");
    }
    if (!Number.isInteger(rec.price_usd_cents) || rec.price_usd_cents < 0) {
      throw new Error(`refusing to store ${rec.id}: price_usd_cents must be a non-negative whole number of cents`);
    }
    if (rec.inventory !== null && (!Number.isInteger(rec.inventory) || rec.inventory < 0)) {
      throw new Error(`refusing to store ${rec.id}: inventory must be null (unlimited) or a non-negative integer`);
    }
    const s = await load();
    s.products = s.products || {};
    s.products[rec.id] = rec;
    await persist();
    return rec;
  },

  async deleteProduct(id: string) {
    const s = await load();
    if (s.products?.[id]) { delete s.products[id]; await persist(); }
  },

  // --- invoices ---------------------------------------------------------------
  async listInvoices(): Promise<InvoiceRecord[]> { return Object.values((await load()).invoices || {}); },
  async getInvoice(id: string): Promise<InvoiceRecord | null> { return ((await load()).invoices || {})[id] || null; },

  /** The invoice an address belongs to, for the payment watcher. */
  async invoiceByAddress(address: string): Promise<InvoiceRecord | null> {
    if (!address) return null;
    return Object.values((await load()).invoices || {}).find((i) => i.address === address) || null;
  },

  async invoicesFor(paymentCode: string): Promise<InvoiceRecord[]> {
    if (!paymentCode) return [];
    return Object.values((await load()).invoices || {}).filter((i) => i.paymentCode === paymentCode);
  },

  /**
   * The one door every invoice write passes through, and the place two
   * invariants become structural rather than conventional.
   *
   * FIRST: an invoice must carry a signed address record. The signature is what
   * lets a customer check that the address they are about to pay belongs to
   * this store, without trusting the page it arrived on. An invoice without one
   * asks them to take the server's word for where their money goes, which is
   * the one thing this design exists not to require. Verifying the signature
   * needs secp256k1, which this module deliberately does not import — see
   * hasSignedBlock above for the same reasoning — so the cryptographic check
   * belongs to address-source.ts, which does it on arrival from the gateway.
   * What must be impossible HERE is a record with no attestation at all,
   * however it was assembled: by an admin action, a migration, or an endpoint
   * nobody has written yet.
   *
   * SECOND: the locked rate must be close to the moment of creation. Compared
   * against created_at rather than against now, so it is a permanent property
   * of the record rather than one that decays; see RATE_MAX_AGE_MS. An invoice
   * priced from a stale rate is a mispriced sale, and mispricing quietly is the
   * failure a store must not have.
   */
  async putInvoice(rec: InvoiceRecord): Promise<InvoiceRecord> {
    if (!rec?.id || typeof rec.id !== "string") {
      throw new Error("refusing to store an invoice with no id");
    }
    const signed = rec.address_record;
    if (!signed || typeof signed.signed !== "string" || !signed.signed || !signed.address) {
      throw new Error(`refusing to store invoice ${rec.id}: an invoice must carry a signed address record, ` +
        `so the customer can check where their money is going without trusting this server.`);
    }
    if (rec.address !== signed.address) {
      throw new Error(`refusing to store invoice ${rec.id}: the invoice address does not match the signed record`);
    }
    if (!Number.isInteger(rec.amount_sats) || rec.amount_sats <= 0) {
      throw new Error(`refusing to store invoice ${rec.id}: amount_sats must be a positive whole number of satoshis`);
    }
    if (!(rec.rate_usd > 0)) {
      throw new Error(`refusing to store invoice ${rec.id}: rate_usd must be a positive number`);
    }
    const created = Date.parse(rec.created_at || "");
    const rateAt = Date.parse(rec.rate_at || "");
    if (!Number.isFinite(created) || !Number.isFinite(rateAt)) {
      throw new Error(`refusing to store invoice ${rec.id}: created_at and rate_at must both be timestamps`);
    }
    if (Math.abs(created - rateAt) > RATE_MAX_AGE_MS) {
      throw new Error(`refusing to store invoice ${rec.id}: it was priced from a rate ` +
        `${Math.round(Math.abs(created - rateAt) / 1000)}s away from its creation, beyond the ` +
        `${Math.round(RATE_MAX_AGE_MS / 1000)}s limit. A stale rate is a mispriced sale.`);
    }
    const s = await load();
    s.invoices = s.invoices || {};
    s.invoices[rec.id] = rec;
    await persist();
    return rec;
  },

  async deleteInvoice(id: string) {
    const s = await load();
    if (s.invoices?.[id]) { delete s.invoices[id]; await persist(); }
  },

  // --- verified operator domains (keyed by payment code) ---------------------
  // One claim per code. A record is kept even after it stops verifying, so
  // restoring the TXT record restores the badge without a fresh signature.
  async listDomains(): Promise<DomainClaim[]> { return Object.values((await load()).domains || {}); },
  async getDomain(paymentCode: string): Promise<DomainClaim | null> { return ((await load()).domains || {})[paymentCode] || null; },
  async putDomain(claim: DomainClaim): Promise<DomainClaim> {
    const s = await load();
    s.domains = s.domains || {};
    s.domains[claim.paymentCode] = claim;
    await persist();
    return claim;
  },
  async deleteDomain(paymentCode: string) {
    const s = await load();
    if (s.domains && s.domains[paymentCode]) { delete s.domains[paymentCode]; await persist(); }
  },
  // Every verified domain, as a payment code -> domain map, for the rebuild.
  async verifiedDomainMap(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const c of Object.values((await load()).domains || {})) {
      if (c && c.verified && c.domain) out.set(c.paymentCode, c.domain);
    }
    return out;
  },
};
