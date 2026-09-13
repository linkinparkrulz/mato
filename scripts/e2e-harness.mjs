// Front-end harness. Loads assets/js/app.js inside JSDom with a stubbed fetch
// and asserts rendering and interaction behaviour: card titles and ordering,
// the payment-code chip, build-hash persistence across re-renders, the
// hamburger, Manage-panel ordering and the inline editor (versionless: the
// Dojo version is read live from the node by the updater and is not editable),
// the pairing popup, the footer operator avatar and the source-download link.
//
// One-time setup:  mkdir -p /tmp/e2e && cd /tmp/e2e && npm init -y && npm install jsdom
// Run (repo root): node scripts/e2e-harness.mjs
// jsdom is resolved from /tmp/e2e (override with E2E_DIR); it is deliberately
// not in any package.json so the front end and scripts/ stay dependency-free.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import assert from "node:assert";

const E2E_DIR = process.env.E2E_DIR || "/tmp/e2e";
let JSDOM;
try {
  ({ JSDOM } = createRequire(path.join(E2E_DIR, "/"))("jsdom"));
} catch {
  console.error(`jsdom not found under ${E2E_DIR}. One-time setup:\n  mkdir -p ${E2E_DIR} && cd ${E2E_DIR} && npm init -y && npm install jsdom\nthen re-run from the repo root: node scripts/e2e-harness.mjs`);
  process.exit(1);
}

const REPO = process.env.REPO_DIR || process.cwd();

// Every check announces itself through here, and the total at the end is that
// count rather than a number written by hand. The literal had already fallen a
// check behind the file, which is a small thing that quietly makes the suite
// lie about its own size, and the size is the only summary anybody reads.
let PASSED = 0;
const ok = (line) => { PASSED++; console.log("  ok - " + line); };
const appJs = readFileSync(REPO + "/assets/js/app.js", "utf8");

const DOJOS = {
  // Fresh by construction: a fixed date would drift into "stale" over time and
  // silently put every other check in this file into the stale state.
  generated_at: new Date().toISOString(),
  interval_minutes: 10,
  nodes: [
    { id: "mainnet-91xtx93-yellow", network: "mainnet", name: "yellow", paynym: "+91xTx93x3",
      paymentCode: "PM8TJfHaHuh5xgKoEbrkWaBtytb8qrRNYdmHzxiFcvacD6HpyyxvSV3VLKYsr6UvMxB4jvJP4xxNvCp2pRY3cJPNmLB2L8nYEttaFVszXSBjXNMy8cD9",
      status: "active", block_height: 906000, checked_at: "2026-07-14 00:00",
      indexer_url: "tcp://" + "i".repeat(56) + ".onion:50001",
      operator_domain: "example.org",
      operator_domain_proof: { domain: "example.org", paymentCode: "PM8TJfHaHuh5xgKoEbrkWaBtytb8qrRNYdmHzxiFcvacD6HpyyxvSV3VLKYsr6UvMxB4jvJP4xxNvCp2pRY3cJPNmLB2L8nYEttaFVszXSBjXNMy8cD9",
        txt_name: "_dojobay.example.org", txt_value: "dojobay-domain-v1 pm=PM8TJfHaHuh5xgKoEbrkWaBtytb8qrRNYdmHzxiFcvacD6HpyyxvSV3VLKYsr6UvMxB4jvJP4xxNvCp2pRY3cJPNmLB2L8nYEttaFVszXSBjXNMy8cD9",
        signed: "-----BEGIN BITCOIN SIGNED MESSAGE-----\nhttps://example.org/\n\nBIP47: PM8TJfHa\n-----BEGIN BITCOIN SIGNATURE-----\nAddress: 1HmVAPcz3hyETMnu4UzgJTw1mmrNcJKVB\n\n" + "H".repeat(87) + "=\n-----END BITCOIN SIGNATURE-----",
        verified_at: "2026-07-01T00:00:00Z" },
      payload: { pairing: { type: "dojo.api", version: "1.28.0", apikey: "fixturekey",
        url: "http://" + "a".repeat(56) + ".onion/v2" } } },
    // The payload carries an indexer in both shapes, the way a pre-106
    // dojos.json did, and there is no indexer_url. The card must ignore it.
    { id: "mainnet-freshnode", network: "mainnet", name: "freshnode", paynym: "+fresh",
      status: "active", block_height: 906000, checked_at: "2026-07-14 00:00",
      payload: { pairing: { type: "dojo.api", version: "1.28.0", url: "http://" + "d".repeat(56) + ".onion/v2" },
        indexer: { type: "indexer", url: "ssl://" + "d".repeat(56) + ".onion:50002" },
        services: [{ type: "indexer", url: "ssl://" + "d".repeat(56) + ".onion:50002" }] } },
    { id: "mainnet-deadnode", network: "mainnet", name: "deadnode", paynym: "+dead",
      status: "inactive", block_height: null, checked_at: "2026-07-14 00:00",
      // has an apikey but no Electrum endpoint: the popup must skip that section
      payload: { pairing: { type: "dojo.api", version: "1.20.0", apikey: "deadkey",
        url: "http://" + "e".repeat(56) + ".onion/v2" } } },
    { id: "mainnet-kilombino", network: "mainnet", name: "Kilombino", paynym: null,
      status: "active", block_height: 906000, checked_at: "2026-07-14 00:00",
      payload: { pairing: { type: "dojo.api", version: "1.27.0", url: "http://" + "b".repeat(56) + ".onion/v2" },
                 explorer: { type: "explorer.btc_rpc_explorer", url: "" } } },
  ],
};
const up = (n) => Array.from({length:n},()=>({t:"2026-07-14 00:00",up:true}));
const down = (n) => Array.from({length:n},()=>({t:"2026-07-14 00:00",up:false}));
const HIST = { interval_minutes: 10, window_checks: 144, nodes: {
  "mainnet-91xtx93-yellow": { checks: up(12) },                       // 24h 100%
  "mainnet-kilombino": { checks: up(9).concat(down(3)) },             // 24h 75%
  "mainnet-deadnode": { checks: down(12) },                           // 24h 0%
} };
const VERSION = { commit: "abc1234", built: "2026-07-14" };
// deliberately shuffled: testnet first, names reversed
const ME = { authenticated: true, paymentCode: "PM8TJTESTCODE000000000000", admin: true, submissions: [
  { id: "testnet-blue", network: "testnet", name: "blue", status: "approved", payload: { pairing: { url: "http://x.onion/v2" } } },
  { id: "mainnet-yellow2", network: "mainnet", name: "yellow", status: "approved", payload: { pairing: { url: "http://y.onion/v2" } } },
  { id: "mainnet-91xtx93-red", network: "mainnet", name: "red", status: "approved", payload: { pairing: { url: "http://z.onion/v2" } } },
] };

let meCalls = 0;
let dojosCalls = 0;
const PCODE_FULL = "PM8TJfHaHuh5xgKoEbrkWaBtytb8qrRNYdmHzxiFcvacD6HpyyxvSV3VLKYsr6UvMxB4jvJP4xxNvCp2pRY3cJPNmLB2L8nYEttaFVszXSBjXNMy8cD9";
const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="root"></div></body></html>`, {
  url: "http://dojobay.onion/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t) => { window.__copied = t; } } });
window.__editPosts = [];
window.confirm = () => true;
window.prompt = () => "";
window.__reloaded = false;
try { window.location.reload = () => { window.__reloaded = true; }; } catch (e) {}
window.qrcode = (t, ec) => { window.__lastEC = ec; return { addData(){}, make(){}, getModuleCount(){ return 21; }, isDark(){ return false; } }; };
window.markdown = { render: (t) => t };
window.__updateStatusSeq = [];
const OPERATOR_SIGNED = [
  "-----BEGIN BITCOIN SIGNED MESSAGE-----",
  "http://dojobayeryasshgghz537de5ckgd5hhi4z5sdeil3roeh65fwhdnu2yd.onion/",
  "",
  "BIP47:",
  "PM8TJfHaHuh5xgKoEbrkWaBtytb8qrRNYdmHzxiFcvacD6HpyyxvSV3VLKYsr6UvMxB4jvJP4xxNvCp2pRY3cJPNmLB2L8nYEttaFVszXSBjXNMy8cD9",
  "-----BEGIN BITCOIN SIGNATURE-----",
  "Version: Bitcoin-qt (1.0)",
  "Address: 1K9Mdqs9hmZKxeMUDRLk4RZT5AJMfNtGpa",
  "IN/fS2xr5k7px/ncdIWMHil3KnqpWEcigvKa7W20rpWzO3aco8uIOFRAYYhtB+1ZyI3DtPI34fc7ZPN0ZX2Nn5U=",
  "-----END BITCOIN SIGNATURE-----",
].join("\n");

window.fetch = async (url, opts) => {
  if (opts && opts.method === "POST" && /\/api\/admin\/update$/.test(url)) {
    window.__updateStarted = JSON.parse(opts.body || "{}");
    return { ok: true, status: 202, headers: { get: () => null }, json: async () => ({ started: true, id: "x" }), text: async () => '{"started":true,"id":"x"}' };
  }
  if (/\/api\/admin\/update\/status/.test(url)) {
    const next = window.__updateStatusSeq.shift() || { job: { phase: "restarting", done: true, ok: true, needsRefresh: true } };
    return { ok: true, status: next._status || 200, headers: { get: () => null }, json: async () => next, text: async () => JSON.stringify(next) };
  }
  if (opts && opts.method === "POST" && /\/api\/dojo\/edit/.test(url)) {
    window.__editPosts.push(JSON.parse(opts.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }), text: async () => '{"ok":true}' };
  }
  const body =
    /dojos\.json/.test(url) ? (dojosCalls++, DOJOS) :
    /history\.json/.test(url) ? HIST :
    /history-daily\.json/.test(url) ? { nodes: {
      "mainnet-91xtx93-yellow": { days: [{d:"2026-07-12",pct:100,close:905900},{d:"2026-07-13",pct:99.3,close:906000}] },
      // A flat 90% with one day at 60: the exact case that exposed the old
      // mismatch, where 60 was counted as an up day but painted amber.
      "mainnet-kilombino": { days: Array.from({length:7},(_,i)=>({d:"2026-07-0"+(7+i),pct:i===0?60:90,close:905000+i})) },
      "mainnet-deadnode": { days: Array.from({length:7},(_,i)=>({d:"2026-07-0"+(7+i),pct:0,close:null})) },
    } } :
    /version\.json/.test(url) ? VERSION :
    // A realistic signed block, not a placeholder: the Verify popup renders it
    // as a QR, and a three-word payload produces a symbol nothing can be
    // concluded from. No paynym field either, which is deliberate — that is
    // what every instance installed before the field existed looks like.
    /operator\.json/.test(url) ? { onion: "http://x.onion/", paymentCode: "PM8TJfHaHuh5xgKoEbrkWaBtytb8qrRNYdmHzxiFcvacD6HpyyxvSV3VLKYsr6UvMxB4jvJP4xxNvCp2pRY3cJPNmLB2L8nYEttaFVszXSBjXNMy8cD9", verifySigned: OPERATOR_SIGNED } :
    /\/api\/admin\/updates/.test(url) ? { available: true, commit: "abc1234", built: "2026-01-01", commits_behind: 3, status: "behind", latest_release: "v0.1", releases_behind: 1 } :
    /\/api\/me/.test(url) ? (meCalls++, ME) :
    /\/api\/domain$/.test(url) ? { claim: { domain: "example.org", verified: true, verified_at: "2026-07-01T00:00:00Z", last_check: "2026-07-20T00:00:00Z", last_result: "ok", failing_since: null, grace_days: 7 } } :
    null;
  if (body === null) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
};
window.eval(appJs);
await new Promise((r) => setTimeout(r, 80));   // let the async boot + detectBackend settle

const doc = window.document;
const titles = [...doc.querySelectorAll(".cname")].map((e) => e.textContent.trim());
assert.ok(titles.includes("yellow") && !titles.some((t) => t.includes("·")), "card titled by name alone, got: " + JSON.stringify(titles));
ok("migrated card titled 'yellow' (name alone, no composite)");
assert.ok(titles.includes("Kilombino"), "seed card shows name alone");
ok("curated seed card titled 'Kilombino'");

const hash = () => [...doc.querySelectorAll("footer .ver a")].map((a) => a.textContent).join("");
assert.strictEqual(hash(), "build abc1234", "build hash rendered on first paint");
ok("build hash rendered from VERSION state");

// re-render via the network toggle, twice, and again via banner dismiss
doc.querySelector('[data-net="testnet"]').dispatchEvent(new window.Event("click", { bubbles: true }));
doc.querySelector('[data-net="mainnet"]').dispatchEvent(new window.Event("click", { bubbles: true }));
assert.strictEqual(hash(), "build abc1234", "build hash survives re-renders");
ok("build hash survives re-renders (network toggle x2)");

// manage panel ordering with a shuffled /api/me
doc.body.insertAdjacentHTML("beforeend",
  '<div class="ov" id="ov"><div class="modal"><h2 id="ov-title"></h2><div id="ov-body"></div></div></div>');
doc.getElementById("root").insertAdjacentHTML("beforeend", '<button data-act="manage" id="mg">m</button>');
doc.getElementById("mg").dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
const rows = [...doc.querySelectorAll("#ov-body .box b")].map((e) => e.textContent);
assert.deepStrictEqual(rows, ["red", "yellow", "blue"], "manage rows ordered, got: " + JSON.stringify(rows));
ok("Manage rows ordered mainnet-then-testnet, then by name (red, yellow, blue)");

// the form carries the required node-name field
assert.ok(doc.getElementById("m-name"), "node name input present in the form");
ok("submission form has the node-name field");


// 90-day strip lives on the card, under the 24h strip, hydrated after render,
// with a day-count reliability stat ("pct% · up/total days", up = day pct>=50)
const yellowCard = doc.querySelector('.card[data-id="mainnet-91xtx93-yellow"]');
const rel = yellowCard.querySelector(".rel"), h90 = yellowCard.querySelector(".hist90");
assert.ok(rel && h90 && (rel.compareDocumentPosition(h90) & 4), "hist90 rendered on the card after the 24h strip");
assert.ok(h90.querySelectorAll(".d90").length === 2, "hist90 hydrated with daily bars, got " + h90.querySelectorAll(".d90").length);
assert.ok(/100% · 2\/2 days/.test(h90.querySelector(".d90foot").textContent), "hist90 stat line, got: " + h90.querySelector(".d90foot").textContent);
const deadFoot = doc.querySelector('.card[data-id="mainnet-deadnode"] .hist90 .d90foot');
assert.ok(deadFoot && /0% · 0\/7 days/.test(deadFoot.textContent), "dead node reads 0% · 0/7 days, got: " + (deadFoot && deadFoot.textContent));
ok("90-day strip on the card, hydrated, with pct \u00b7 up/total day stat");

// The strip and the footer sit in one widget and used to disagree in it: a day
// at 60% was counted as up in the footer (threshold 50) while the square beside
// it was painted amber (green at 99). They now share one definition of a good
// day, so the footer is a count of the green squares above it. kilombino runs
// at a flat 90% and is the case that exposed the old mismatch.
{
  const kFoot = doc.querySelector('.card[data-id="mainnet-kilombino"] .hist90 .d90foot');
  const kBars = [...doc.querySelectorAll('.card[data-id="mainnet-kilombino"] .hist90 .d90')];
  assert.ok(kFoot && /0% · 0\/7 days/.test(kFoot.textContent),
    "a node at a flat 90% counts no day as up, got: " + (kFoot && kFoot.textContent.trim()));
  assert.ok(kBars.length === 7 && kBars.every((b) => b.classList.contains("mid")),
    "and every day from 60% to 90% reads amber, not red: a wobble is distinguishable "
    + "from an outage, got: " + JSON.stringify(kBars.map((b) => b.className)));
  assert.ok(/at least 95% of their checks/.test(kFoot.querySelector("span").getAttribute("title") || ""),
    "the footer states the threshold rather than saying 'up', so amber is not misread as a pass");

  // the shared boundary itself: the days the footer counts are exactly the
  // green ones. yellow sits at 100 and 99.3, both above it.
  const yBars = [...h90.querySelectorAll(".d90")];
  assert.equal(yBars.filter((b) => b.classList.contains("up")).length, 2,
    "both of yellow's days are green");
  assert.ok(/100% · 2\/2 days/.test(h90.querySelector(".d90foot").textContent),
    "and the footer counts exactly those two");

  // and the red band still means what it says
  const dBars = [...doc.querySelectorAll('.card[data-id="mainnet-deadnode"] .hist90 .d90')];
  assert.ok(dBars.length === 7 && dBars.every((b) => b.classList.contains("down")),
    "a node at 0% is red across the strip");
  ok("strip and footer share one definition of a good day");
}

// hamburger: state-driven toggle
assert.ok(doc.querySelector(".burger"), "burger button rendered");
assert.ok(!doc.querySelector("nav").classList.contains("open"), "menu starts closed");
doc.querySelector(".burger").dispatchEvent(new window.Event("click", { bubbles: true }));
assert.ok(doc.querySelector("nav").classList.contains("open"), "menu opens");
assert.strictEqual(hash(), "build abc1234", "build hash survives the menu re-render");
doc.querySelector('nav [data-modal="about"]').dispatchEvent(new window.Event("click", { bubbles: true }));
assert.ok(!doc.querySelector("nav").classList.contains("open"), "menu closes when an item opens a modal");
ok("hamburger toggles the nav, closes on item click, hash survives");

// openManage refreshes the session and links an admin to the console
const before = meCalls;
doc.getElementById("root").insertAdjacentHTML("beforeend", '<button data-act="manage" id="mg2">m</button>');
doc.getElementById("mg2").dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
assert.ok(meCalls > before, "openManage re-reads /api/me (session shared with /admin)");
assert.ok(/open the admin console/.test(doc.getElementById("ov-body").innerHTML), "admin sees a console link in Manage");
ok("Manage refreshes the shared session and cross-links the admin console");


// card ordering: 7-day desc, 24h desc; null-history above long-dead
const order = [...doc.querySelectorAll(".card")].map((c) => c.getAttribute("data-id"));
assert.deepStrictEqual(order,
  ["mainnet-91xtx93-yellow", "mainnet-kilombino", "mainnet-freshnode", "mainnet-deadnode"],
  "uptime ordering, got: " + JSON.stringify(order));
ok("cards ordered by 7d then 24h uptime; fresh above dead, both at the end");

// payment code chip: truncated display, click copies the full code
const chip = doc.querySelector('.card[data-id="mainnet-91xtx93-yellow"] .pcode');
assert.ok(chip, "payment code chip rendered");
assert.strictEqual(chip.textContent, "PM8TJfHa…XNMy8cD9", "chip truncation, got: " + chip.textContent);
const relEl = doc.querySelector('.card[data-id="mainnet-91xtx93-yellow"] .rel');
assert.ok(chip.compareDocumentPosition(relEl) & 4, "chip sits above the reliability strip");
chip.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 20));
assert.ok(window.__copied && window.__copied.endsWith("XNMy8cD9") && window.__copied.length > 100, "click copies the full code");
ok("payment code chip: PM8TJfHa…XNMy8cD9 shown, full code copied on click");

// edit flow: one row at a time, save posts the fields. The Dojo version is NOT
// part of the form: it is read live from the node's X-Dojo-Version header by
// the updater, so the editor offers name/hardware/link only, shows a read-only
// note, and the POST must never carry a version key.
const editBtns = () => [...doc.querySelectorAll('#ov-body [data-mact="edit"]')];
editBtns()[0].dispatchEvent(new window.Event("click", { bubbles: true }));
assert.ok(doc.querySelector("#ov-body .medit"), "editor opens");
assert.ok(editBtns().filter((b) => b.disabled).length === 2, "other rows' Edit buttons disabled while one is open");
assert.ok(!doc.querySelector("#ov-body .medit .e-ver"), "no version input in the editor");
assert.ok(/read live from the node/i.test(doc.querySelector("#ov-body .medit").textContent), "editor notes the version is read from the node");
doc.querySelector("#ov-body .medit .e-name").value = "crimson";
doc.querySelector("#ov-body .medit .e-hw").value = "N100 32GB";
doc.querySelector('#ov-body [data-mact="editsave"]').dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
assert.strictEqual(window.__editPosts.length, 1, "one edit POST sent");
assert.deepStrictEqual(
  { name: window.__editPosts[0].name, hardware: window.__editPosts[0].hardware },
  { name: "crimson", hardware: "N100 32GB" }, "edit POST carries the fields");
assert.ok(!("version" in window.__editPosts[0]), "edit POST never carries a version key");
assert.ok(!("name_url" in window.__editPosts[0]),
  "nor a card link: the editor has no field for one and the gate would ignore it");
assert.ok(!doc.querySelector("#ov-body .medit .e-url"), "and the editor offers no link input");
assert.ok(!doc.querySelector("#ov-body .medit"), "editor closes after save");
ok("inline edit: single-open, versionless form, fields posted, editor closes on save");


// endpoints live on the card, below the meta block (Last checked)
const yCard = doc.querySelector('.card[data-id="mainnet-91xtx93-yellow"]');
const eps = yCard.querySelector(".card-eps");
assert.ok(eps && /Dojo API/.test(eps.textContent) && eps.textContent.includes("a".repeat(56)), "Dojo API endpoint on the card");
const metaEl = yCard.querySelector(".meta");
assert.ok(metaEl.compareDocumentPosition(eps) & 4, "endpoints sit below the meta (Last checked) block");
assert.ok(!yCard.querySelector(".pair"), "no inline pairing section on the card");

// Electrum row: always present, below the other endpoints. A probed endpoint is
// shown with a copy button carrying the exact TCP string; a node that publishes
// none reads N/A with nothing to copy.
const epRows = [...eps.querySelectorAll(".ep")].map((e) => e.querySelector(".k").textContent.trim());
assert.strictEqual(epRows[epRows.length - 1], "Electrum Server", "Electrum is the last endpoint row: " + epRows.join(", "));
const elRow = [...eps.querySelectorAll(".ep")].find((e) => /Electrum/.test(e.textContent));
const elBtn = elRow.querySelector('[data-act="copyurl"]');
assert.strictEqual(elRow.querySelector(".u").textContent.trim(), "tcp://" + "i".repeat(56) + ".onion:50001", "Electrum TCP string rendered");
assert.strictEqual(elBtn.getAttribute("data-v"), "tcp://" + "i".repeat(56) + ".onion:50001", "copy button carries the full TCP string");
elBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 20));
assert.strictEqual(window.__copied, "tcp://" + "i".repeat(56) + ".onion:50001", "clicking copy puts the TCP string on the clipboard");

// A payload carrying an indexer is not a source for this row. Nothing publishes
// one any more, but an older dojos.json can still be in a visitor's cache, and
// an endpoint nobody probed must not be shown as though it had been.
const declaredOnly = [...doc.querySelectorAll('.card[data-id="mainnet-freshnode"] .ep')].find((e) => /Electrum/.test(e.textContent));
assert.ok(declaredOnly, "the node whose payload declares an indexer rendered a card");
assert.strictEqual(declaredOnly.querySelector(".u").textContent.trim(), "N/A",
  "an indexer declared in the payload is ignored: the row reads N/A");

const kRow = [...doc.querySelectorAll('.card[data-id="mainnet-kilombino"] .ep')].find((e) => /Electrum/.test(e.textContent));
assert.ok(kRow, "a node with no endpoint still shows an Electrum row");
assert.strictEqual(kRow.querySelector(".u").textContent.trim(), "N/A", "absent endpoint reads N/A");
const kBtn = kRow.querySelector(".copybtn");
assert.ok(kBtn && kBtn.disabled && !kBtn.getAttribute("data-act"),
  "N/A row keeps a copy button for alignment, disabled and inert");
window.__copied = null;
kBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 20));
assert.strictEqual(window.__copied, null, "clicking the disabled button copies nothing");
assert.strictEqual(kRow.querySelectorAll(".u, .copybtn").length, elRow.querySelectorAll(".u, .copybtn").length,
  "N/A row has the same columns as a populated endpoint row");
// Every endpoint row behaves the same when it has nothing to show: an explorer
// present in the payload but carrying an unusable url must read N/A with the
// copy button greyed out, exactly like an absent Electrum endpoint.
const kEps = [...doc.querySelectorAll('.card[data-id="mainnet-kilombino"] .ep')];
assert.deepStrictEqual(kEps.map((e) => e.querySelector(".k").textContent.trim()),
  ["Dojo API", "Explorer", "Electrum Server"], "all three endpoint rows always render");
for (const label of ["Explorer", "Electrum Server"]) {
  const row = kEps.find((e) => e.querySelector(".k").textContent.trim() === label);
  const btn = row.querySelector(".copybtn");
  assert.strictEqual(row.querySelector(".u").textContent.trim(), "N/A", `${label} with no usable URL reads N/A`);
  assert.ok(row.querySelector(".u").classList.contains("na"), `${label} N/A is styled as absent`);
  assert.ok(btn && btn.disabled && !btn.getAttribute("data-act"), `${label} N/A copy button is greyed out and inert`);
}
// the card exposes the payment code so the pairing avatar can be warmed on hover
assert.ok(/^PM8TJ/.test(yCard.getAttribute("data-pc") || ""), "card carries its payment code for avatar prefetch");
assert.ok(!/loading="lazy"/.test(doc.documentElement.innerHTML), "the QR avatar is not lazily loaded");
ok("Dojo API/Explorer/Electrum endpoints on the card; N/A rows uniformly greyed out");

// verified operator domain: a badge on the operator's card, linking to the
// domain, and absent (not a placeholder) for an operator without one
const vd = yCard.querySelector(".vdomain");
assert.ok(vd, "verified domain badge renders when the node carries operator_domain");
assert.strictEqual(vd.getAttribute("href"), "https://example.org", "badge links to the verified domain");
assert.ok(/example\.org/.test(vd.textContent) && /✓/.test(vd.textContent), "badge shows a tick and the domain");
assert.ok(/control of the domain, not that the operator is trustworthy/i.test(vd.getAttribute("title") || ""),
  "badge wording is about control, not trustworthiness");
assert.ok(vd.getAttribute("rel") === "noopener noreferrer" && vd.getAttribute("target") === "_blank",
  "badge link does not leak a referrer");
assert.ok(!doc.querySelector('.card[data-id="mainnet-kilombino"] .vdomain'),
  "a node with no verified domain shows no badge at all");
// Layout: the payment code owns its own row, with the domain and its verify
// button on the line beneath rather than trailing the code inline.
const pcodeEl = yCard.querySelector(".pcode");
const vrow = yCard.querySelector(".vrow");
assert.ok(pcodeEl && vrow, "the card has a payment code and a separate verification row");
assert.ok(pcodeEl.compareDocumentPosition(vrow) & 4, "the verification row comes after the payment code");
assert.ok(vrow.querySelector(".vdomain") && vrow.querySelector(".vproof"),
  "the domain and the verify button share that row");
assert.ok(!pcodeEl.parentElement.classList.contains("vrow"),
  "the payment code is not inside the verification row");
// The chip carries the FULL code, so the display can be re-fitted to the card
// width at runtime (and so copying yields the whole thing, not the elision).
assert.strictEqual(pcodeEl.getAttribute("data-v"), PCODE_FULL,
  "the chip carries the full payment code for measuring and copying");
// The visible text is re-fitted to the card width at runtime, which JSDom
// cannot exercise (no layout, no canvas), so assert the default the markup
// ships: an elision keeping the head and tail, which is what identifies a code
// by eye. Read it from the title, since clicking the chip earlier in this file
// leaves "Copied ✓" in the button text.
assert.strictEqual(pcodeEl.getAttribute("title"), PCODE_FULL + " — click to copy",
  "the chip's tooltip carries the whole code");
assert.ok(!doc.querySelector('.card[data-id="mainnet-kilombino"] .vrow'),
  "a node with nothing to verify gets no verification row at all");
ok("verified domain badge on the card, absent when unverified");

// "For the machines among us": the badge must be interrogable, not just a tick.
{
  const btn = yCard.querySelector('[data-act="domproof"]');
  assert.ok(btn, "a badge with a published proof offers a verify affordance");
  assert.ok(!doc.querySelector('.card[data-id="mainnet-kilombino"] [data-act="domproof"]'),
    "a node with no proof offers none");
  btn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const body = doc.getElementById("ov-body").textContent;
  assert.ok(/dig \+short TXT _dojobay\.example\.org/.test(body), "it shows the dig command");
  assert.ok(/cloudflare-dns\.com\/dns-query/.test(body), "and an HTTPS equivalent for readers without dig");
  assert.ok(/dojobay-domain-v1 pm=PM8TJfHa/.test(body), "and the exact TXT value to expect");
  assert.ok(/1HmVAPcz3hyETMnu4UzgJTw1mmrNcJKVB/.test(body), "and the signing address");
  assert.ok(/BEGIN BITCOIN SIGNED MESSAGE/.test(body), "and the signed block itself");
  assert.ok(/paymentcode\.io\/lab/.test(doc.getElementById("ov-body").innerHTML),
    "and points at a verifier the reader can use");
  assert.ok(/control of a domain, not that the operator is trustworthy/i.test(body.replace(/\s+/g, " ")),
    "and says what the proof does not mean");
  doc.querySelector('[data-act="closemodal"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  ok("the domain badge publishes a checkable proof, not just a tick");
}

// "Check it yourself": the Electrum endpoint and the version are the only things
// on a card that rest on our word, so the card must show how to ask the node.
{
  const btn = yCard.querySelector('[data-act="checkself"]');
  assert.ok(btn, "a node with an API key offers a check-it-yourself action");
  btn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const body = doc.getElementById("ov-body").textContent;
  // Port-agnostic: which one is the default is a judgement that lives in one
  // place, and the picker's own checks below cover both values.
  assert.ok(/socks5-hostname 127\.0\.0\.1:(9050|9150)/.test(body), "the commands route over Tor");
  assert.ok(/9150/.test(body), "and mention Tor Browser's port too");
  assert.ok(/auth\/login/.test(body) && /support\/services/.test(body),
    "it shows both requests: the login and the services lookup");
  assert.ok(/X-Dojo-Version/.test(body), "it explains where the version comes from");
  assert.ok(/tcp:\/\//.test(body), "and states the Electrum endpoint we display, to compare against");
  assert.ok(/latest-block/.test(body) && /906000/.test(body),
    "it also covers the block height, which is likewise our checker's reading");
  assert.ok(/jq/.test(body), "it offers a one-liner and a jq-free variant");
  assert.ok(/own Tor circuit/.test(body.replace(/\s+/g, " ")),
    "and states the caveat rather than glossing over it");
  doc.querySelector('[data-act="closemodal"]').dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.ok(!doc.querySelector('.card[data-id="mainnet-kilombino"] [data-act="checkself"]'),
    "a node with no API key cannot be queried, so it offers no such action");

  // A node with no Electrum endpoint must not be given instructions for asking
  // about one: there is nothing to compare, and the popup says so instead.
  const noIdx = doc.querySelector('.card[data-id="mainnet-deadnode"] [data-act="checkself"]');
  if (noIdx) {
    noIdx.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    const t = doc.getElementById("ov-body").textContent.replace(/\s+/g, " ");
    assert.ok(!/support\/services/.test(t), "no Electrum instructions when the card shows N/A");
    assert.ok(/publishes no Electrum endpoint/.test(t), "and it says why instead");
    assert.ok(/latest-block/.test(t), "the block-height check still applies");
    doc.querySelector('[data-act="closemodal"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  }
  ok("a card shows how to ask the node directly for what we assert");
}

// "Rescan XPUB": commands only. The page must never offer somewhere to type an
// XPUB, and must say so, because a directory that asked for one would be
// teaching the habit that makes phishing clones profitable.
{
  const btn = yCard.querySelector('[data-act="rescan"]');
  assert.ok(btn, "a node with an API key offers the rescan instructions");
  btn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const body = doc.getElementById("ov-body");
  const text = body.textContent.replace(/\s+/g, " ");

  assert.ok(body.querySelectorAll("input, textarea").length === 0,
    "the popup offers no field to type an XPUB into");
  assert.ok(/Never paste an XPUB into a web page, including this one/i.test(text),
    "and says so in terms a reader cannot miss");
  assert.ok(/type=restore/.test(text) && /\/xpub\//.test(text), "it shows the restore call");
  assert.ok(/bip84/.test(text) && /bip44/.test(text), "and explains which scheme to pick");
  assert.ok(/import\/status/.test(text), "and how to watch it finish");
  assert.ok(/<YOUR_XPUB>/.test(text), "the XPUB stays a placeholder the reader fills in themselves");
  assert.ok(/wallet normally does this for you/i.test(text),
    "it steers an ordinary user back to their wallet first");
  assert.ok(/real work for their machine/i.test(text), "and notes the cost to the operator");
  doc.querySelector('[data-act="closemodal"]').dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.ok(!doc.querySelector('.card[data-id="mainnet-kilombino"] [data-act="rescan"]'),
    "a node with no API key offers no such action");
  ok("rescan instructions are commands only, with no field for an XPUB");
}

// Staleness: if the updater timer dies, nginx keeps serving the last dojos.json
// and every badge stays confidently green. Past a few intervals the site must
// stop asserting status. Booted separately so everything above runs against a
// healthy directory.
{
  const staleDom = new JSDOM(`<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
    { url: "http://dojobay.onion/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = staleDom.window;
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async () => {} } });
  const old = { ...DOJOS, generated_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() };
  w.fetch = async (url) => {
    const body = /dojos\.json/.test(url) ? old
      : /history-daily\.json/.test(url) ? { nodes: {} }
      : /history\.json/.test(url) ? { interval_minutes: 10, window_checks: 144, nodes: {} }
      : /version\.json/.test(url) ? VERSION
      : null;
    if (body === null) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  w.eval(appJs);
  await new Promise((r) => setTimeout(r, 80));
  const d = w.document;
  const banner = d.querySelector(".stale-banner");
  assert.ok(banner, "a directory that has not refreshed for hours shows a staleness banner");
  assert.ok(/out of date/i.test(banner.textContent), "the banner says the statuses are out of date");
  assert.ok(/5 hours/.test(banner.textContent), "it says how long ago: " + banner.textContent.trim().slice(0, 80));
  assert.ok(/unknown rather than up or down/i.test(banner.textContent.replace(/\s+/g, " ")),
    "it tells the reader to treat nodes as unknown, not down");
  assert.ok(d.querySelector(".grid").classList.contains("stale"),
    "the grid is marked stale, which greys the status dots and badges");
  assert.ok(d.querySelectorAll(".card").length > 0, "cards are still listed, just not asserted up or down");
  assert.ok(!doc.querySelector(".stale-banner") && !doc.querySelector(".grid").classList.contains("stale"),
    "a freshly generated directory shows no banner and no greying");
  ok("stale data greys the badges and says so; fresh data does not");
  staleDom.window.close();          // the app schedules a refresh timer; closing
                                    // the window clears it so the run can exit
}

// The dialog must not scroll behind its own header. This regressed twice: first
// treated as a stacking problem (a z-index on the header), which was the wrong
// cause. The real one was structural — the overlay was the scroll container with
// 6vh of padding while the header was position:sticky inside it, so content
// scrolled up into that padding band and sat above the pinned header. JSDom does
// no layout, so this pins the intent in the stylesheet instead.
{
  const css = readFileSync(REPO + "/assets/css/styles.css", "utf8");
  const rule = (sel) => (css.match(new RegExp("\\n\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}")) || ["", ""])[1];
  const ov = rule(".ov"), modal = rule(".modal"), head = rule(".modal-head"), body = rule(".modal-body");
  assert.ok(/overflow:hidden/.test(ov) && !/overflow-y:auto/.test(ov),
    "the overlay is not the scroll container: " + ov.slice(0, 80));
  assert.ok(/display:flex/.test(modal) && /flex-direction:column/.test(modal) && /max-height/.test(modal),
    "the modal is a bounded flex column: " + modal.slice(0, 80));
  assert.ok(!/position:sticky/.test(head),
    "the header is structurally at the top, not sticky over scrolling content");
  assert.ok(/overflow-y:auto/.test(body) && /min-height:0/.test(body),
    "only the modal body scrolls, and it can shrink inside the flex column");
  ok("dialog scrolls its body, so content never passes behind the header");

  // Every var(--x) must resolve to a declared property. An undeclared custom
  // property is silent: it takes the fallback, renders plausibly and errors
  // nowhere, so --warn spent its whole life resolving to its own fallback and
  // .admin-row to a colour nobody had chosen deliberately. Both were only found
  // by looking. This check is what stops the third one hiding as long.
  const declared = new Set([...css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]));
  const sources = ["/assets/css/styles.css", "/assets/js/app.js", "/index.html"]
    .map((f) => { try { return readFileSync(REPO + f, "utf8"); } catch { return ""; } }).join("\n");
  const undeclared = [...new Set([...sources.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)]
    .map((m) => m[1]).filter((n) => !declared.has(n)))];
  assert.deepEqual(undeclared, [],
    "every custom property referenced must be declared in :root, undeclared: " + JSON.stringify(undeclared));
  ok("no var() reference falls through to a fallback for want of a declaration");
}


// pairing details open in the shared popup: EC-H QR + avatar + copy buttons
yCard.querySelector('[data-act="pair"]').dispatchEvent(new window.Event("click", { bubbles: true }));
const ovBody = doc.getElementById("ov-body");
assert.strictEqual(doc.getElementById("ov-title").textContent, "yellow · pairing", "popup titled by node name");
assert.strictEqual(window.__lastEC, "H", "pairing QR generated at EC level H, got " + window.__lastEC);
const av = ovBody.querySelector(".tile .qr-avatar");
assert.ok(av && /data\/avatars\/PM8TJfHa/.test(av.getAttribute("src")), "avatar overlay in the popup from the local mirror");
assert.ok(ovBody.querySelector('[data-act="copypairing"][data-id="mainnet-91xtx93-yellow"]'), "popup copy button carries the node id");
doc.querySelector('.card[data-id="mainnet-kilombino"] [data-act="pair"]').dispatchEvent(new window.Event("click", { bubbles: true }));
assert.ok(!ovBody.querySelector(".qr-avatar"), "no overlay without a payment code");
ok("pairing details in a Verify-style popup (EC-H QR, avatar, id-carrying copy)");


// footer: circular operator avatar beside Verify; Disclaimer gone from the nav
const opAv = doc.querySelector("footer .op-avatar");
assert.ok(opAv && /data\/avatars\/PM8TJfHa/.test(opAv.getAttribute("src")), "operator avatar in the footer from the local mirror");
const verifyBtn = doc.querySelector("footer .verify-link");
assert.ok(opAv.compareDocumentPosition(verifyBtn) & 4, "avatar sits beside (before) the Verify button");
assert.ok(!doc.querySelector('[data-modal="disclaimer"]'), "Disclaimer removed from the nav");
ok("footer operator avatar beside Verify; Disclaimer menu item gone");


// footer: the instance serves its own source as a zip
const srcLink = doc.querySelector('footer a[download="dojobay-src.zip"]');
assert.ok(srcLink && srcLink.getAttribute("href") === "data/dojobay-src.zip", "source zip download link in the footer");
ok("footer source-download icon links the instance's own code zip");



// A tab left open must not drift into the staleness banner on a healthy
// directory: the banner reads generated_at, which is when the INSTANCE last
// published, so the page has to refetch on the same cadence or it accuses a
// working checker of having stopped. Returning to a hidden tab refetches at
// once rather than waiting out the interval.
{
  const before = dojosCalls;
  Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });
  window.document.dispatchEvent(new window.Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(dojosCalls > before, "returning to the tab refetches dojos.json");

  // a refresh must never redraw underneath an open dialog
  doc.querySelector('.card[data-id="mainnet-91xtx93-yellow"] [data-act="pair"]')
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(doc.getElementById("ov").classList.contains("show"), "a dialog is open");
  const title = doc.getElementById("ov-title").textContent;
  window.document.dispatchEvent(new window.Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(doc.getElementById("ov").classList.contains("show")
    && doc.getElementById("ov-title").textContent === title,
    "a refresh arriving while it is open leaves it alone");
  doc.querySelector('[data-act="closemodal"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(doc.querySelectorAll(".card").length > 0, "and the deferred redraw lands once it is closed");
  ok("an open tab refetches, and never redraws under an open dialog");
}

// A directory with no listings. This needs its own JSDOM rather than a mutation
// of the shared one: every check above runs against a single mounted page, and
// emptying its data mid-run would leave the page in a state no reader ever
// sees. The repository now ships an empty data/dojos.json scaffold, so the
// fresh-install path below is not hypothetical, it is what a new operator gets
// for the minute between installing and the first rebuild.
{
  const mountWith = async (dojos) => {
    const d = new JSDOM(`<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      { url: "http://dojobay.onion/", runScripts: "outside-only", pretendToBeVisual: true });
    const w = d.window;
    w.confirm = () => true; w.prompt = () => "";
    w.qrcode = () => ({ addData(){}, make(){}, getModuleCount(){ return 21; }, isDark(){ return false; } });
    w.markdown = { render: (t) => t };
    w.fetch = async (url) => {
      const body =
        /dojos\.json/.test(url) ? dojos :
        /history\.json/.test(url) ? { nodes: {} } :
        /history-daily\.json/.test(url) ? { nodes: {} } :
        /version\.json/.test(url) ? VERSION :
        /\/api\/me/.test(url) ? { authenticated: false } : null;
      if (body === null) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
    };
    w.eval(appJs);
    await new Promise((r) => setTimeout(r, 80));
    return d;
  };

  // 1. a freshly installed instance: the shipped scaffold, never rebuilt.
  const fresh = await mountWith({ generated_at: null, interval_minutes: 10, nodes: [] });
  const fd = fresh.window.document;
  assert.equal(fd.querySelectorAll(".card").length, 0, "no cards are drawn for an empty list");
  const emptyBox = fd.querySelector(".empty");
  assert.ok(emptyBox, "an empty directory shows an empty state rather than a blank page");
  assert.ok(/not completed its first refresh/i.test(emptyBox.textContent),
    "a never-rebuilt instance says so, rather than implying nobody is listed: " + JSON.stringify(emptyBox.textContent.trim().slice(0, 80)));
  assert.ok(emptyBox.querySelector('[data-act="manage"]'),
    "and offers the route to listing a Dojo, which is the only useful action from here");
  ok("a fresh install shows 'not yet refreshed', not an empty grid");

  // The staleness banner must not also fire here. generated_at is null, so
  // freshness() reports unknown, and two competing explanations for the same
  // blank page would be worse than either alone.
  assert.ok(!fd.querySelector(".grid"), "no grid element is emitted at all when there is nothing to put in it");
  fresh.window.close();

  // 2. an established instance whose selected network is empty. Different
  //    message: the data is current, the other network has listings.
  const oneSided = await mountWith({
    generated_at: new Date().toISOString(), interval_minutes: 10,
    nodes: [{ id: "testnet-only", network: "testnet", name: "only", status: "active",
      paymentCode: "PM8TJfHaHuh5xgKoEbrkWaBtytb8qrRNYdmHzxiFcvacD6HpyyxvSV3VLKYsr6UvMxB4jvJP4xxNvCp2pRY3cJPNmLB2L8nYEttaFVszXSBjXNMy8cD9",
      payload: { pairing: { type: "dojo.api", version: "1.28.0", apikey: "k", url: "http://" + "b".repeat(56) + ".onion/v2" } } }],
  });
  const od = oneSided.window.document;
  const box2 = od.querySelector(".empty");
  assert.ok(box2 && /No mainnet Dojos/i.test(box2.textContent),
    "an empty network says which network is empty: " + JSON.stringify(box2 && box2.textContent.trim().slice(0, 80)));
  assert.ok(/testnet/i.test(box2.textContent),
    "and points at the network that does have listings rather than leaving the reader stuck");
  oneSided.window.close();
  ok("an empty network points at the one that is not");
}

// The operator console's header on a narrow screen. The mobile rule pulled
// .brand out of flow so it could be centred against the hamburger, which left
// the admin header with no in-flow child at all: it collapsed to its padding
// and the title printed over the page beneath it, clipped, with the one nav
// link unreachable because the nav turns into a dropdown that nothing opens.
{
  const css = readFileSync(REPO + "/assets/css/styles.css", "utf8");
  const mobile = css.slice(css.indexOf("@media (max-width:560px)"));
  const block = mobile.slice(0, mobile.indexOf("@media (prefers-reduced-motion"));

  assert.ok(!/(^|[^)])\s\.brand\{position:absolute/.test(block),
    "the absolute centring must be conditional, not applied to every header");
  assert.ok(/header:not\(\.no-menu\) \.brand\{position:absolute/.test(block),
    "it applies only where a hamburger is in flow to hold the header open");
  assert.ok(/header\.no-menu nav\{display:flex/.test(block),
    "and a header without a menu keeps its nav visible rather than hiding it "
    + "behind a control that does not exist");

  // the admin shell must actually carry the class, or the rules above are dead
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  assert.ok(/<header class="no-menu">/.test(app),
    "the operator console header opts out of the hamburger layout");
  assert.equal((app.match(/<header/g) || []).length, 2,
    "if a third header appears it needs a deliberate decision about which layout it takes");
  ok("the operator console header survives a narrow screen");
}

// The Auth47 challenge is copyable. A QR is useless when the wallet is on the
// same device as the browser, which on a phone is the usual case, so the URI
// underneath is the real affordance and hand-selecting it is miserable.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  const fn = app.slice(app.indexOf("async function startAuth47"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));
  assert.ok(/data-act="copyurl"/.test(body) && /data-v="\$\{esc\(uri\)\}"/.test(body),
    "the challenge carries a copy button wired to the same handler as every other copy");
  assert.ok(/copy challenge/.test(body), "and says what it copies");
  // the handler it names must exist, or the button is decoration
  assert.ok(/if\(a==="copyurl"\)\{copy\(act\.getAttribute\("data-v"\)\)/.test(app),
    "and copyurl is a real document-level handler, which the admin page shares");
  ok("the Auth47 challenge can be copied, not just photographed");
}

// The Verify popup identifies the operator the same way every listing does.
// Two separate things: the avatar, keyed on the payment code that operator.json
// always carries, and the PayNym name, which it may not.
{
  doc.querySelector('[data-act="verify"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const body = doc.getElementById("ov-body");
  assert.equal(doc.getElementById("ov-title").textContent, "Verify this directory");

  const tile = body.querySelector(".tile");
  assert.ok(tile, "the QR sits in a .tile, which is what gives the overlay something to position against");
  const img = tile.querySelector("img.qr-avatar");
  assert.ok(img, "the operator's PayNym avatar overlays the QR, as on a listing");
  assert.ok(/data\/avatars\/PM8TJfHaHuh5/.test(img.getAttribute("src")),
    "keyed on the operator's own payment code: " + img.getAttribute("src"));

  // Error correction H, not the default M: an overlay eats into the recovery
  // budget and M allows 15% where H allows 30%. The stubbed QR library records
  // the level it was asked for, so this is the real call rather than a reading
  // of the source.
  assert.ok(tile.querySelector("svg"), "a QR is rendered");
  assert.equal(window.__lastEC, "H",
    "the Verify QR asks for error correction H, since it now carries an overlay");

  const link = body.querySelector("a.pn");
  assert.ok(link, "the operator's PayNym is linked");
  assert.ok(/paynym25chftmsywv4v2r67agbrr62lcxagsf4tymbzpeeucucy2ivad\.onion/.test(link.getAttribute("href")),
    "to the PayNym directory's onion, not a clearnet mirror: " + link.getAttribute("href"));
  assert.equal(link.getAttribute("target"), "_blank");
  assert.ok(/noopener/.test(link.getAttribute("rel") || ""), "and opened without handing over window.opener");
  // this fixture's operator.json has NO paynym field, so the name can only have
  // come from the operator's own published listing. That is the path every
  // instance installed before the field existed will take.
  assert.equal(link.textContent, "+91xTx93x3",
    "recovered from the operator's own listing when operator.json predates the field");

  doc.querySelector('[data-act="closemodal"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  ok("Verify shows who signed: avatar on the QR, PayNym linked to its directory");
}

// The markdown renderer, exercised as though its input were hostile. It is not
// today: content/about.md and content/faq.md are shipped in the repository and
// nothing else calls render. These checks exist so that the day something else
// does, the boundary is already there rather than discovered afterwards.
{
  const mdSrc = readFileSync(REPO + "/assets/js/markdown.js", "utf8");
  const g = {};
  new Function("module", "globalThis", "window", mdSrc)({}, g, undefined);
  const md = g.markdown;

  // Attribute injection. escapeHtml left the quote alone, and the link rule
  // interpolates into href="…", so a URL could close the attribute and open
  // another. Browsers accept href="x"onfocus=… with no whitespace between.
  const attr = md.render('[t](x"onfocus=alert)');
  assert.ok(/href="x&quot;onfocus=alert"/.test(attr),
    "a quote in a URL is escaped rather than closing the attribute: " + attr);
  assert.ok(!/"onfocus=/.test(attr.replace(/&quot;/g, "")) || /&quot;/.test(attr),
    "no bare quote survives into the tag");
  assert.ok(/&quot;/.test(md.render('say "this"')), "and quotes in prose are escaped too");
  assert.ok(/&#39;/.test(md.render("it's")), "as are apostrophes");

  // Scheme allowlist. Each of these used to become a live link.
  for (const u of ["javascript:alert", "JaVaScRiPt:alert", "data:text/plain,x",
                   "vbscript:x", "file:///etc/passwd", "//evil.onion"]) {
    const out = md.render(`[t](${u})`);
    assert.ok(!/<a /.test(out), `${u} must not become a link, got: ${out}`);
    assert.ok(out.includes("[t]("), "and the markdown stays visible so an author sees it did not work");
  }
  // And the spellings that only become a scheme once the browser has discarded
  // characters it ignores when resolving a URL. \u0001 is chosen deliberately:
  // it is not \s, so the link rule accepts it inside a URL, which makes it the
  // one control character that can actually reach safeUrl. A tab or newline
  // cannot, since the URL pattern stops at whitespace, and a NUL becomes
  // U+FFFD in an attribute before any scheme is resolved. Asserting on those
  // two passes whether or not the stripping exists, which is how the first
  // version of this check was written and why it proved nothing.
  const smuggled = md.render("[t](java\u0001script:alert)");
  assert.ok(!/<a /.test(smuggled),
    "a control character inside the scheme does not smuggle it past the check: " + JSON.stringify(smuggled));

  // and the forms the content actually uses still work
  for (const u of ["https://dojo-osp.org", "http://abc.onion/lab", "./about"]) {
    assert.ok(new RegExp('href="' + u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"').test(md.render(`[t](${u})`)),
      `${u} must still link`);
  }
  // rel="noopener" is not decoration: these open in a new tab.
  assert.ok(/rel="noopener"/.test(md.render("[t](https://x.org)")), "external links keep noopener");

  // the shipped content is unaffected: same links, same count
  for (const f of ["about", "faq"]) {
    const html = md.render(readFileSync(REPO + "/content/" + f + ".md", "utf8"));
    const links = (html.match(/<a href="/g) || []).length;
    const raw = (readFileSync(REPO + "/content/" + f + ".md", "utf8").match(/\]\(/g) || []).length;
    assert.equal(links, raw, `every link in content/${f}.md still renders as one: ${links} of ${raw}`);
    assert.ok(!/<script/i.test(html), "and nothing in it produces a script tag");
  }
  ok("markdown escapes attributes and refuses schemes it should not follow");
}

// The challenge and its copy button stack, at every width. Laid out as a row
// the button landed wherever the URI stopped wrapping, which put it mid-line on
// one phone and below the text on another for the same page.
{
  const css = readFileSync(REPO + "/assets/css/styles.css", "utf8");
  const block = css.slice(css.indexOf(".a47-uri{"), css.indexOf(".upd-line{"));
  assert.ok(/flex-direction:column/.test(block),
    "the challenge and its button are stacked");
  assert.ok(!/flex-wrap/.test(block),
    "and not wrapped, which is what made the position depend on where the text ran out");
  // and nothing in the mobile block quietly puts it back
  const mobile = css.slice(css.indexOf("@media (max-width:560px)"));
  assert.ok(!/\.a47-uri\{[^}]*flex-direction:row/.test(mobile),
    "no width-specific rule turns it back into a row");
  ok("the Auth47 copy button sits below the challenge at every width");
}

// The update panel offers an action that would do nothing, or it does not.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  const fn = app.slice(app.indexOf("const behindAny ="), app.indexOf("function updateProgress"));
  assert.ok(/behindAny \? '' : ' disabled'/.test(fn),
    "the GitHub button is disabled when there is nothing to fetch");
  assert.ok(/nothing to fetch/.test(fn), "and says so, rather than being inertly grey");
  assert.ok(!/data-adm="update-peer"[^>]*disabled/.test(fn),
    "the peer button stays live: pulling from a peer is a different question "
    + "from being behind GitHub, and a federated instance may want another build at the same commit");

  // A disabled attribute is a hint to a person, not a guarantee, so the handler
  // checks the state that matters rather than trusting the markup.
  const handler = app.slice(app.indexOf('if(act==="update-github")'), app.indexOf('if(act==="update-peer")'));
  assert.ok(/commits_behind>0/.test(handler) && /releases_behind/.test(handler),
    "and the click handler refuses independently of the button's state");

  // the note runs the width of the panel rather than sitting in a narrow column
  const css = readFileSync(REPO + "/assets/css/styles.css", "utf8");
  const rule = css.slice(css.indexOf(".upd-exp-note{"), css.indexOf("}", css.indexOf(".upd-exp-note{")));
  assert.ok(/width:100%/.test(rule) && !/max-width/.test(rule),
    "the experimental note is full width: " + rule);
  ok("the update panel does not offer an action that would do nothing");
}

// Checking again, for an operator who pushed while already signed in.
//
// The answer is cached for six hours, which is right for an unattended check
// over Tor. Signing in discards it, so the case left over is the one where the
// operator never signed out: they push, look at the panel, and are told about
// the state before their push with nothing to say how old that is.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  const fn = app.slice(app.indexOf("const behindAny ="), app.indexOf("function updateProgress"));

  assert.ok(/data-adm="update-recheck"/.test(fn), "the panel offers a check again control");
  assert.ok(/ADMIN_UPDATES_LOADING \? ' disabled' : ''/.test(fn)
    || /ADMIN_UPDATES_LOADING \? ' disabled'/.test(fn),
    "which is disabled while a check is already in flight, since over Tor that is seconds not instant");

  // Age is the half that makes the rest meaningful: "up to date" says the same
  // thing six hours after it stopped being true.
  assert.ok(/Checked ' \+ when/.test(fn), "and the panel says how old the answer is");
  assert.ok(/refresh_wait_s/.test(fn),
    "and passes on the wait when a forced check was answered from the cache instead");

  // The end boundary is searched from the start of the block, not from the top
  // of the file: the manage panel has its own if(act==="edit") several hundred
  // lines earlier, and slicing to that produced an empty string that passed
  // every negative assertion here.
  const recheckAt = app.indexOf('if(act==="update-recheck")');
  const handler = app.slice(recheckAt, app.indexOf('if(act==="edit")', recheckAt));
  assert.ok(handler.length > 100, "the recheck handler was located");
  assert.ok(/refresh=1/.test(handler), "the control asks the server to bypass its cache");
  assert.ok(!/ADMIN_UPDATES\s*=\s*null/.test(handler),
    "and leaves the current answer on screen while the new one is fetched, rather than blanking the panel");
  assert.ok(/if\(ADMIN_UPDATES_LOADING\) return/.test(handler),
    "a second click while one is in flight does nothing");
  ok("an operator who pushed while signed in can force a fresh check");
}

// A failed update check must not take the peer route with it.
//
// GitHub allows sixty unauthenticated requests an hour per IP, a Tor exit is
// one address shared with everyone using it, and an instance can land on an
// exit whose hour was already spent. That is a routine condition, not a fault,
// and it used to leave the panel with a status code and no controls at all,
// including the one route that never touches GitHub.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  const unavailable = app.slice(app.indexOf("if(!u.available) return"),
                                app.indexOf("const behind = u.commits_behind>0"));
  // Proves the slice found the branch without also standing in for the checks
  // below: a length threshold would fail first, and report a missing slice when
  // what actually went was the peer button.
  assert.ok(/Update check unavailable/.test(unavailable), "the unavailable branch was located");
  assert.ok(/data-adm="update-peer"/.test(unavailable),
    "a peer update is still offered when GitHub cannot be reached");
  assert.ok(/data-adm="update-recheck"/.test(unavailable),
    "and so is checking again, since a rate limit follows the exit and a new circuit may clear it");
  // The in-flight label sits immediately after the peer button, and a bare
  // "Checking…" there was read as the peer update being in progress.
  assert.ok(!/'Checking…'/.test(app) && /Checking GitHub…/.test(unavailable),
    "and the in-flight label names what it is checking, since it sits beside the peer button");
  // The idle label is an imperative. A participle reads as something already
  // under way, which is exactly what an operator reported seeing on a button
  // that was in fact idle and stuck.
  assert.ok(/'Check GitHub'/.test(unavailable) && !/'Check again'/.test(app),
    "and the idle label names the action rather than describing one in progress");

  // Every path out of the initial load must clear the loading flag. Neither did,
  // so it stayed true from the first render: the control was permanently
  // disabled and permanently described a check that had finished long before.
  const boot = app.slice(app.indexOf('if(!ADMIN_UPDATES && !ADMIN_UPDATES_LOADING)'),
                         app.indexOf('api.call("/admin/update/status")'));
  assert.ok(/ADMIN_UPDATES_LOADING = true/.test(boot), "the initial check sets the loading flag");
  assert.ok(/\.finally\(\(\)=>\{ ADMIN_UPDATES_LOADING = false/.test(boot),
    "and clears it on every path out, not only the successful one");
  assert.ok(!/data-adm="update-github"/.test(unavailable),
    "but not the GitHub update, which has nothing to fetch");

  const upd = readFileSync(REPO + "/server/updates.mjs", "utf8");
  assert.ok(/export function githubRefusal/.test(upd),
    "and the server explains a refusal rather than reporting a status code");
  assert.ok(/status === 403 \|\| status === 429/.test(upd),
    "recognising both the limit and the secondary limit");
  assert.ok(!/`compare: HTTP \$\{cmp\.status\}`/.test(upd) && !/`releases: HTTP \$\{rel\.status\}`/.test(upd),
    "at every call site, not only the one where it was first noticed");
  ok("a rate-limited exit is explained, and leaves the peer route open");
}

// Importing listings from another Dojo Bay, from the console.
//
// The premise is that the other directory is not trusted, so the interface has
// to make the plan the thing an operator reads and the write the thing they
// choose. A single button that fetched and imported would defeat every check
// underneath it, since nobody refuses a plan they were never shown.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  const fn = app.slice(app.indexOf("function importLine()"), app.indexOf("async function startImport"));

  assert.ok(/data-adm="import-plan"/.test(fn), "the panel offers an import");
  // Apply is conditional on a plan having come back with something in it, so
  // the first click can never be the one that writes.
  const applyLine = fn.slice(fn.indexOf("const apply ="), fn.indexOf("return '<div class=\"upd-run\"'"));
  assert.ok(/j\.done && j\.ok && !j\.apply/.test(applyLine),
    "and the apply control appears only after a plan has come back");
  assert.ok(/res\.planned > 0/.test(applyLine),
    "and only when there is something to import");
  assert.ok(/imp-' \+ esc\(r\.action\)/.test(fn) && /refused: /.test(fn),
    "refused rows are shown with their reason rather than reduced to a count");
  assert.ok(/already listed as /.test(fn),
    "and a node this instance already has is named as such, not offered again");
  assert.ok(/Pending review/.test(fn),
    "the panel says imports arrive pending rather than on the site");
  // The probe cycle after an import takes about a minute, which is most of the
  // wall-clock time and the least obvious part of it. A panel that said only
  // "Importing…" throughout would look stuck at the point it is working.
  assert.ok(/probing: "probing the imported nodes over Tor/.test(fn),
    "and names the phase, so the slow probe step does not read as a hang");

  const dispatch = app.slice(app.indexOf('if(act==="import-plan")'), app.indexOf('if(act==="update-peer")'));
  // Matched on the argument, not the whole call: the onion is normalised with
  // two regexes whose closing brackets defeat a naive [^)]* match.
  assert.ok(/, code, false\);/.test(dispatch), "the first action plans rather than writes");
  assert.ok(/IMPORT_LAST\.onion, IMPORT_LAST\.code, true/.test(dispatch),
    "and applying re-uses the details the plan was made from, so the plan on screen is the plan accepted");
  assert.ok(/confirm\(/.test(dispatch), "with a confirmation naming what is about to happen");

  // Declared above its first reader. A let below the code that assigns it works
  // only because the function runs after module evaluation, and that has failed
  // outright in this codebase before.
  assert.ok(app.indexOf("let IMPORT_LAST") < app.indexOf("IMPORT_LAST = { onion, code }"),
    "IMPORT_LAST is declared above the code that sets it");
  ok("an import is planned before it is applied, and refusals are shown");
}

// The banner has moved to the clearnet site, so it is not here twice.
{
  const about = readFileSync(REPO + "/content/about.md", "utf8");
  assert.ok(!/FreeSamourai/i.test(about), "the FreeSamourai heading is gone from About");
  // and its removal has not left a stray blank or a broken block quote
  assert.ok(!/\n\n\n/.test(about), "with no doubled blank line where it stood");
  assert.ok(/^> \*\*Get listed\*\*$/m.test(about), "and Get listed still opens its own block quote");
  ok("the FreeSamourai banner is gone and About still reads cleanly");
}

// Choosing the Tor port must change the commands AND what the copy buttons put
// on the clipboard. A control that updated only what you can see would be worse
// than the prose it replaced, because copying the unedited original looks like
// it worked.
{
  const card = doc.querySelector('.card[data-id="mainnet-91xtx93-yellow"]');
  card.querySelector('[data-act="rescan"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  const body = () => doc.getElementById("ov-body");

  const picker = body().querySelector(".portpick");
  assert.ok(picker, "the rescan popup offers a port picker");
  const btns = [...picker.querySelectorAll(".pbtn")].map((b) => b.getAttribute("data-v"));
  assert.deepEqual(btns, ["9050", "9150"], "two presets, standalone tor and Tor Browser");

  const cmds = () => [...body().querySelectorAll("pre.mono")].map((p) => p.textContent).join("\n");
  const clip = () => [...body().querySelectorAll("button[data-act=copyurl]")]
    .map((b) => b.getAttribute("data-v")).join("\n");

  // Re-query each time: the popup rebuilds itself on every choice, so a handle
  // taken before the click is detached by the time the next one is needed.
  const pick = async (port) => {
    const b = body().querySelector(`[data-act="torport"][data-v="${port}"]`);
    assert.ok(b, `a preset for ${port} is present after the redraw`);
    b.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
  };

  await pick(9050);
  assert.ok(/127\.0\.0\.1:9050/.test(cmds()) && !/9150/.test(cmds()),
    "picking 9050 rewrites every visible command");
  assert.ok(/127\.0\.0\.1:9050/.test(clip()) && !/9150/.test(clip()),
    "and every copy button, which is the half that matters");
  assert.ok(body().querySelector('.pbtn[data-v="9050"]').classList.contains("on"),
    "and the chosen preset is marked, not left to guesswork");

  await pick(9150);
  assert.ok(/127\.0\.0\.1:9150/.test(cmds()) && /127\.0\.0\.1:9150/.test(clip()) && !/9050/.test(clip()),
    "and it switches back the same way");

  // the choice carries to the other command popup, so it is answered once
  doc.querySelector('[data-act="closemodal"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  card.querySelector('[data-act="checkself"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(/127\.0\.0\.1:9150/.test(clip()),
    "the check-it-yourself popup honours the port already chosen");
  assert.ok(/Connection refused/.test(body().textContent),
    "and says what a wrong port looks like, since the error is precise and opaque");
  doc.querySelector('[data-act="closemodal"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  ok("the Tor port is chosen once and every command follows, clipboard included");
}

// The support banner is gone, and with it the only thing this site stored in
// the browser.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  const css = readFileSync(REPO + "/assets/css/styles.css", "utf8");
  assert.ok(!/billandkeonne|change\.org/i.test(app), "the support banner markup is gone");
  assert.ok(!/data-act="dismiss"/.test(app), "as is the control that dismissed it");
  // Calls, not mentions: a comment explaining that the site stores nothing is
  // exactly the sort of thing a bare word match trips over, as this one did.
  assert.ok(!/\b(local|session)Storage\s*(\.|\[)/.test(app),
    "and the site now keeps nothing in the browser at all, which for an onion site is worth holding to");
  assert.ok(!/^\s*\.banner\{/m.test(css), "and its styles");
  assert.ok(/\.stale-banner\{/.test(css), "while the staleness banner, a different thing, stays");
  ok("the support banner and the last of the browser storage are gone");
}

// The controls row is space-between on a wide screen, which is right there and
// wrong once it wraps: a lone item on a wrapped line goes to the start, so the
// toggle and the freshness line both sat hard left under a centred header.
{
  const css = readFileSync(REPO + "/assets/css/styles.css", "utf8");
  const wide = css.slice(0, css.indexOf("@media (max-width:560px)"));
  const mobile = css.slice(css.indexOf("@media (max-width:560px)"),
    css.indexOf("@media (prefers-reduced-motion"));

  assert.ok(/\.controls\{[^}]*justify-content:space-between/.test(wide),
    "a wide screen still puts the toggle and the status at opposite ends");
  assert.ok(/\.controls\{[^}]*justify-content:center/.test(mobile),
    "and a narrow one centres them");
  assert.ok(/\.fresh\{[^}]*justify-content:center/.test(mobile),
    ".fresh is a flex container of its own, so its wrapped second line needs centring too");
  assert.ok(/\.fresh\{[^}]*text-align:center/.test(mobile),
    "with text-align for any inline content that is not a flex item");
  // the toggle must stay a single row: wrapping mainnet and testnet onto two
  // lines would make it read as two buttons rather than one control
  assert.ok(!/\.seg\{[^}]*flex-wrap:wrap/.test(mobile + wide),
    "the network toggle itself never wraps");
  ok("the toggle and the freshness line centre on a narrow screen");
}

// One question about location, no separate code field, nothing enforced.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  assert.ok(!/m-cc/.test(app), "the separate country-code input is gone");
  assert.ok(!/Country code must be two letters/.test(app),
    "and so is the validation that went with it: nothing about a flag should "
    + "stop somebody listing their node");
  const form = app.slice(app.indexOf('id="m-jur"') - 200, app.indexOf('id="m-jur"') + 200);
  assert.ok(/optional/i.test(form) && /flag/i.test(form),
    "the one field left is optional and says what naming a country buys: " + form.slice(0, 90));
  // the card still renders a flag from the stored code, which the server infers
  assert.ok(/function flag\(cc\)/.test(app), "the card still draws a flag when there is a code");
  ok("one location field, no code to get wrong, flags where possible");
}

// An update whose restart failed leaves the new code on disk and the old
// process serving it, which is indistinguishable from an update that did
// nothing. The helper records the reason; until now the panel only read that
// while an update was in flight, so a reload threw it away.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  assert.ok(/ADMIN_LAST/.test(app), "the panel keeps the last update result");
  assert.ok(/\/admin\/update\/status.*ADMIN_LAST/s.test(app.slice(app.indexOf("ADMIN_UPDATES_LOADING = true"))),
    "and fetches it on render rather than only while polling a running update");
  const block = app.slice(app.indexOf("const stale ="), app.indexOf("const note ="));
  assert.ok(/ok === false \|\| ADMIN_LAST\.restarting === false/.test(block),
    "shown when the update failed OR when it applied but did not restart");
  assert.ok(/old code/.test(block), "and says why the page may be lying about its own state");
  assert.ok(/ADMIN_LAST\.error \|\| ADMIN_LAST\.note/.test(block),
    "quoting the reason the helper recorded rather than a generic message");

  const au = readFileSync(REPO + "/scripts/apply-update.mjs", "utf8");
  assert.ok(/String\(version\)\.slice\(0, 7\)/.test(au),
    "a self-update stamps a short commit, as the deploy does, so the footer reads the "
    + "same way however the code arrived");
  ok("an update that did not finish says so, and the build stamp matches the deploy");
}

// The restart permission is NOT claimed either way, because this instance
// cannot find out.
//
// Two versions of that claim have now been wrong on a live machine. systemctl
// restart --dry-run returns before any bus call, so it reported success without
// asking anyone. pkcheck asks the right question, but polkit refuses a
// details-bearing CheckAuthorization() from any caller that is not uid 0, and
// the rule keys on the unit and the verb, so without details it cannot match
// and the answer is a false no. The rules directory is 750 root:polkitd, so
// reading the file is closed off too.
//
// What remains is the evidence: an update that installed and did not restart,
// which lastResult records and the panel already reports. A warning that has
// been wrong in both directions is worse than no warning.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  const idx = readFileSync(REPO + "/server/index.ts", "utf8");

  assert.ok(!/canRestart/.test(app), "the panel makes no claim about the restart permission");
  // Matched as they would appear in code, not as bare words: the comment above
  // the removal names both tools while explaining why neither is used, and a
  // test that forbade the words would forbid the explanation.
  assert.ok(!/canRestart/.test(idx) && !/"pkcheck"/.test(idx),
    "and the server does not ask a question polkit will not answer from an unprivileged caller");
  assert.ok(!/"--dry-run"/.test(idx),
    "nor the systemctl dry run, which returns before any authorisation happens");

  // The reporting that IS evidence-based stays: an update whose restart did not
  // happen is exactly the symptom a missing permission produces.
  assert.ok(/The last update did not finish/.test(app),
    "an update that installed and did not restart is still reported");
  assert.ok(/restarting === false/.test(app),
    "on the evidence recorded by the update itself");
  ok("the panel reports the restart that did not happen, rather than guessing at permission");
}

// The card title is text, never a link. An operator's one claim of identity on
// a card is the verified domain, which has a TXT record behind it; a freeform
// title link was a second claim with nothing behind it but a URL bar.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  assert.ok(!/name_url/.test(app), "nothing in the front end reads or sends a card link");
  assert.ok(!/e-url|m-url/.test(app), "and neither form offers a field for one");
  assert.ok(/<span class="cname"/.test(app) && !/<a class="cname"/.test(app),
    "the card title is a span, so it cannot carry a link at all");

  // every card in the fixture renders, and none of their titles is an anchor
  const titles = [...doc.querySelectorAll(".cname")];
  assert.ok(titles.length > 0, "cards still have titles");
  assert.ok(titles.every((t) => t.tagName === "SPAN"),
    "and every one of them is plain text: " + titles.map((t) => t.tagName).join(","));
  // the verified-domain link is untouched, since it is the claim that survives
  assert.ok(/class="vdomain"/.test(app) && /data-act="domproof"/.test(app),
    "the verified domain link and its verify button are untouched: that is the claim "
    + "with a TXT record behind it, and the one a card should carry");
  ok("a card title is text, and the verified domain is the only claim on it");
}

// A cycle that reached nothing says so on the page, because the statuses shown
// are then older than the timestamp beside them suggests.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  assert.ok(/DOJOS\.probe_fault/.test(app), "the page reads the fault the updater publishes");
  // The message wraps across several source lines, so slice to the end of the
  // banner rather than to the next template expression.
  const block = app.slice(app.indexOf("DOJOS.probe_fault?"),
    app.indexOf("FRESH.stale?", app.indexOf("DOJOS.probe_fault?")));
  assert.ok(/fault here rather/.test(block),
    "and says the cause is probably local, since every node failing at once is not about them");
  assert.ok(/last check that/.test(block),
    "and that the statuses below are older than they look");
  // Compared against the staleness BANNER rather than the first mention of
  // FRESH.stale, which appears earlier for an unrelated reason and made this
  // assertion meaningless when it was written that way.
  assert.ok(app.indexOf("DOJOS.probe_fault?") < app.indexOf('FRESH.stale?`<div class="stale-banner"'),
    "shown above the staleness banner: a fault now is more urgent than data ageing");
  ok("an instance that could reach nothing says so rather than blaming the nodes");
}

// A 502 during the seconds a self-update restarts the service is expected, not
// exceptional: the page itself asked for that restart. It is retried briefly
// rather than reported as a bare number.
{
  const app = readFileSync(REPO + "/assets/js/app.js", "utf8");
  const helper = app.slice(app.indexOf("const GATEWAY_DOWN"), app.indexOf("let ME = null;"));
  assert.ok(/new Set\(\[502, 503, 504\]\)/.test(helper),
    "only the proxy's own failures are retried");
  assert.ok(!/40[139]|409/.test(helper),
    "a refusal from the backend is an answer and must never be repeated, least of all a POST");
  assert.ok(/i<tries-1/.test(helper) && /setTimeout\(z,1000\)/.test(helper),
    "a second between attempts, and the last attempt reports rather than sleeping");
  assert.ok(/catch\(e\)\{/.test(helper) && /gatewayDown:true/.test(helper),
    "a connection dropped mid-restart is treated the same as a 502, since it means the same thing");

  // The capability probe must not retry: a directory is static files and has to
  // render at once on an instance with no backend at all.
  assert.ok(/api\.call\("\/me", "GET", undefined, \{tries:1\}\)/.test(app),
    "detectBackend asks once, so a visitor never waits on a backend that is not there");
  assert.ok(/auth47\/poll[^\n]*tries:1/.test(app),
    "and the Auth47 poll asks once, being on a timer of its own already");

  // and the message a moderator sees says what to do
  assert.ok(/backend is not answering/.test(app) && /it is restarting/.test(app),
    "a gateway failure is explained rather than shown as a status code");
  ok("a restart mid-update is waited out rather than reported as a number");
}

console.log(`\nall ${PASSED} front-end checks passed`);

// The page schedules a periodic refresh, so its timers would otherwise hold the
// event loop open and the run would never finish.
dom.window.close();
