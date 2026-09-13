// =============================================================================
// Verified operator domains.
//
// One domain per operator, bound to their BIP47 payment code and proven in both
// directions, so neither half alone is enough:
//
//   the domain asserts the code   a TXT record at _dojobay.<domain> naming the
//                                 payment code; publishing it needs control of
//                                 the domain
//   the code asserts the domain   a wallet-signed statement naming the domain;
//                                 producing it needs the PayNym's notification
//                                 key
//
// The signature is permanent and the TXT record is the revocable half. Remove
// the record and the next sweep fails; after a grace period the badge drops,
// while the claim is kept so restoring the record restores the badge without
// re-signing. A domain that changes hands therefore stops being claimable by
// its old owner without anyone having to notice.
//
// The signed statement deliberately omits this instance's onion, so a proof is
// portable: a bootstrap import or peer sync carries it intact.
//
// A verified badge attests to CONTROL of a domain, not to trustworthiness: a
// lookalike domain verifies exactly as easily as a real one. Hence admin
// revocation, and punycode display for anything non-ASCII.
// =============================================================================
import { claimText, verifySignedUrlClaim } from "./crypto.ts";
import { txtRecordAgreed } from "./dns.ts";
import type { TxtAgreement } from "./dns.ts";
import type { DomainClaim, ProbeCfg } from "../types.js";

type LookupCfg = Partial<ProbeCfg>;

/** A normalised domain, or the reason the input could not be one. */
export type NormalisedDomain =
  | { ok: true; domain: string; punycode: boolean; error?: undefined }
  | { ok: false; error: string; domain?: undefined; punycode?: undefined };

export interface ClaimVerification {
  ok: boolean;
  stage?: "signature" | "dns";
  error?: string;
  hint?: string | null;
  inconclusive?: boolean;
  agreed?: number;
  answered?: number;
}

export const TXT_PREFIX = "_dojobay";
export const CLAIM_VERSION = "dojobay-domain-v1";
export const RECHECK_MS = +(process.env.DOMAIN_RECHECK_HOURS || 24) * 3600 * 1000;
/** A claim awaiting its first successful lookup is retried far more often: the
 *  operator has just published a TXT record and is waiting for propagation. */
export const PENDING_RECHECK_MS = +(process.env.DOMAIN_PENDING_RECHECK_MINUTES || 5) * 60 * 1000;
export const GRACE_DAYS = +(process.env.DOMAIN_GRACE_DAYS || 7);

// Accept "example.com", "example.com/", "https://example.com" or a full URL and
// reduce it to the bare ASCII host. Rejects anything that cannot be a public
// domain an operator could publish a TXT record on.
export function normaliseDomain(input: unknown): NormalisedDomain {
  let raw = String(input || "").trim().toLowerCase();
  if (!raw) return { ok: false, error: "enter a domain" };
  if (raw.includes(" ")) return { ok: false, error: "a domain cannot contain spaces" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) raw = "https://" + raw;
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, error: "that is not a valid domain" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "use a plain domain, not a " + u.protocol.replace(":", "") + " URL" };
  if (u.username || u.password) return { ok: false, error: "a domain cannot contain a username or password" };
  if (u.port) return { ok: false, error: "leave the port off: verification uses DNS, not a web server" };
  const host = u.hostname;                              // WHATWG URL gives punycode for IDN
  if (host.endsWith(".onion")) return { ok: false, error: "an onion address cannot be verified by DNS; this field is for a clearnet domain you own" };
  if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) {
    return { ok: false, error: "use a domain name, not an IP address" };
  }
  if (!/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    return { ok: false, error: "that is not a valid domain name" };
  }
  if (host.split(".").length < 2) return { ok: false, error: "include the full domain, for example example.com" };
  return { ok: true, domain: host, punycode: /[^\x00-\x7F]/.test(String(input)) || host.includes("xn--") };
}

export const txtName = (domain: string): string => `${TXT_PREFIX}.${domain}`;
/** The Host/Name field in a DNS panel is relative to the zone, so most control
 *  panels want just this label. Handing over the fully-qualified name instead is
 *  the classic way to end up with _dojobay.example.com.example.com. */
export const txtHost = (): string => TXT_PREFIX;
export const txtValue = (paymentCode: string): string => `${CLAIM_VERSION} pm=${paymentCode}`;
export const signingText = (domain: string, paymentCode: string): string => claimText(`https://${domain}`, paymentCode);

// Does a TXT record claim this payment code? Tolerant of extra whitespace and
// of the record being wrapped in quotes by a DNS UI, strict about the code.
export function txtMatches(record: unknown, paymentCode: string): boolean {
  const r = String(record || "").trim().replace(/^"|"$/g, "").replace(/\s+/g, " ");
  if (!r.startsWith(CLAIM_VERSION)) return false;
  const m = r.match(/\bpm=(PM8T[1-9A-HJ-NP-Za-km-z]+)/);
  return !!m && m[1] === paymentCode;
}

// Full verification: the signature first (cheap, local, and the operator's most
// likely mistake), then DNS (slow, over Tor).
export async function verifyClaim(
  { domain, paymentCode, signed }: { domain: string; paymentCode: string; signed: string },
  cfg: LookupCfg = {},
): Promise<ClaimVerification> {
  const sig = verifySignedUrlClaim({ signed, expectedUrl: `https://${domain}`, paymentCode });
  if (!sig.ok) return { ok: false, stage: "signature", error: sig.error };
  const dns = await txtRecordAgreed(txtName(domain), (r) => txtMatches(r, paymentCode), cfg);
  if (!dns.ok) {
    return { ok: false, stage: "dns", inconclusive: !!dns.inconclusive, error: dns.error,
      hint: dns.inconclusive ? null : `publish a TXT record at ${txtName(domain)} containing: ${txtValue(paymentCode)}` };
  }
  return { ok: true, agreed: dns.agreed, answered: dns.answered };
}

// DNS-only re-check for the periodic sweep: the signature is immutable once
// accepted, so there is nothing to re-verify locally.
export async function recheckClaim(claim: DomainClaim, cfg: LookupCfg = {}): Promise<TxtAgreement> {
  return txtRecordAgreed(txtName(claim.domain), (r) => txtMatches(r, claim.paymentCode), cfg);
}

// Fold a re-check result into a claim, applying the grace period. Pure, so the
// policy is testable without any network.
export function applyRecheck(claim: DomainClaim, result: TxtAgreement, now: number = Date.now()): DomainClaim {
  const next: DomainClaim = { ...claim, last_check: new Date(now).toISOString() };
  if (result.inconclusive) {
    // Could not tell. Change nothing except the timestamp, and say so.
    next.last_result = "inconclusive: " + (result.error || "no detail");
    return next;
  }
  if (result.ok) {
    next.verified = true;
    next.verified_at = next.verified_at || new Date(now).toISOString();
    next.fail_since = null;
    next.last_result = "ok";
    return next;
  }
  next.last_result = result.error || "no matching TXT record";
  next.fail_since = claim.fail_since || new Date(now).toISOString();
  const failingMs = now - Date.parse(next.fail_since);
  if (failingMs >= GRACE_DAYS * 86400 * 1000) next.verified = false;
  return next;
}

export const isDue = (claim: DomainClaim, now: number = Date.now()): boolean => {
  if (!claim.last_check) return true;
  const since = now - Date.parse(claim.last_check);
  return since >= (claim.verified ? RECHECK_MS : PENDING_RECHECK_MS);
};

// A URL is publishable as a card link only if it sits on the operator's verified
// domain (the domain itself or a subdomain of it). This is what stops a card
// carrying an unverifiable social profile while keeping "link to my own site".
export function urlOnDomain(url: unknown, domain: string | null | undefined): boolean {
  if (!url || !domain) return false;
  let u: URL;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase();
  return h === domain || h.endsWith("." + domain);
}
