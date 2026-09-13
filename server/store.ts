// Tiny JSON-file store for the backend. Single-writer (one server process),
// atomic writes, no external database. Holds submissions, live sessions and
// outstanding Auth47 nonces.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { StoreRecord, DomainClaim } from "../types.js";

/** A short-lived, single-use Auth47 nonce. */
export interface Nonce { expires: number; [k: string]: unknown }
/** A signed-in operator's session, keyed by a random cookie id. */
export interface Session { paymentCode: string; expires: number; [k: string]: unknown }

interface StoreShape {
  submissions: Record<string, StoreRecord>;
  sessions: Record<string, Session>;
  nonces: Record<string, Nonce>;
  domains: Record<string, DomainClaim>;
}

const DIR = process.env.SERVER_DATA_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");
const FILE = path.join(DIR, "store.json");

const EMPTY: StoreShape = { submissions: {}, sessions: {}, nonces: {}, domains: {} };
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
