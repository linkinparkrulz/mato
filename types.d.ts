// =============================================================================
// Shared shapes for the type-checked JavaScript pass.
//
// Nothing here is compiled or shipped: `npm run typecheck` reads it, Node never
// sees it. It exists because the record shapes in this project have drifted
// repeatedly — detected_version, indexer_url and operator_domain were each added
// in a different commit, in three different places — and there was no single
// statement of what a node record actually is. Referencing these from JSDoc
// (`@type {import("../types.js").PublicNode}`) makes a drift a type error.
// =============================================================================

/** A node as published in data/dojos.json and rendered on a card. */
export interface PublicNode {
  id: string;
  network: "mainnet" | "testnet";
  name: string;
  status: "active" | "inactive";
  paynym: string | null;
  paymentCode: string | null;
  jurisdiction: string | null;
  country: string | null;
  hardware: string | null;
  /** Effective version: the live-probed reading, else the pairing payload's. */
  version: string | null;
  /** Read from the node's X-Dojo-Version response header by the updater. */
  detected_version: string | null;
  /** Read from the node's /support/services by the updater. */
  detected_indexer: string | null;
  /** Published Electrum endpoint: detected, else declared. Null renders N/A. */
  indexer_url: string | null;
  /** The operator's verified domain, if they have proved one. */
  operator_domain: string | null;
  /** Everything a reader needs to check that claim themselves, without
   *  trusting this instance: the TXT record to look up, and the signed
   *  statement to verify. All of it is already public. */
  operator_domain_proof: {
    domain: string;
    paymentCode: string;
    txt_name: string;
    txt_value: string;
    signed: string;
    verified_at: string | null;
  } | null;
  checked_at: string | null;
  block_height: number | null;
  payload: PairingPayload;
  signed: string | null;
}

export interface PairingPayload {
  pairing: {
    type: string;
    version?: string;
    apikey?: string;
    url: string;
  };
  explorer?: { type?: string; url?: string };
  // A Dojo export may carry these; the gate stores neither, because the
  // signature covers pairing and explorer only. Present here so a parsed export
  // types cleanly, not because anything reads them. See build-public.ts on why
  // the Electrum endpoint is probed rather than declared.
  indexer?: { type?: string; url?: string };
  services?: Array<{ type?: string; kind?: string; url?: string }>;
}

/** An operator's submission as held in the store (server/data/store.json). */
export interface StoreRecord {
  id: string;
  network: "mainnet" | "testnet";
  name: string;
  /** Moderation state; ids are immutable so history survives a rename. */
  status: "pending" | "approved" | "rejected";
  /** A PayNym usually has two BIP47 variants; either may have signed. */
  paymentCodes: string[];
  payload: PairingPayload;
  // Everything below is genuinely optional: records written by different paths
  // (submission, migration, bootstrap import) carry different subsets, and an
  // absent field and an explicit null both occur in the live store.
  /** Removed from the UI and never published. Older records may still carry it. */
  name_url?: string | null;
  paynym?: string | null;
  jurisdiction?: string | null;
  country?: string | null;
  hardware?: string | null;
  signed?: string | null;
  /** The probe result recorded when the submission was accepted. */
  last_probe?: ProbeResult;
  created_at?: string;
  updated_at?: string;
  /** Provenance when the record arrived via scripts/bootstrap-import. */
  source?: string;
}

/** A verified operator domain, keyed by payment code. */
export interface DomainClaim {
  paymentCode: string;
  domain: string;
  /** The wallet-signed statement; permanent, unlike the TXT record. */
  signed: string;
  verified: boolean;
  verified_at: string | null;
  last_check: string | null;
  last_result: string | null;
  /** Set when a re-check first fails; the grace period runs from here. */
  fail_since: string | null;
  created_at: string;
  revoked?: boolean;
  also_claimed_by?: string | null;
}

/**
 * Transport settings a probe cannot work without. Marked required deliberately:
 * omitting them is the bug that broke the installer's anchor check, where
 * net.connect was handed an undefined port.
 */
export interface ProbeCfg {
  proxyHost: string;
  proxyPort: number;
  timeoutMs: number;
  /** Simultaneous Tor circuits. Only the cycle runner reads it; a single probe ignores it. */
  concurrency?: number;
  apikey?: string;
  network?: string;
  connectOnly?: boolean;
  dojoVersionHeader?: string;
}

export interface ProbeResult {
  up: boolean;
  reason: string;
  ms: number;
  height?: number;
  blockTime?: number | null;
  detectedVersion?: string | null;
  detectedIndexer?: string | null;
}

// Front-end globals: assets/js/app.js is a plain script, and these are provided
// by the separate <script> tags for qrcode.js and markdown.js.
declare global {
  const qrcode: (typeNumber: number, errorCorrectionLevel: string) => {
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  };
  const markdown: { render(src: string): string };
}

// =============================================================================
// Storefront shapes.
//
// These live alongside the directory shapes above while the fork is in
// progress; the node types go when the front end and the request layer are
// reworked. Nothing here is compiled or shipped.
// =============================================================================

/** An address the gateway derived and signed. Mirrors gateway/identity.ts. */
export interface SignedAddress {
  v: 1;
  address: string;
  index: number;
  type: "p2pkh" | "p2sh" | "p2wpkh";
  network: string;
  /** The STORE's payment code: what the signature is checked against. */
  paymentCode: string;
  signed: string;
}

/** A product as held in the store. */
export interface ProductRecord {
  id: string;
  name: string;
  /** Markdown, rendered by assets/js/markdown.js. */
  description: string;
  /**
   * Integer cents, never a float. A price is money and money is not a binary
   * fraction: 0.1 + 0.2 is the classic way to undercharge by a cent forever.
   */
  price_usd_cents: number;
  /** Units remaining. null means unlimited, which a digital good often is. */
  inventory: number | null;
  image_path?: string | null;
  /**
   * What the buyer receives once payment confirms — a path, a URL, or a secret.
   * NEVER published: the catalogue allowlist is what guarantees that
   * structurally rather than by everyone remembering to strip it.
   */
  digital_payload_ref?: string | null;
  status: "draft" | "listed" | "hidden";
  created_at?: string;
  updated_at?: string;
}

/** The lifecycle of an invoice. */
export type InvoiceStatus =
  | "awaiting_payment"
  | "seen"
  | "confirmed"
  | "fulfilled"
  | "expired"
  | "underpaid";

/** One order. The id is the customer's claim on it when they have no PayNym. */
export interface InvoiceRecord {
  id: string;
  /**
   * The chain this invoice was quoted on.
   *
   * A shop keeps an identity per network and can switch between them, so an
   * address alone does not say which chain it belongs to. Without this the
   * payment watcher would look for a testnet address on mainnet, and
   * invoiceByAddress could hand back the wrong order.
   */
  network: "bitcoin" | "testnet4";
  product_id: string;
  quantity: number;
  status: InvoiceStatus;
  /** The full signed record, served to the customer so they can check it. */
  address_record: SignedAddress;
  /** Denormalised from address_record for lookup by the payment watcher. */
  address: string;
  address_index: number;
  /** Price at creation, in cents. Frozen: a later price change is not this order. */
  price_usd_cents: number;
  /** USD per BTC, locked at creation. */
  rate_usd: number;
  /** When that rate was read. Must be close to created_at; see the chokepoint. */
  rate_at: string;
  amount_sats: number;
  expires_at: string;
  /** The customer's payment code when they signed in; null for guest checkout. */
  paymentCode?: string | null;
  paid_sats?: number;
  txid?: string | null;
  seen_at?: string | null;
  confirmed_at?: string | null;
  fulfilled_at?: string | null;
  created_at?: string;
  updated_at?: string;
}
