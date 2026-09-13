// Pure helpers for the Dojo Bay installer: input validators, config
// renderers, and the terminal theme. No I/O and no prompts here -- everything
// is a plain function so scripts/selftest.mjs can exercise the installer's
// logic without a terminal. Node builtins only.
import path from "node:path";

// ---- validators -------------------------------------------------------------
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export const isPaymentCode = (v) =>
  typeof v === "string" && v.startsWith("PM8T") && v.length === 116 && BASE58.test(v);
export const isOnionHost = (v) =>
  typeof v === "string" && /^[a-z2-7]{56}\.onion$/.test(v.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
export const onionHostOf = (v) =>
  String(v || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
export const isNodeName = (v) => {
  const slug = String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 && String(v).trim().length <= 40;
};
// The network a pairing URL is for. Defined in server/dojo-version.ts, because
// the submission gate needs the same judgement and a rule with two definitions
// is a rule waiting to disagree with itself. Re-exported here so the installer
// has one import for its validation.
import { pairingNetwork } from "../server/dojo-version.ts";
export { pairingNetwork };

/**
 * @param {string} text
 * @param {{ network?: string }} [opts] the network the operator chose, if known.
 *   Omitted, the URL is not judged against anything.
 */
export function parsePairing(text, { network } = {}) {
  let p;
  try { p = JSON.parse(text); } catch { return { ok: false, error: "not valid JSON" }; }
  const url = p?.pairing?.url;
  if (p?.pairing?.type !== "dojo.api") return { ok: false, error: "pairing.type must be dojo.api" };
  if (typeof url !== "string" || !/^http:\/\/[a-z2-7]{56}\.onion/.test(url)) {
    return { ok: false, error: "pairing.url must be an http .onion URL" };
  }
  if (!p.pairing.apikey) return { ok: false, error: "pairing.apikey missing" };
  if (network) {
    const looks = pairingNetwork(url);
    if (looks && looks !== network) {
      return { ok: false, error: network === "testnet"
        ? "you chose testnet, but this URL has no /test/ path segment, so it is a mainnet "
          + "endpoint. A testnet Dojo serves http://<onion>/test/v2. Either paste the testnet "
          + "payload or change the network above."
        : "you chose mainnet, but this URL has a /test/ path segment, so it is a testnet "
          + "endpoint. A mainnet Dojo serves http://<onion>/v2. Either paste the mainnet "
          + "payload or change the network above." };
    }
  }
  return { ok: true, payload: p };
}

// The exact text the operator signs in the wallet: onion URL, blank line,
// BIP47 line. This whole text is inside the signature (see crypto.ts).
export const operatorMessage = (onionHost, paymentCode) =>
  `http://${onionHost}/\n\nBIP47: ${paymentCode}`;

// ---- torrc ------------------------------------------------------------------
export const TORRC_MARK = "# dojobay hidden service (managed by scripts/install.mjs)";
export function torrcBlock(hsDir) {
  return `${TORRC_MARK}\nHiddenServiceDir ${hsDir}\nHiddenServicePort 80 127.0.0.1:8080\n`;
}
// Idempotent: replaces an existing managed block, appends otherwise.
export function mergeTorrc(existing, hsDir) {
  const block = torrcBlock(hsDir);
  const re = new RegExp(TORRC_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n(?:HiddenService\\S* [^\\n]*\\n?)*", "m");
  if (re.test(existing)) return existing.replace(re, block);
  return existing.replace(/\n*$/, "\n\n") + block;
}

// The reverse of mergeTorrc: take out the block we put in, and nothing else.
// Surgical on purpose — a torrc usually carries an operator's other hidden
// services and settings, and an uninstaller that rewrites the file wholesale
// would take those with it.
export function stripTorrc(existing) {
  const re = new RegExp("\\n*" + TORRC_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    + "\\n(?:HiddenService\\S* [^\\n]*\\n?)*", "m");
  if (!re.test(existing)) return { text: existing, removed: false };
  return { text: existing.replace(re, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, ""), removed: true };
}

// ---- systemd + nginx rendering ----------------------------------------------
// Templates ship in scripts/ and deploy/ with the reference values baked in;
// rendering is a substitution over those known markers.
// The account both services run as. It is rendered into the units, and the
// installer creates it, because the templates shipped with names that were true
// of one particular machine and of nobody else's: the backend unit said deploy
// and the updater unit said dojobay, neither renderer touched either line, and
// the installer created neither account. On a fresh box both services therefore
// failed to start with 217/USER. Nothing said so out loud: nginx serves the
// directory as static files whether or not the backend is alive, so the site
// came up looking correct while the updater never ran once, which is why an
// install could finish with stale statuses, no block heights and no avatars.
export const SERVICE_USER = "dojobay";

export function renderServerUnit(template, { webRoot, baseUrl, adminCode, user = SERVICE_USER }) {
  return template
    .replace(/^User=.*$/gm, `User=${user}`)
    .replace(/^Group=.*$/gm, `Group=${user}`)
    .replace(/WorkingDirectory=.*/g, `WorkingDirectory=${path.join(webRoot, "server")}`)
    .replace(/Environment=BASE_URL=.*/g, `Environment=BASE_URL=${baseUrl}`)
    .replace(/Environment=ADMIN_PAYMENT_CODES=.*/g, `Environment=ADMIN_PAYMENT_CODES=${adminCode}`)
    .replace(/ExecStart=.*/g, `ExecStart=/usr/bin/env node ${path.join(webRoot, "server", "index.mjs")}`);
}
export function renderUpdateUnit(template, { webRoot, user = SERVICE_USER }) {
  return template
    .replace(/^User=.*$/gm, `User=${user}`)
    .replace(/^Group=.*$/gm, `Group=${user}`)
    .replace(/WorkingDirectory=.*/g, `WorkingDirectory=${webRoot}`)
    .replace(/ExecStart=.*/g, `ExecStart=/usr/bin/env node ${path.join(webRoot, "scripts", "update.mjs")}`);
}
// ---- reconciling what is installed against what ships -----------------------
// Nothing under /etc is touched by a deploy or a self-update: the units, the
// nginx site and the polkit rule are copied into place once and then drift. To
// compare them the renderer has to be run again, which needs the values the
// operator gave at install time, and those are not written down anywhere.
//
// They do not need to be. Every value a renderer substitutes is recoverable
// from the file it produced: the account from User=, the web root from
// WorkingDirectory= or ExecStart=, the onion and the admin code from their own
// Environment= lines. Reading them back and rendering the current template with
// them means an operator's own configuration is carried forward by construction
// rather than presented as drift, and it works on a machine that predates the
// installer and never recorded anything.
//
// The admin payment code passes through this function. It is published beside
// every listing and is not a secret, but it is still an operator's identity, so
// it is recovered and re-rendered, never logged and never written anywhere new.
export function recoverUnitValues(installed) {
  const first = (re) => { const m = installed.match(re); return m ? m[1].trim() : null; };
  const user = first(/^User=(.*)$/m);
  const wd = first(/^WorkingDirectory=(.*)$/m);
  const exec = first(/^ExecStart=.*?node\s+(\S+)\s*$/m);
  // The backend unit's WorkingDirectory is <webRoot>/server and the updater's is
  // <webRoot> itself, so the ExecStart path is the reliable one: both name a
  // file under the web root, at a known depth.
  let webRoot = null;
  if (exec && /\/server\/index\.mjs$/.test(exec)) webRoot = exec.replace(/\/server\/index\.mjs$/, "");
  else if (exec && /\/scripts\/update\.mjs$/.test(exec)) webRoot = exec.replace(/\/scripts\/update\.mjs$/, "");
  else if (wd) webRoot = wd.replace(/\/server$/, "");
  return {
    user: user || null,
    webRoot: webRoot || null,
    baseUrl: first(/^Environment=BASE_URL=(.*)$/m),
    adminCode: first(/^Environment=ADMIN_PAYMENT_CODES=(.*)$/m),
  };
}

// What the reconciler concluded about one file, with the reasoning kept out of
// the caller. "absent" is not "differs": a file that was never installed is a
// question about whether this machine wants it, and the polkit rule is
// legitimately absent on any instance whose operator declined it.
export function planSystemFile({ installed, shipped }) {
  if (installed === null || installed === undefined) return { state: "absent", changed: false };
  if (installed === shipped) return { state: "same", changed: false };
  return { state: "differs", changed: true };
}

export function renderNginx(template, { webRoot }) {
  return template.replace(/root \/var\/www\/dojobay;/g, `root ${webRoot};`);
}

// The unit name is fixed and the account is not, so only the account is
// substituted. Both are matched exactly rather than by pattern: a rule that
// matched a prefix would grant more than it says, and the whole argument for
// offering this at install time is that an operator can read what they are
// agreeing to in four lines.
export function renderPolkitRule(template, { user = SERVICE_USER, unit = "dojobay-server.service" } = {}) {
  return template
    .replace(/action\.lookup\("unit"\) == "[^"]*"/g, `action.lookup("unit") == "${unit}"`)
    .replace(/subject\.user == "[^"]*"/g, `subject.user == "${user}"`);
}

// Where that rule goes, and the pkcheck question that asks polkit the same
// thing systemd will ask. Exported so the installer and its tests agree on both
// rather than each spelling them out.
export const POLKIT_RULE_PATH = "/etc/polkit-1/rules.d/49-dojobay-restart.rules";
export const SYSTEMD_MANAGE_UNITS = "org.freedesktop.systemd1.manage-units";

// ---- seed / operator documents ----------------------------------------------
// `signed` is not optional, and the parameter is deliberately not defaulted:
// the rebuild withholds a seed node without a signed pairing block, exactly as
// it withholds any other unsigned listing, so an anchor built without one
// produces an instance whose directory is empty and which says nothing about
// why. It was optional once, and that is precisely what happened.
// The country normaliser lives in server/dojo-version.ts, with the network
// check, because the submission gate applies the same rule and a rule with two
// definitions is a rule waiting to disagree with itself. Re-exported so the
// installer has one import for its validation.
import { countryFor } from "../server/dojo-version.ts";
export { countryFor };

/**
 * @param {{ network: string, name: string, paymentCode: string, signed: string,
 *   paynym?: string|null, payload: any, jurisdiction?: string|null,
 *   country?: string|null, hardware?: string|null }} n
 */
export function anchorSeed({ network, name, paymentCode, paynym, payload, signed, jurisdiction, country, hardware }) {
  if (!signed || typeof signed !== "string" || !signed.includes("BEGIN BITCOIN SIGNATURE")) {
    throw new Error("anchorSeed: a signed pairing block is required, or the anchor will be withheld from the published directory");
  }
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return { nodes: [{
    id: `${network}-${slug}`, network, name: String(name).trim(),
    paynym: paynym || null, paymentCode,
    jurisdiction: jurisdiction || null, country: country || countryFor(jurisdiction),
    hardware: hardware || null,
    payload, signed,
  }] };
}
// paynym is optional and carries no security weight: the binding that matters
// is verifySigned, which proves the payment code signed this onion address. The
// name is a convenience so the Verify popup can link to the PayNym directory
// and a reader can check the operator's reputation for themselves. Instances
// installed before this field existed simply have no link, unless their
// operator adds it by hand or their own listing supplies it; nothing about
// verification changes either way.
export const operatorDoc = (onionHost, paymentCode, verifySigned, paynym = null) =>
  ({ onion: `http://${onionHost}/`, paymentCode, paynym: paynym || null, verifySigned });

// Collect a multiline paste from a readline interface, terminated by a line
// containing only `endWord`.
//
// CRITICAL: this MUST be a "line" listener, not a loop of rl.question(). A
// paste arrives as one or a few chunks, and readline emits a "line" event for
// every line in a chunk synchronously. A one-shot question consumes only the
// first of them; every other line in that chunk is emitted with nothing
// listening and is silently DROPPED. That is exactly what broke the installer's
// operator-signature step: the block came back missing lines, failed to parse,
// and reported "not a recognisable signed block" even though the operator had
// pasted a perfectly good signature. Attach the listener BEFORE prompting, so
// nothing can arrive unlistened.
/**
 * Collect a multi-line paste.
 *
 * Ends on a line containing just `endWord`, or as soon as `endMarker` is seen.
 *
 * The marker matters more than it looks. A wallet's signed block ends with
 * "-----END BITCOIN SIGNATURE-----", so an operator who pastes one and presses
 * Enter has, to their eye, finished — the block plainly says END. The collector
 * was still waiting for a bare END on its own line, so the installer looked
 * hung, and the only way out was Ctrl-C. Recognising the wallet's own
 * terminator means the commonest paste needs nothing typed after it.
 *
 * @param {import("node:readline").Interface} rl
 * @param {string} [endWord]
 * @param {{ endMarker?: string|null }} [opts]
 */
export function collectPasteFrom(rl, endWord = "END", { endMarker = null } = {}) {
  return new Promise((resolve) => {
    const lines = [];
    const cleanup = () => { rl.off("line", onLine); rl.off("close", onClose); };
    const onLine = (l) => {
      if (l.trim() === endWord) { cleanup(); resolve(lines.join("\n")); return; }
      lines.push(l);
      if (endMarker && l.trim() === endMarker) { cleanup(); resolve(lines.join("\n")); }
    };
    const onClose = () => { cleanup(); resolve(lines.join("\n")); };
    rl.on("line", onLine);
    rl.on("close", onClose);
  });
}

// ---- terminal theme ---------------------------------------------------------
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
// The brand red, #b5302a, the same --accent the site uses. Given exactly when
// the terminal admits to 24-bit colour and approximated as xterm 124 otherwise.
// Nearest-by-RGB-distance picks 130 for this colour, which is a burnt orange:
// the metric is not perceptual and the eye disagrees with it, so 124 is chosen
// by looking rather than by arithmetic.
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || "");
export const red = (s) => (TTY ? `\x1b[${TRUECOLOR ? "38;2;181;48;42" : "38;5;124"}m${s}\x1b[0m` : s);
export const dim = (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s);
export const bold = (s) => (TTY ? `\x1b[1m${s}\x1b[0m` : s);
export const ok = (s) => (TTY ? `\x1b[38;5;71m${s}\x1b[0m` : s);
export const bad = (s) => (TTY ? `\x1b[38;5;196m${s}\x1b[0m` : s);

// The torii gate over three bands of wave, drawn in ones and zeroes: a
// directory of machines, marked with the only two symbols any of them has.
//
// Sixty-six columns and thirty-four rows, which is the whole thing rather than
// a version of it that fits somewhere convenient. A first attempt squeezed it
// to forty-four columns and one wave band so the TUI could redraw it every
// frame, and the result was not a smaller gate but a different and much worse
// picture. If it will not fit, it is not drawn at all.
//
// Symmetry is structural rather than checked afterwards: every row is laid out
// from the centre and its left half mirrored onto its right. Note that for an
// even width the mirror axis falls BETWEEN two columns, so a crest centred on
// c pairs with one centred on W-c; centring on the middle column instead puts
// each crest half a cell off the axis and the mirror clips one side of it.
export const TORII = [
  "0000000000011                                        1100000000000",
  "100000000000000000000000000000000000000000000000000000000000000001",
  "100000000000000000000000000000000000000000000000000000000000000001",
  "          1100000000000000000000000000000000000000000011",
  "          1000000000000000000000000000000000000000000001",
  "          1000000000000000000000000000000000000000000001",
  "                100001                      100001",
  "                000000                      000000",
  "                000000                      000000",
  "                000000                      000000",
  "                100001                      100001",
  "                000000                      000000",
  "                000000                      000000",
  "                000000                      000000",
  "                100001                      100001",
  "                000000                      000000",
  "                000000                      000000",
  "                000000                      000000",
  "                100001                      100001",
  "                000000                      000000",
  "                000000                      000000",
  "",
  "        10000001      10000001      10000001      10000001",
  "      100000000001  100000000001  100000000001  100000000001",
  "00000000001  100000000001  100000000001  100000000001  10000000000",
  "  100001        100001        100001        100001        100001",
  "        10000001      10000001      10000001      10000001",
  "      100000000001  100000000001  100000000001  100000000001",
  "00000000001  100000000001  100000000001  100000000001  10000000000",
  "  100001        100001        100001        100001        100001",
  "        11111111      11111111      11111111      11111111",
  "      111111111111  111111111111  111111111111  111111111111",
  "11111111111  111111111111  111111111111  111111111111  11111111111",
  "  111111        111111        111111        111111        111111",
];

/**
 * @param {number} [width]
 * @param {string|null} [commit] the build this tree is, from data/version.json.
 *   Passed in rather than read here: this module states that it does no I/O,
 *   which is what lets the suite exercise every helper without a filesystem.
 *   An operator who has to say what they installed should not have to guess, and
 *   after an install the answer is otherwise only in the admin console.
 */
export function banner(width = (process.stdout.columns || 80), commit = null) {
  const build = commit ? ` \u00b7 ${commit}` : "";
  const art = TORII[0].length;
  // Nothing is gained by drawing two thirds of a gate: below the full width it
  // wraps into rubble, so the name alone is the better answer. The build still
  // goes in, because it is the line most worth having in a bug report.
  if (!process.stdout.isTTY || width < art + 2) {
    return bold("THE DOJO BAY \u2014 installer") + dim(build) + "\n";
  }
  return TORII.map((l) => red(l)).join("\n")
    + "\n\n" + bold("  THE DOJO BAY")
    + dim(`  \u00b7  onion-only Dojo directory \u00b7 guided install${build}\n`);
}
