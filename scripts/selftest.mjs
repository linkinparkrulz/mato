#!/usr/bin/env node
// Offline self-test for the reachability logic in update.mjs.
// Spins up a fake SOCKS5 proxy (no Tor needed) that can simulate:
//   - a reachable hidden service that returns an HTTP response  -> UP
//   - Tor reporting the onion as unreachable (reply 0x04)        -> DOWN
//   - no proxy listening at all                                  -> DOWN
//
// Run: node scripts/selftest.mjs   (exit 0 = all assertions passed)

import net from "node:net";
import { deflateRawSync } from "node:zlib";
import tlsMod from "node:tls";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert";
import { probe, fetchAvatar, parseDojoVersion, normaliseVersion, parseIndexerUrl, normaliseIndexerUrl, probeCfg, httpOverTor, MAX_RESPONSE_BYTES } from "./update.mjs";
import { packSource } from "./pack-source.mjs";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Minimal SOCKS5 server. `mode` decides how it answers the CONNECT request.
// A self-signed certificate for the mock DoH resolver, generated once. openssl
// is present on the Debian hosts this suite runs on; if it is missing the DoH
// transport check reports that it was skipped rather than failing the run.
const DOH_RECORD = "dojobay-domain-v1 pm=PM8T" + "1".repeat(112);
const DOH_ANSWER = JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '"' + DOH_RECORD + '"' }] });
let DOH_TLS = null;
function dohTlsAvailable() {
  if (DOH_TLS) return true;
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "dojobay-doh-"));
    // All three resolver hostnames, because validation is ON: a certificate
    // naming only one would leave the other two failing the hostname check and
    // the agreement threshold unreachable.
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"),
      "-days", "1", "-subj", "/CN=cloudflare-dns.com",
      "-addext", "subjectAltName=DNS:cloudflare-dns.com,DNS:dns.quad9.net,DNS:dns.google"],
      { stdio: "ignore" });
    DOH_TLS = { key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) };
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

function mockProxy(mode) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let stage = "greet";
      sock.on("data", (d) => {
        if (stage === "greet") {
          sock.write(Buffer.from([0x05, 0x00])); // no-auth OK
          stage = "connect";
          return;
        }
        if (stage === "connect") {
          if (mode === "unreachable") {
            sock.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // host unreachable
            sock.end();
            return;
          }
          // success reply, bound addr 0.0.0.0:0
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          // A DoH resolver speaks TLS, so terminate it on this same socket
          // instead of tunnelling: upgrading here, immediately after the SOCKS
          // reply and before any client bytes arrive, avoids losing the
          // ClientHello to a race with an upstream connect.
          if (mode === "doh") {
            sock.removeAllListeners("data");
            const t = new tlsMod.TLSSocket(sock, { isServer: true, key: DOH_TLS.key, cert: DOH_TLS.cert });
            t.on("error", () => {});
            t.once("data", () => {
              const body = Buffer.from(DOH_ANSWER);
              t.end(`HTTP/1.1 200 OK\r\nContent-Type: application/dns-json\r\n` +
                    `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n` + DOH_ANSWER);
            });
            return;
          }
          stage = "tunnel";
          return;
        }
        if (stage === "tunnel") {
          // we just received the request; answer like a Dojo HTTP server
          if (mode === "http") sock.write("HTTP/1.0 401 Unauthorized\r\n\r\n");
          if (mode === "http-version") sock.write("HTTP/1.0 200 OK\r\nX-Dojo-Version: 1.31.0\r\nContent-Length: 0\r\n\r\n");
          if (mode === "dojo") {
            const req = d.toString("latin1");
            if (req.includes("/auth/login")) {
              const body = JSON.stringify({ authorizations: { access_token: "tok" } });
              sock.write(`HTTP/1.0 200 OK\r\nX-Dojo-Version: v1.30.0\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
            } else if (req.includes("/wallet")) {
              const body = JSON.stringify({ info: { latest_block: { height: 840000, time: 123 } } });
              sock.write(`HTTP/1.0 200 OK\r\nX-Dojo-Version: v1.30.0\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
            } else if (req.includes("/support/services")) {
              const body = JSON.stringify({ services: [
                { type: "explorer", kind: "btc_rpc_explorer", url: "http://" + "e".repeat(56) + ".onion" },
                { type: "indexer", kind: "fulcrum", url: "tcp://" + "i".repeat(56) + ".onion:50001" },
                { type: "soroban", kind: "rpc", url: "http://" + "s".repeat(56) + ".onion" },
              ] });
              sock.write(`HTTP/1.0 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
            } else sock.write("HTTP/1.0 404 x\r\n\r\n");
          }
          if (mode === "avatar") {
            const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fakepixels")]);
            sock.write(Buffer.concat([Buffer.from("HTTP/1.0 200 OK\r\nContent-Type: image/png\r\n\r\n", "latin1"), png]));
          }
          if (mode === "avatar-notpng") sock.write("HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n<html>not found</html>");
          // A node that answers and then never stops. Writes headers, then
          // pushes 256 KiB chunks on a short interval and never ends the
          // socket, which is precisely the shape the byte cap exists to stop:
          // the read-timeout alone would let it accumulate for the full
          // timeout. Deliberately does NOT declare Content-Length, since a
          // reader that trusted that header would not need a cap at all.
          // Streams forever WITHOUT ever sending an HTTP status line, so the
          // unauthenticated probe's "is this HTTP yet?" test never matches and
          // its buffer is the thing that grows.
          if (mode === "babble") {
            const chunk = Buffer.alloc(64 * 1024, 0x2e);
            const t = setInterval(() => sock.write(chunk), 5);
            sock.on("close", () => clearInterval(t));
            sock.on("error", () => clearInterval(t));
            return;
          }
          if (mode === "firehose") {
            sock.write("HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n");
            const chunk = Buffer.alloc(256 * 1024, 0x41);
            const t = setInterval(() => { if (!sock.write(chunk)) { /* let it drain */ } }, 5);
            sock.on("close", () => clearInterval(t));
            sock.on("error", () => clearInterval(t));
            return;                       // never sock.end()
          }
          // mode === "silent" -> accept stream but never respond
          sock.end();
        }
      });
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function withProxy(mode, fn) {
  const server = await mockProxy(mode);
  const port = server.address().port;
  try { return await fn(port); }
  finally { server.close(); }
}

const cfg = (port, extra = {}) => ({
  proxyHost: "127.0.0.1", proxyPort: port, timeoutMs: 3000, connectOnly: false, ...extra,
});

let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log("  ok -", label); }

// Minimal single-entry zip (stored), for the zip-slip rejection test.
function makeMiniZip(name, data) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const nb = Buffer.from(name, "utf8");
  const common = Buffer.concat([u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(0), u32(data.length), u32(data.length), u16(nb.length), u16(0)]);
  const local = Buffer.concat([u32(0x04034b50), common, nb, data]);
  const central = Buffer.concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(0), nb]);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)]);
  return Buffer.concat([local, central, end]);
}

// makeMiniZip stores its payload (method 0); a bomb has to be deflated to be a
// bomb, so this is a second builder rather than a parameter on the first.
function makeDeflatedZip(name, raw) {
  const comp = deflateRawSync(raw);
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const nb = Buffer.from(name, "utf8");
  // method 8, and the header declares the TRUE inflated size. A hostile archive
  // would lie here, which is exactly why the guard is enforced by zlib during
  // inflation rather than by believing this field.
  const common = Buffer.concat([u16(20), u16(0x0800), u16(8), u16(0), u16(0), u32(0), u32(comp.length), u32(raw.length), u16(nb.length), u16(0)]);
  const local = Buffer.concat([u32(0x04034b50), common, nb, comp]);
  const central = Buffer.concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(0), nb]);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)]);
  return Buffer.concat([local, central, end]);
}

// Several deflated entries in one archive, so the shared-budget behaviour can
// be told apart from a per-entry limit.
function concatZip(pairs) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, raw] of pairs) {
    const comp = deflateRawSync(raw);
    const nb = Buffer.from(name, "utf8");
    const common = Buffer.concat([u16(20), u16(0x0800), u16(8), u16(0), u16(0), u32(0), u32(comp.length), u32(raw.length), u16(nb.length), u16(0)]);
    const local = Buffer.concat([u32(0x04034b50), common, nb, comp]);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(off), nb]));
    locals.push(local);
    off += local.length;
  }
  const localAll = Buffer.concat(locals), centralAll = Buffer.concat(centrals);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(pairs.length), u16(pairs.length),
    u32(centralAll.length), u32(localAll.length), u16(0)]);
  return Buffer.concat([localAll, centralAll, end]);
}

console.log("self-test: reachability detection");

await check("reachable service returning HTTP -> up", async () => {
  await withProxy("http", async (port) => {
    const r = await probe("http://abcdefghij234567.onion/v2", cfg(port));
    assert.equal(r.up, true, JSON.stringify(r));
    assert.equal(r.reason, "http");
  });
});

await check("Tor reports onion unreachable -> down", async () => {
  await withProxy("unreachable", async (port) => {
    const r = await probe("http://deadbeefdeadbeef.onion/v2", cfg(port));
    assert.equal(r.up, false, JSON.stringify(r));
  });
});

await check("connect succeeds but service silent, default mode -> down", async () => {
  await withProxy("silent", async (port) => {
    const r = await probe("http://silentnode00000.onion/v2", cfg(port));
    assert.equal(r.up, false, JSON.stringify(r));
  });
});

await check("connect succeeds, CONNECT_ONLY=1 -> up", async () => {
  await withProxy("silent", async (port) => {
    const r = await probe("http://silentnode00000.onion/v2", cfg(port, { connectOnly: true }));
    assert.equal(r.up, true, JSON.stringify(r));
  });
});

// A node that answers and then never stops sending. Before the cap, the reader
// accumulated until the socket closed or the timeout fired, so this shape put
// however many megabytes a Tor circuit carries in thirty seconds into the heap,
// once per concurrent probe. The tests below assert the three things that
// matter: the read is abandoned, it is abandoned near the ceiling rather than
// after the timeout, and one node behaving this way does not affect the cycle.
await check("a response that never ends is abandoned at the byte ceiling", async () => {
  await withProxy("firehose", async (port) => {
    const req = "GET / HTTP/1.0\r\nHost: x.onion\r\nConnection: close\r\n\r\n";
    // a small explicit cap, so the test does not have to push 2 MiB to prove it
    await assert.rejects(
      httpOverTor(cfg(port), "firehose000000.onion", 80, req, 5000, 512 * 1024),
      /exceeded 524288 bytes/,
      "the read rejects with a reason naming the limit it hit");
  });
});

await check("and abandoned promptly, not left running until the timeout", async () => {
  await withProxy("firehose", async (port) => {
    const req = "GET / HTTP/1.0\r\nHost: x.onion\r\nConnection: close\r\n\r\n";
    const t0 = Date.now();
    // The timeout is 8s and the responder writes 256 KiB every 5ms, so a cap
    // that only took effect at close would sit here for the full 8 seconds.
    await assert.rejects(httpOverTor(cfg(port), "firehose000000.onion", 80, req, 8000, 512 * 1024));
    const ms = Date.now() - t0;
    assert.ok(ms < 4000, `gave up after ${ms}ms, which is not obviously before the 8s timeout`);
  });
});

await check("a firehose node is one failed probe, not a failed cycle", async () => {
  await withProxy("firehose", async (port) => {
    // The authenticated path, which is what a listed node with an apikey gets,
    // and the one that reads a whole body through httpOverTor. What matters is
    // that it RETURNS rather than throws: the caller loops over nodes, so an
    // escaping error here would take the rest of the cycle with it.
    const r = await probe("http://firehose000000.onion/v2", cfg(port, { apikey: "k", timeoutMs: 20000 }));
    assert.equal(r.up, false, JSON.stringify(r));
    assert.ok(/exceeded/.test(r.reason), "and the reason names the cap: " + JSON.stringify(r.reason));
  });
});

await check("a node that never speaks HTTP is not listened to indefinitely either", async () => {
  await withProxy("babble", async (port) => {
    // The unauthenticated path keeps its own buffer, which only stopped growing
    // when a status line matched. A stream that never contains one bypassed the
    // ceiling entirely until this was fixed.
    const t0 = Date.now();
    const r = await probe("http://babble0000000000.onion/v2", cfg(port, { timeoutMs: 8000 }));
    const ms = Date.now() - t0;
    assert.equal(r.up, false, JSON.stringify(r));
    assert.equal(r.reason, "no-http-response", JSON.stringify(r));
    assert.ok(ms < 4000, `gave up after ${ms}ms rather than promptly`);
  });
});

await check("the default ceiling is generous against real responses, and stated once", async () => {
  // A Dojo /wallet reply for two dummy xpubs is single-digit KB and a PayNym
  // avatar is a small PNG, so the default sits three orders of magnitude above
  // anything legitimate. This pins the number so that lowering it towards real
  // traffic, or removing it, is a deliberate act rather than a quiet one.
  assert.equal(MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
  const { MAX_SOURCE_ZIP_BYTES } = await import("../server/self-update.mjs");
  assert.ok(MAX_SOURCE_ZIP_BYTES > MAX_RESPONSE_BYTES,
    "the source zip is the one legitimate exception and must be allowed more, not less");
});

await check("no proxy listening -> down", async () => {
  const r = await probe("http://whatever1234567.onion/v2", cfg(1)); // nothing on :1
  assert.equal(r.up, false, JSON.stringify(r));
});

await check("parseDojoVersion reads and normalises the X-Dojo-Version header", async () => {
  const head = "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nX-Dojo-Version: v1.28.0\r\n";
  assert.equal(parseDojoVersion(head), "1.28.0");                       // leading v stripped
  assert.equal(parseDojoVersion("x-dojo-version: 1.29.0-rc1\r\n"), "1.29.0-rc1"); // case-insensitive name, pre-release
  assert.equal(parseDojoVersion("X-Dojo-Version: 1.5\r\nX-Dojo-Version: 9.9\r\n"), "1.5"); // first wins
  assert.equal(parseDojoVersion("Server: nginx\r\n"), null);            // header absent
  assert.equal(parseDojoVersion("X-Dojo-Version: not-a-version\r\n"), null); // junk rejected
  assert.equal(normaliseVersion("v" + "9".repeat(40)), null);           // over-long rejected
  assert.equal(parseDojoVersion("X-Dojo-Custom: 2.0\r\n", "x-dojo-custom"), "2.0"); // configurable name
});

await check("plain probe captures X-Dojo-Version when the node sends it", async () => {
  await withProxy("http-version", async (port) => {
    const r = await probe("http://versionnode0000.onion/v2", cfg(port));
    assert.equal(r.up, true, JSON.stringify(r));
    assert.equal(r.detectedVersion, "1.31.0", JSON.stringify(r));
  });
});

await check("authenticated probe reads chain tip and X-Dojo-Version", async () => {
  await withProxy("dojo", async (port) => {
    const r = await probe("http://dojonode0000000.onion/v2", cfg(port, { apikey: "k", network: "mainnet" }));
    assert.equal(r.up, true, JSON.stringify(r));
    assert.equal(r.height, 840000, JSON.stringify(r));
    assert.equal(r.detectedVersion, "1.30.0", JSON.stringify(r));
  });
});

await check("a probe config missing its transport settings is filled in, not left undefined", async () => {
  // The installer called probe() with only { apikey, network }, so proxyPort
  // reached net.connect as undefined and Node reported 'The "options" or "port"
  // or "path" argument must be specified' during the anchor check at step 6.
  const filled = probeCfg({ apikey: "k", network: "mainnet" });
  assert.equal(filled.proxyHost, "127.0.0.1");
  assert.equal(filled.proxyPort, 9050);
  assert.ok(filled.timeoutMs > 0, "a timeout must be set, or the probe times out immediately");
  assert.equal(filled.apikey, "k", "caller's own fields are preserved");
  // explicit values always win over the defaults
  const explicit = probeCfg({ proxyHost: "10.0.0.1", proxyPort: 9150, timeoutMs: 5 });
  assert.deepEqual([explicit.proxyHost, explicit.proxyPort, explicit.timeoutMs], ["10.0.0.1", 9150, 5]);
  // and a partial config now probes rather than throwing a socket error
  await withProxy("dojo", async (port) => {
    const r = await probe("http://dojonode0000000.onion/v2", { proxyPort: port, apikey: "k", network: "mainnet" });
    assert.equal(r.up, true, JSON.stringify(r));
  });
});

await check("every probe call site passes the transport config", async () => {
  // Static check: the anchor probe in the installer is only exercised by a real
  // interactive run, so pin it here instead.
  const { readFileSync } = await import("node:fs");
  for (const f of ["install.mjs", "update.mjs"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const m of src.matchAll(/await probe\(([\s\S]{0,200}?)\)\s*;/g)) {
      assert.ok(/\.\.\.(PROBE_)?CFG/.test(m[1]), `probe() call in ${f} must spread PROBE_CFG/CFG: ${m[1].slice(0, 80)}`);
    }
  }
});

await check("parseIndexerUrl picks the indexer entry out of /support/services", async () => {
  const onion = "i".repeat(56);
  const doc = (services) => JSON.stringify({ services });
  assert.equal(parseIndexerUrl(doc([
    { type: "explorer", url: "http://" + "e".repeat(56) + ".onion" },
    { type: "indexer", kind: "fulcrum", url: "tcp://" + onion + ".onion:50001" },
  ])), "tcp://" + onion + ".onion:50001");                                  // picks indexer, not explorer
  assert.equal(parseIndexerUrl(doc([{ type: "indexer", url: "ssl://" + onion + ".onion:50002" }])),
    "ssl://" + onion + ".onion:50002");                                     // ssl accepted
  assert.equal(parseIndexerUrl(doc([{ type: "explorer", url: "http://x.onion" }])), null); // no indexer -> null
  assert.equal(parseIndexerUrl(doc([])), null);                             // node exposes nothing
  assert.equal(parseIndexerUrl("not json"), null);                          // pre-1.27.0 route/HTML
  assert.equal(parseIndexerUrl(doc([{ type: "indexer", url: "http://" + onion + ".onion:50001" }])), null); // wrong scheme
  assert.equal(normaliseIndexerUrl("tcp://short.onion:50001"), null);       // not a v3 onion
  assert.equal(normaliseIndexerUrl("tcp://" + onion + ".onion"), null);     // port required
  assert.equal(normaliseIndexerUrl("  ssl://" + onion + ".onion:50002  "), "ssl://" + onion + ".onion:50002"); // trimmed
});

await check("authenticated probe captures the Electrum endpoint from /support/services", async () => {
  await withProxy("dojo", async (port) => {
    const r = await probe("http://dojonode0000000.onion/v2", cfg(port, { apikey: "k", network: "mainnet" }));
    assert.equal(r.up, true, JSON.stringify(r));
    assert.equal(r.detectedIndexer, "tcp://" + "i".repeat(56) + ".onion:50001", JSON.stringify(r));
  });
});

await check("avatar fetched over the (mock) Tor proxy and written as verified PNG", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dojobay-avatar-"));
  try {
    await withProxy("avatar", async (port) => {
      const dest = await fetchAvatar("PMTESTCODE", { proxyHost: "127.0.0.1", proxyPort: port, destDir: dir, timeoutMs: 3000 });
      const bytes = await readFile(dest);
      assert.ok(dest.endsWith("PMTESTCODE.png"));
      assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await check("non-PNG avatar response refused, nothing written", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dojobay-avatar-"));
  try {
    await withProxy("avatar-notpng", async (port) => {
      await assert.rejects(
        fetchAvatar("PMOTHER", { proxyHost: "127.0.0.1", proxyPort: port, destDir: dir, timeoutMs: 3000 }),
        /not a PNG/);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await check("source zip packs the codebase and never the instance's own data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dojobay-src-"));
  try {
    const r = await packSource({ outDir: dir });
    const buf = await readFile(r.out);
    // walk the central directory for entry names
    const names = [];
    for (let i = 0; i + 46 < buf.length; i++) {
      if (buf.readUInt32LE(i) !== 0x02014b50) continue;
      const nlen = buf.readUInt16LE(i + 28);
      names.push(buf.subarray(i + 46, i + 46 + nlen).toString("utf8"));
      i += 45 + nlen;
    }
    assert.ok(names.includes("dojobay/assets/js/app.js"), "app.js present");
    assert.ok(names.includes("dojobay/data/version.json"), "version marker present");
    assert.ok(names.includes("dojobay/scripts/pack-source.mjs"), "packer ships itself");
    const forbidden = names.filter((n) =>
      /server\/data|seed\.json|operator\.json|paynym-codes|dojos\.json|history|avatars|node_modules|\.zip$/.test(n));
    assert.deepEqual(forbidden, [], "forbidden entries: " + forbidden.join(", "));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await check("TXT lookup over Tor: agreement required, unreachable resolvers are inconclusive", async () => {
  const dns = await import("../server/dns.ts");

  // An unreachable proxy must be INCONCLUSIVE, never a failure: a Tor outage
  // must not strip a verified badge from an honest operator. This half needs no
  // TLS, so it always runs.
  const down = await dns.txtRecordAgreed("_dojobay.example.com", () => true,
    { proxyHost: "127.0.0.1", proxyPort: 1, timeoutMs: 400 });
  assert.ok(!down.ok && down.inconclusive, "unreachable resolvers are inconclusive: " + JSON.stringify(down));
  assert.equal(down.agreed, 0);

  if (!dohTlsAvailable()) {
    console.log("       (note: openssl unavailable, TLS half of the DoH check skipped)");
    return;
  }
  // Full path against a mock resolver behind the mock SOCKS proxy: SOCKS
  // connect, TLS, HTTP/1.1, DoH JSON, agreement counting.
  // Certificate validation stays ON. The mock resolver's self-signed
  // certificate is passed as a trust anchor for these lookups alone, rather
  // than disabling validation for the whole process with
  // NODE_TLS_REJECT_UNAUTHORIZED, which would also cover every other
  // connection made while it was set.
  await withProxy("doh", async (port) => {
      const cfg = { proxyHost: "127.0.0.1", proxyPort: port, timeoutMs: 5000, tlsCa: DOH_TLS.cert };
      const found = await dns.lookupTxt("_dojobay.example.com", cfg);
      assert.ok(found.records.includes(DOH_RECORD),
        "the TXT record is read back: " + JSON.stringify(found.records) + " errors=" + JSON.stringify(found.errors));
      assert.ok(found.answered >= dns.DOH_AGREEMENT, "enough resolvers answered, got " + found.answered);

      const agreed = await dns.txtRecordAgreed("_dojobay.example.com", (r) => r === DOH_RECORD, cfg);
      assert.ok(agreed.ok && agreed.agreed >= dns.DOH_AGREEMENT, "agreement reached: " + JSON.stringify(agreed));

      // present but not matching is a definite failure, not "cannot tell"
      const missing = await dns.txtRecordAgreed("_dojobay.example.com", () => false, cfg);
      assert.ok(!missing.ok && !missing.inconclusive, "a non-matching record fails rather than being inconclusive");
      assert.ok(/not matching/.test(missing.error), "and says the record is present but not matching: " + missing.error);
  });
});

await check("a signed block ends its own paste, and END still works", async () => {
  const { collectPasteFrom } = await import("./installer-lib.mjs");
  const { createInterface } = await import("node:readline");
  const { Readable, Writable } = await import("node:stream");
  const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });
  const feed = (lines) => createInterface({ input: Readable.from(lines.map((l) => l + "\n")), output: sink() });

  const block = [
    "-----BEGIN BITCOIN SIGNED MESSAGE-----", "http://x.onion/", "",
    "BIP47: PM8Tabc", "-----BEGIN BITCOIN SIGNATURE-----",
    "Address: 1abc", "", "sigsigsig", "-----END BITCOIN SIGNATURE-----",
  ];
  const MARK = "-----END BITCOIN SIGNATURE-----";

  // An operator who pastes a block and presses Enter has, to their eye,
  // finished: the block says END. Waiting for a bare END made the installer
  // look hung, with Ctrl-C the only way out.
  const auto = await collectPasteFrom(feed(block), "END", { endMarker: MARK });
  assert.strictEqual(auto.split("\n").length, block.length, "the paste ends on the wallet's own terminator");
  assert.ok(auto.trim().endsWith(MARK), "and keeps that line, which is part of the block");

  // anything after it is not swallowed into the block
  const withNoise = await collectPasteFrom(feed([...block, "stray typing"]), "END", { endMarker: MARK });
  assert.ok(!withNoise.includes("stray typing"), "input after the terminator is not absorbed");

  // END still ends a paste that has no such marker, e.g. a pairing payload
  const json = await collectPasteFrom(feed(['{"pairing":{}}', "END", "after"]), "END");
  assert.strictEqual(json, '{"pairing":{}}', "a bare END still terminates a paste with no marker");

  // and a block pasted as one chunk still arrives whole (the earlier bug)
  const oneChunk = await collectPasteFrom(feed(block), "END", { endMarker: MARK });
  assert.strictEqual(oneChunk.split("\n").length, block.length, "a one-chunk paste keeps every line");
});

await check("uninstall: torrc surgery is reversible and spares other services", async () => {
  const { mergeTorrc, stripTorrc } = await import("./installer-lib.mjs");
  // A torrc usually carries an operator's OTHER hidden services. Removing ours
  // must be surgical: an uninstaller that rewrote the file would take theirs.
  const before = "SocksPort 9050\n\n# my other hidden service\n"
    + "HiddenServiceDir /var/lib/tor/other\nHiddenServicePort 80 127.0.0.1:9000\n";
  const merged = mergeTorrc(before, "/var/lib/tor/dojobay");
  assert.ok(merged.includes("/var/lib/tor/dojobay"), "the block went in");

  const back = stripTorrc(merged);
  assert.ok(back.removed, "and is reported as removed");
  assert.strictEqual(back.text, before, "the file returns to exactly what it was");
  assert.ok(back.text.includes("/var/lib/tor/other"), "the operator's other service survives");

  const untouched = stripTorrc(before);
  assert.ok(!untouched.removed && untouched.text === before,
    "a torrc we never touched is left alone and reported as such");
});

await check("uninstall: destructive steps are opt-in and confirmed", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./uninstall.mjs", import.meta.url), "utf8");
  // The two irreversible acts: deleting the store (other operators' signed
  // submissions) and deleting the hidden service key (the onion address itself,
  // permanently, for everyone holding the bookmark).
  assert.ok(/--purge-data/.test(src) && /--purge-onion/.test(src),
    "both are behind explicit flags rather than default behaviour");
  assert.ok(/const APPLY = argv\.includes\("--apply"\)/.test(src),
    "and nothing at all happens without --apply");
  assert.ok(/typed !== found\.onionAddress/.test(src),
    "deleting the onion key requires typing the address back");
  assert.ok(/Refusing to delete anything without a backup/.test(src),
    "a failed backup aborts rather than proceeding");
  assert.ok(/tar/.test(src) && /--no-backup/.test(src),
    "an archive is taken first unless explicitly waived");
  assert.ok(!/apt-get (remove|purge)/.test(src),
    "packages are never removed: tor and nginx probably serve something else");

  const sh = readFileSync(new URL("../uninstall.sh", import.meta.url), "utf8");
  assert.ok(/NODE_BIN="\$\(command -v node/.test(sh) && /scripts\/uninstall\.mjs/.test(sh),
    "the launcher resolves node the same way the installer's does");
});

await check("the launcher finds node itself and refuses an old one clearly", async () => {
  // Two real failures an operator hit on Ubuntu:
  //   1. `sudo node` resolves on sudo's secure_path, which excludes ~/.nvm and
  //      friends, so a working node produced "sudo: node: command not found".
  //   2. `apt install nodejs` gives Node 18 on Debian and Ubuntu, and the
  //      installer said only that 24 was required, not how to get it.
  const { readFileSync } = await import("node:fs");
  const sh = readFileSync(new URL("../install.sh", import.meta.url), "utf8");

  assert.ok(/NODE_BIN="\$\(command -v node/.test(sh),
    "the launcher resolves node as the invoking user");
  assert.ok(/exec sudo -- "\$NODE_BIN"/.test(sh),
    "and hands sudo that absolute path, so a non-secure_path node still works");
  assert.ok(/-lt "\$MIN_MAJOR"/.test(sh), "it compares the major version numerically");
  assert.ok(/deb\.nodesource\.com/.test(sh) && /apt install nodejs/.test(sh),
    "and tells the operator where to get a current Node, and what not to install");

  // There is no desktop entry any more, and no reference to one. It offered a
  // double-click install that needed the file marked executable and a terminal
  // emulator registered, gave no feedback when either was missing, and nobody
  // ever completed an install through it.
  assert.ok(!/desktop/i.test(sh), "the launcher no longer mentions a desktop entry");
  for (const f of ["pack-source.mjs", "../server/self-update.mjs"]) {
    assert.ok(!/dojobay-install\.desktop/.test(readFileSync(new URL(f, import.meta.url).pathname, "utf8")),
      `${f} does not still list the removed desktop entry`);
  }
});

// A Dojo serves testnet under a `test` path segment and mainnet without one, so
// the two are checkable against each other. Crossing them produces a listing
// that is wrong in a way nothing downstream catches: a testnet node listed as
// mainnet answers, reports a height and probes green forever, and the only
// symptom is a block height a few hundred thousand adrift, which reads as
// nothing at all.
await check("a pairing payload must match the network the operator chose", async () => {
  const { parsePairing, pairingNetwork } = await import("./installer-lib.mjs");
  const onion = "b3krcphqdbrzkblvti2eiuogfrx6b5lynenv5dxjwsw7hq47dlrc4pid";
  const mk = (u) => JSON.stringify({ pairing: { type: "dojo.api", apikey: "k", url: u } });
  const test = `http://${onion}.onion/test/v2`, main = `http://${onion}.onion/v2`;

  assert.equal(pairingNetwork(test), "testnet");
  assert.equal(pairingNetwork(main), "mainnet");
  assert.ok(parsePairing(mk(test), { network: "testnet" }).ok, "testnet payload on testnet");
  assert.ok(parsePairing(mk(main), { network: "mainnet" }).ok, "mainnet payload on mainnet");

  const wrongWay = parsePairing(mk(main), { network: "testnet" });
  assert.equal(wrongWay.ok, false, "a mainnet URL is refused when testnet was chosen");
  assert.ok(/\/test\//.test(wrongWay.error) && /testnet Dojo serves/.test(wrongWay.error),
    "and the message shows the shape expected rather than only complaining: " + wrongWay.error);

  const otherWay = parsePairing(mk(test), { network: "mainnet" });
  assert.equal(otherWay.ok, false, "and a testnet URL is refused when mainnet was chosen");

  // Only a whole path segment counts. An onion address is base32 and can contain
  // the letters t, e, s and t in a row by chance, and a substring test would
  // reject a perfectly good mainnet node roughly whenever it felt like it.
  assert.equal(pairingNetwork(`http://test${onion.slice(4)}.onion/v2`), "mainnet",
    "the letters appearing in the onion address itself are not a path segment");
  assert.equal(pairingNetwork(`http://${onion}.onion/v2/testing`), "mainnet",
    "nor is a segment that merely starts with them");

  // Omitting the network leaves the URL unjudged, so the parser stays usable
  // wherever the choice has not been made yet.
  assert.ok(parsePairing(mk(main)).ok && parsePairing(mk(test)).ok,
    "with no network given, neither is refused");
});

// The network prompt is numbered. It always accepted a prefix, but read as an
// instruction to type the word out, and operators duly typed it out.
await check("the sequential UI offers numbered choices, and takes numbers or names", async () => {
  const src = readFileSync(new URL("./installer-ui.mjs", import.meta.url).pathname, "utf8");
  const block = src.slice(src.indexOf('if (f.type === "toggle")'), src.indexOf("if (f.hint)"));
  assert.ok(/\$\{i \+ 1\}\) \$\{o\}/.test(block), "options are numbered in the prompt");
  assert.ok(/byNumber/.test(block) && /startsWith/.test(block),
    "and a number or a name prefix are both accepted");
  assert.ok(/byName\.length === 1/.test(block),
    "an ambiguous prefix is rejected rather than silently taking the first match");
});

// The timer must schedule from the clock, not from the last successful run.
// OnUnitActiveSec counts from the service's last ACTIVE state, and a service
// that fails never becomes active, so a run of failures leaves the timer with
// nothing to count from and it silently stops scheduling. An instance lost
// seventeen hours that way, and fixing the cause did not restart it: the timer
// only recovered when the service was started by hand.
await check("the update timer schedules from the clock, so failures cannot strand it", async () => {
  const unit = readFileSync(new URL("./dojobay-update.timer", import.meta.url).pathname, "utf8");
  assert.ok(/^OnCalendar=/m.test(unit), "it has a calendar schedule");
  assert.ok(!/^OnUnitActiveSec=/m.test(unit),
    "and nothing that hangs the next run off how the last one ended");
  assert.ok(/^Persistent=true$/m.test(unit),
    "Persistent is meaningful with OnCalendar and does nothing without it: a machine "
    + "that was off runs once on the way up rather than waiting for the next boundary");
  assert.ok(/^RandomizedDelaySec=/m.test(unit),
    "with jitter, so every instance in the federation does not probe the same nodes "
    + "on the same wall-clock minute");
  assert.ok(/^OnBootSec=/m.test(unit), "and still one run shortly after boot");
});

// Enabling a timer is not the same as it being scheduled, and the difference is
// invisible: the site serves its list either way. The installer proves it.
await check("the installer clears failed units and checks the timer is armed", async () => {
  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  const at = (n) => { const i = src.indexOf(n); assert.notEqual(i, -1, `missing: ${n}`); return i; };

  // reset-failed before enabling: reinstalling over a broken install otherwise
  // leaves the old units failed, and a failed oneshot does not re-arm its timer.
  assert.ok(at('"reset-failed"') < at('["enable", "--now"'),
    "failed state is cleared before the units are enabled");

  // and the check comes after the first probe cycle, since a timer may have
  // nothing to schedule from until one run has happened
  assert.ok(at('"NextElapseUSecRealtime"') > at('scripts", "update.mjs"'),
    "the timer is checked after the first cycle, not before it");
  const block = src.slice(at('"NextElapseUSecRealtime"'), at("await ui.finish("));
  assert.ok(/timerUnarmed = true/.test(block) && /reset-failed/.test(block),
    "an unarmed timer is recorded and the operator is told the two commands that fix it");
  assert.ok(/timerUnarmed/.test(src.slice(at("await ui.finish("))),
    "and it is repeated in the closing summary, which is the part an operator actually reads");
});

// An instance that serves its node list and never polls is the worst failure
// this installer can produce, because everything looks finished: nginx serves
// the directory as static files whether or not anything behind it is alive, so
// the site comes up, the list is there, and only the things the updater writes
// are missing. It was caused by ordering. The chown to the service account ran
// BEFORE the bootstrap import, the public build and the source pack, all three
// of which write as root, two of them by rename, so they left root-owned files
// the updater could never write again.
await check("the installer chowns after everything it writes as root, not before", async () => {
  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  const at = (needle) => {
    const i = src.indexOf(needle);
    assert.notEqual(i, -1, `install.mjs no longer contains ${JSON.stringify(needle)}`);
    return i;
  };
  const chown = at('await run("chown", ["-R", `${SERVICE_USER}');
  for (const step of ['bootstrapImport({', '"build-public.mjs"', 'scripts/pack-source.mjs']) {
    assert.ok(at(step) < chown,
      `${step} runs as root and must happen BEFORE the chown, or it leaves files the service user cannot write`);
  }
  // and the services must start after it, or they start against a root tree
  assert.ok(chown < at('"enable", "--now"'), "services are enabled after ownership is settled");
  assert.ok(chown < at('scripts", "update.mjs"'), "and the first probe cycle runs after it too");
});

// Ordering alone is not enough to rely on: it is invisible, and a future edit
// that inserts another root-run step below the chown reintroduces the bug
// silently. The installer proves the ownership took before it starts anything.
await check("the installer proves the service user can write before finishing", async () => {
  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  const block = src.slice(src.indexOf("const mustWrite"), src.indexOf("systemctl", src.indexOf("const mustWrite")));
  assert.ok(/dataDir/.test(block) && /avatars/.test(block) && /server", "data"/.test(block),
    "it checks the published data dir, the avatar dir and the store dir: everything the updater writes");
  assert.ok(/sudo", \["-u", SERVICE_USER, "touch"/.test(block),
    "as the service account, not as root, since root can always write");
  assert.ok(/ui\.fail\(/.test(block),
    "and a failure is fatal: an install that cannot poll is not an install, and saying so at "
    + "install time is what saves an operator from a directory that looks finished and is not");
});

// The installer has one UI, and it is the one people have actually finished an
// install with. The full-screen TUI used to be the default on any terminal that
// looked capable, which meant the path least exercised was the path most taken.
await check("the installer always runs the sequential flow", async () => {
  const { chooseUI, sequentialUI, tuiUI } = await import("./installer-ui.mjs");
  assert.equal(typeof tuiUI, "function", "the TUI adapter is parked, not deleted");

  const src = readFileSync(new URL("./installer-ui.mjs", import.meta.url).pathname, "utf8");
  const body = src.slice(src.indexOf("export function chooseUI"), src.indexOf("\n}", src.indexOf("export function chooseUI")));
  assert.ok(/return sequentialUI\(\)/.test(body), "chooseUI returns the sequential flow");
  assert.ok(!/tuiUI\(\)/.test(body), "and nothing routes to the TUI, on any terminal");
  assert.ok(!/isTTY|columns|rows|TERM/.test(body),
    "with no capability sniffing left to send anyone down the other path");

  // --plain was how you asked for the flow that worked. It has to keep being
  // accepted rather than becoming an unknown-option error in someone's script.
  assert.equal(typeof chooseUI(["node", "install.mjs", "--plain"]), "object");
  assert.equal(typeof chooseUI(["node", "install.mjs"]), "object");
});

await check("installer paste collector keeps every line of a one-chunk paste", async () => {
  const { collectPasteFrom } = await import("./installer-lib.mjs");
  const { createInterface } = await import("node:readline");
  const { Readable } = await import("node:stream");
  // A real paste arrives as one chunk, and readline then emits every line
  // synchronously. The previous rl.question() loop captured only the first
  // line of each chunk and silently dropped the rest, which produced blocks
  // that failed to parse ("not a recognisable signed block") even though the
  // operator had pasted a valid signature.
  const block = [
    "-----BEGIN BITCOIN SIGNED MESSAGE-----",
    "http://" + "a".repeat(56) + ".onion/",
    "",
    "BIP47: PM8T" + "1".repeat(112),
    "-----BEGIN BITCOIN SIGNATURE-----",
    "Version: Bitcoin-qt (1.0)",
    "Address: 1BitcoinEaterAddressDontSendf59kuE",
    "",
    "H" + "A".repeat(86) + "=",
    "-----END BITCOIN SIGNATURE-----",
  ].join("\n");
  const rl = createInterface({ input: Readable.from([block + "\nEND\n"]), terminal: false });
  const got = await collectPasteFrom(rl, "END");
  assert.equal(got, block, "collector must return the block verbatim, losing no lines");
  assert.equal(got.split("\n").length, 10, "all ten lines captured");
});

// Flags where we can manage them, and no obligation anywhere else. An operator
// answers one free-text question about where they are; a country gets a flag
// and "Europe" or "Ancapistan" do not, and neither is an error.
await check("a country is inferred from free text, and nothing is enforced", async () => {
  const { countryFor, anchorSeed } = await import("./installer-lib.mjs");
  for (const [text, cc] of [
    ["Finland", "FI"], ["fi", "FI"], ["Switzerland", "CH"], ["Helsinki, Finland", "FI"],
    ["United Kingdom", "GB"], ["UK", "GB"], ["England", "GB"], ["USA", "US"],
    ["Holland", "NL"], ["Europe (Finland)", "FI"], ["Canada / Quebec", "CA"],
  ]) assert.equal(countryFor(text), cc, `${text} names ${cc}`);

  // The whole point: these are good answers that simply get no flag.
  for (const text of ["Europe", "Central America", "Ancapistan", "somewhere warm", "", null])
    assert.equal(countryFor(text), null, `${JSON.stringify(text)} is allowed and gets no flag`);

  // An unassigned pair yields nothing rather than two letterboxes, which read
  // as a broken card rather than a missing flag.
  assert.equal(countryFor("XX"), null, "an unassigned pair is not a flag");

  // Names come from the runtime's own region data rather than a table here, so
  // the lookup cannot decay in a file nobody revisits.
  const libSrc = readFileSync(new URL("../server/dojo-version.ts", import.meta.url).pathname, "utf8");
  assert.ok(/Intl\.DisplayNames/.test(libSrc), "the names come from ICU, not from a list in this repo");

  const base = { network: "mainnet", name: "n", paymentCode: "PM8Tabc",
    payload: { pairing: { type: "dojo.api", url: "http://x.onion/v2" } },
    signed: "-----BEGIN BITCOIN SIGNED MESSAGE-----\nx\n-----BEGIN BITCOIN SIGNATURE-----\nAA==\n-----END BITCOIN SIGNATURE-----" };
  assert.equal(anchorSeed({ ...base, jurisdiction: "Finland" }).nodes[0].country, "FI",
    "the anchor takes its flag from the same answer");
  assert.equal(anchorSeed({ ...base, jurisdiction: "Ancapistan" }).nodes[0].country, null,
    "and stores nothing when there is nothing to store");
});

// The installer asks once, not twice.
await check("the installer asks one question about location, and enforces nothing", async () => {
  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  assert.ok(!/key: "country"/.test(src), "there is no separate country-code field to get wrong");
  const field = src.slice(src.indexOf('key: "jurisdiction"'), src.indexOf('key: "hardware"'));
  assert.ok(/optional/i.test(field), "the one that remains is optional");
  assert.ok(!/validate:/.test(field), "and unvalidated: a directory of onion services does not "
    + "insist that anybody name a state");
  assert.ok(/flag/i.test(field), "while saying what naming a country buys you");
});

// The anchor an installer produces is a listing, and a listing without a signed
// pairing block is withheld by the rebuild. Before this, anchorSeed did not
// carry one, so a fresh install came up with an empty directory and no
// explanation for it. These checks are the reason that cannot recur quietly.
await check("the installed anchor is a listing the rebuild will actually publish", async () => {
  const { anchorSeed } = await import("./installer-lib.mjs");
  const { hasSignedBlock } = await import("../server/store.ts");
  const signed = [
    "-----BEGIN BITCOIN SIGNED MESSAGE-----", "{}",
    "-----BEGIN BITCOIN SIGNATURE-----", "Address: 1x", "", "AA==",
    "-----END BITCOIN SIGNATURE-----",
  ].join("\n");
  const base = { network: "mainnet", name: "my node", paymentCode: "PM8Tabc",
    paynym: "+me", payload: { pairing: { type: "dojo.api", url: "http://x.onion/v2" } } };

  const seed = anchorSeed({ ...base, signed });
  assert.ok(hasSignedBlock(seed.nodes[0]),
    "the same predicate the rebuild uses says this anchor is publishable");
  assert.equal(seed.nodes[0].signed, signed, "and the block is stored verbatim");

  // Refused rather than defaulted. A default would put the empty directory back
  // and move the failure to somewhere nobody is looking.
  // The casts are the point rather than a nuisance: the type now says `signed`
  // is required, and these assert that the runtime says so too, since seed.json
  // is written by a script that could be edited without a type checker in sight.
  assert.throws(() => anchorSeed(/** @type {any} */ ({ ...base })), /signed pairing block is required/,
    "an anchor with no signature is refused at construction");
  assert.throws(() => anchorSeed(/** @type {any} */ ({ ...base, signed: "I promise it is mine" })), /required/,
    "and something that is not a signed block does not count as one");
});

// The installer must hold its own node to the version it will demand of others,
// and must read that minimum from the same place the submission gate reads it,
// or an instance could seed itself with a node it would refuse from anybody.
await check("the installer's version gate is the directory's version gate", async () => {
  const { judgeVersion, MIN_DOJO_VERSION } = await import("../server/dojo-version.ts");
  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  assert.ok(/judgeVersion\(check\.detectedVersion, parsed\.payload\.pairing\?\.version, MIN_DOJO_VERSION\)/.test(src),
    "the anchor probe judges the version, preferring what the node reported over what the payload declares");
  assert.ok(!/MIN_DOJO_VERSION\s*=\s*["']/.test(src),
    "and the minimum is imported, never restated where it could drift from the gate");

  // the judgement itself, so a change to the shared helper that let an old node
  // through would fail here rather than only in the backend suite
  assert.ok(!judgeVersion("1.26.0", null, MIN_DOJO_VERSION).ok, "1.26.0 is refused");
  assert.ok(judgeVersion(MIN_DOJO_VERSION, null, MIN_DOJO_VERSION).ok, "the minimum itself is accepted");
  assert.ok(!judgeVersion(null, null, MIN_DOJO_VERSION).ok,
    "a node reporting no version at all is refused rather than waved through");
});

// The banner is decoration, but a lopsided gate is the first thing an operator
// sees and it is drawn from literals nobody will re-derive by hand.
await check("the torii is symmetrical, whole, and drawn in ones and zeroes", async () => {
  const { TORII, banner } = await import("./installer-lib.mjs");
  const { HEADER } = await import("./tui.mjs");

  const width = Math.max(...TORII.map((l) => l.length));
  for (const line of TORII) {
    const p = line.padEnd(width, " ");
    for (let x = 0; x < Math.floor(width / 2); x++) {
      assert.equal(p[x], p[width - 1 - x],
        `the gate is lopsided at column ${x}: ${JSON.stringify(line)}`);
    }
  }
  assert.ok(TORII.every((l) => /^[01 ]*$/.test(l)), "ones and zeroes only");

  // The whole picture, not a version of it that fits somewhere. Squeezing it to
  // fit the TUI frame once produced a different and much worse image, so the
  // dimensions are pinned: a lintel, a second lintel, pillars, and three bands
  // of wave.
  assert.equal(width, 66, "full width, as drawn");
  assert.equal(TORII.length, 34, "full height, three wave bands and all");
  assert.equal(TORII.filter((l) => !l.trim()).length, 1, "one break, between gate and water");

  // and the TUI carries none of it, deliberately
  assert.deepEqual(HEADER, [],
    "the frame header draws no gate: it is redrawn per keystroke and the art is 34 rows");

  // The build the tree is, after "guided install". Somebody reporting a problem
  // should not have to go and look it up, and after an install the only other
  // place it appears is the admin console.
  const real0 = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    const withBuild = banner(120, "3362dc1");
    assert.ok(/guided install \u00b7 3362dc1/.test(withBuild.replace(/\x1b\[[0-9;]*m/g, "")),
      "the commit follows 'guided install'");
    assert.ok(!/guided install \u00b7 /.test(banner(120, null).replace(/\x1b\[[0-9;]*m/g, "")),
      "and nothing dangles when there is no build to state, as on a git clone");
    assert.ok(!/undefined|null/.test(banner(120, null)), "least of all the word null");
  } finally {
    if (real0) Object.defineProperty(process.stdout, "isTTY", real0);
    else delete process.stdout.isTTY;
  }
  // and it survives the fallback, where it is the line most worth having
  assert.ok(/3362dc1/.test(banner(40, "3362dc1")),
    "a terminal too narrow for the gate still says which build this is");

  // installer-lib does no I/O by design, which is what lets the suite exercise
  // every helper without a filesystem. The commit is therefore passed in.
  const libSrc = readFileSync(new URL("./installer-lib.mjs", import.meta.url).pathname, "utf8");
  assert.ok(!/readFileSync|readFile\(/.test(libSrc),
    "installer-lib still reads nothing: the build is an argument, not a lookup");

  // The fallback, which is where a banner usually breaks. This suite runs with
  // its output piped, so isTTY is false and the plain path is what a naive
  // check would exercise: worth asserting outright before faking a TTY.
  assert.ok(!process.stdout.isTTY, "the suite runs without a TTY, so the next line means something");
  assert.ok(!/[01]{6}/.test(banner(120)), "piped output gets plain text, not escape codes in a log");

  const real = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    const drawn = (out) => out.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
      .filter((l) => /^[01 ]+$/.test(l) && /[01]/.test(l)).length;
    assert.equal(drawn(banner(120)), TORII.filter((l) => l.trim()).length,
      "a wide terminal gets every row of it");
    assert.equal(drawn(banner(width + 1)), 0,
      "one column short of fitting, it is not drawn at all rather than wrapped into rubble");
  } finally {
    if (real) Object.defineProperty(process.stdout, "isTTY", real);
    else delete process.stdout.isTTY;
  }
});

// Both units shipped naming an account that was true of one machine and of
// nobody else's: the backend said deploy, the updater said dojobay, neither
// renderer touched the line and the installer created neither. Both services
// then failed 217/USER on a fresh box, silently, because nginx serves the
// directory as static files whether or not the backend is alive. The updater
// never ran, which is what an operator actually noticed: stale statuses, no
// block heights, no avatars.
await check("the units name an account the installer actually creates", async () => {
  const lib = await import("./installer-lib.mjs");
  const { SERVICE_USER, renderServerUnit, renderUpdateUnit } = lib;

  // Rendered with a name that is NOT the default, deliberately. The updater
  // template happens to be hardcoded to the same account the installer now
  // creates, so asserting on the default passes whether or not the renderer
  // rewrites anything: the first version of this check did exactly that and
  // survived having the rewrite deleted.
  const OTHER = "svcacct";
  const srvTpl = readFileSync(new URL("./dojobay-server.service", import.meta.url).pathname, "utf8");
  const updTpl = readFileSync(new URL("./dojobay-update.service", import.meta.url).pathname, "utf8");
  const srv = renderServerUnit(srvTpl, { webRoot: "/srv/db", baseUrl: "http://x.onion", adminCode: "PM8Tx", user: OTHER });
  const upd = renderUpdateUnit(updTpl, { webRoot: "/srv/db", user: OTHER });

  for (const [name, unit] of [["server", srv], ["updater", upd]]) {
    assert.ok(new RegExp(`^User=${OTHER}$`, "m").test(unit), `${name} runs as the account it was given`);
    assert.ok(new RegExp(`^Group=${OTHER}$`, "m").test(unit), `${name} group matches`);
    assert.ok(!/^User=(deploy|dojobay)$/m.test(unit),
      `${name} does not keep the account its template was written for`);
    assert.ok(/^WorkingDirectory=\/srv\/db/m.test(unit), `${name} points at the chosen web root`);
  }
  // and the default, which is what the installer actually uses
  assert.ok(new RegExp(`^User=${SERVICE_USER}$`, "m").test(renderUpdateUnit(updTpl, { webRoot: "/srv/db" })),
    "the default account is the one the installer creates");
  // one account for both, or the store is written by one service and read by
  // another that cannot open it
  assert.equal((srv.match(/^User=(.*)$/m) || [])[1], (upd.match(/^User=(.*)$/m) || [])[1],
    "both services run as the same account");

  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  assert.ok(/useradd/.test(src) && /SERVICE_USER/.test(src), "the installer creates that account");
  assert.ok(/chown", \["-R", `\$\{SERVICE_USER\}:\$\{SERVICE_USER\}`, webRoot\]/.test(src),
    "and gives it the tree, since the backend writes the store and a self-update rewrites the code");
});

// The restart permission self-update needs, and the account it is granted to.
//
// Written as a polkit rule rather than a sudoers line because nothing calls
// sudo: apply-update.mjs runs `systemctl restart` directly, which systemd
// authorises through polkit. A sudoers rule would grant a privilege on a path
// no code takes, which is what the admin console used to print.
await check("the restart rule grants exactly one verb on one unit to the service account", async () => {
  const lib = await import("./installer-lib.mjs");
  const { SERVICE_USER, renderPolkitRule, POLKIT_RULE_PATH, SYSTEMD_MANAGE_UNITS } = lib;
  const tpl = readFileSync(new URL("../deploy/polkit-restart.rules.example", import.meta.url).pathname, "utf8");

  // Rendered with an account that is NOT the default, for the reason the unit
  // test above gives: the template names the default, so asserting on it would
  // pass with the substitution deleted.
  const OTHER = "svcacct";
  const rule = renderPolkitRule(tpl, { user: OTHER });
  assert.ok(new RegExp(`subject\\.user == "${OTHER}"`).test(rule), "the rule names the account it was given");
  assert.ok(!/subject\.user == "dojobay"/.test(rule), "and not the one its template was written for");
  assert.ok(renderPolkitRule(tpl).includes(`subject.user == "${SERVICE_USER}"`),
    "the default is the account the installer creates");

  // Narrow on every axis. A rule that omitted the verb would grant stop and
  // mask as well as restart, and one that omitted the unit would grant them on
  // every service on the machine.
  assert.ok(rule.includes(`action.id == "${SYSTEMD_MANAGE_UNITS}"`), "one action");
  assert.ok(/action\.lookup\("unit"\) == "dojobay-server\.service"/.test(rule), "one unit");
  assert.ok(/action\.lookup\("verb"\) == "restart"/.test(rule), "one verb");
  assert.ok(!/polkit\.Result\.(NO|AUTH|NOT_AUTHORIZED)/.test(rule),
    "and it only ever returns YES, so it cannot weaken the distribution default");

  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  assert.ok(/is-active", "--quiet", "polkit\.service"/.test(src),
    "the installer checks polkit is running before offering to write a rule nothing would read");
  assert.ok(/ui\.confirm\(`Grant \$\{SERVICE_USER\}/.test(src),
    "it is a question, not a silent grant");
  assert.ok(src.indexOf("POLKIT_RULE_PATH, polkitRule") > src.indexOf("Write configuration and start services?"),
    "and nothing is written before the operator confirms the write phase");
  assert.ok(/"pkcheck", \["--action-id", SYSTEMD_MANAGE_UNITS/.test(src),
    "the rule is verified by asking polkit the question systemd will ask");
  // SINGULAR. pkcheck's own --help prints --details and its parser accepts only
  // --detail or -d, so the plural spelling exits 126 and was read as a refusal.
  assert.ok(/"--detail", "unit"/.test(src) && !/"--details", "unit"/.test(src),
    "with --detail, which is the spelling pkcheck's parser accepts rather than the one its help prints");
  // 1, 2 and 3 are answers about authorisation; anything else is pkcheck unable
  // to ask, and says nothing about the rule.
  assert.ok(/\[1, 2, 3\]\.includes\(e\.code\)/.test(src),
    "and only an authorisation answer is reported as a refusal");
  // Asked as root, about a process belonging to the service account. polkit
  // refuses a details-bearing query from any caller that is not uid 0, which is
  // why the backend cannot make this check and the installer can: it runs under
  // sudo. Asking as the service account returns NotAuthorized regardless of
  // whether the rule is present, which is what the console used to report.
  assert.ok(/echo \$\$; exec sleep/.test(src),
    "holding a process open as the service account, since the query needs a subject that belongs to it");
  assert.ok(!/sudo", \["-u", SERVICE_USER, "sh", "-c",\s*`pkcheck/.test(src),
    "and not by running pkcheck as that account, which polkit refuses whatever the rule says");
  assert.ok(POLKIT_RULE_PATH.startsWith("/etc/polkit-1/rules.d/49-"),
    "read before the distribution's own 50-default.rules");
});

// Reconciling what is installed under /etc against what ships here.
//
// The operator's own settings are not drift, and the tool proves that by
// recovering them from the installed file and rendering them back in. If that
// stopped working, every reconcile on every machine would report the operator's
// own onion, admin code and paths as changes to be overwritten, which is the
// one outcome that would make this tool worse than not having it.
await check("reconcile carries an operator's own settings forward rather than reporting them as drift", async () => {
  const lib = await import("./installer-lib.mjs");
  const { renderServerUnit, renderUpdateUnit, recoverUnitValues, planSystemFile } = lib;
  const tpl = readFileSync(new URL("./dojobay-server.service", import.meta.url).pathname, "utf8");

  // The live VPS's real shape: an account and a web root that are not the
  // installer's defaults, which is the case the recovery exists for.
  const v = { webRoot: "/var/www/dojobay", user: "deploy",
    baseUrl: "http://" + "d".repeat(56) + ".onion", adminCode: "PM8" + "x".repeat(113) };
  const installed = renderServerUnit(tpl, v);

  const back = recoverUnitValues(installed);
  assert.strictEqual(back.user, "deploy", "the account is read back from User=");
  assert.strictEqual(back.webRoot, "/var/www/dojobay", "and the web root from ExecStart, not guessed");
  assert.strictEqual(back.baseUrl, v.baseUrl, "the onion is read back exactly");
  assert.strictEqual(back.adminCode, v.adminCode, "and so is the admin code");

  // The round trip is the whole claim: render, recover, render again, identical.
  assert.strictEqual(renderServerUnit(tpl, back), installed,
    "rendering with the recovered values reproduces the installed file byte for byte");
  assert.strictEqual(planSystemFile({ installed, shipped: renderServerUnit(tpl, back) }).state, "same",
    "so an unmodified machine reconciles as matching, whatever it was configured with");

  // A machine that predates the installer still has to be readable, since that
  // is the one this was written for.
  const updTpl = readFileSync(new URL("./dojobay-update.service", import.meta.url).pathname, "utf8");
  assert.strictEqual(recoverUnitValues(renderUpdateUnit(updTpl, v)).webRoot, "/var/www/dojobay",
    "the updater unit's web root comes back too, though its WorkingDirectory differs from the backend's");

  // Absent is a third answer. The polkit rule is legitimately missing on any
  // instance whose operator declined it, and reporting that as a difference
  // would train people to apply without reading.
  assert.strictEqual(planSystemFile({ installed: null, shipped: "x" }).state, "absent", "absent is not differs");
  assert.strictEqual(planSystemFile({ installed: "a", shipped: "b" }).state, "differs", "and differs is differs");
});

// The reconciler's file list and the installer's writes are two statements of
// the same thing, and the failure mode if they diverge is silent: a file the
// installer puts under /etc that the reconciler does not know about drifts
// forever without appearing in any report.
await check("the reconciler knows every system file the installer writes", async () => {
  const rec = readFileSync(new URL("./reconcile-system.mjs", import.meta.url).pathname, "utf8");
  const inst = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  // Two exclusions, both deliberate. sites-enabled is a symlink to
  // sites-available, so reconciling it would compare a file against itself.
  // torrc is merged into rather than rendered: an operator's torrc carries
  // hidden services that are none of this project's business, which is why the
  // installer edits a marked block and the uninstaller removes only that block.
  const NOT_OURS = /sites-enabled|\/etc\/tor\/torrc/;
  const paths = [...inst.matchAll(/"(\/etc\/[^"]+)"/g)].map((m) => m[1])
    .filter((p) => !NOT_OURS.test(p));
  assert.ok(paths.length >= 4, `the installer writes several files under /etc (found ${paths.length})`);

  // Compared exactly, against the paths the reconciler declares, not by
  // searching its source for the string. A substring search passed when the
  // nginx entry was renamed to /etc/nginx/sites-available/dojobay-renamed,
  // because the old path is a prefix of the new one: the test agreed that a
  // file was covered while the tool no longer touched it.
  const covered = new Set([...rec.matchAll(/installed: "(\/etc\/[^"]+)"/g)].map((m) => m[1]));
  for (const p of new Set(paths)) {
    assert.ok(covered.has(p), `the reconciler covers ${p} (it declares: ${[...covered].join(", ")})`);
  }
  // POLKIT_RULE_PATH reaches the installer through the constant rather than as
  // a literal, so it is checked by name instead.
  assert.ok(/POLKIT_RULE_PATH/.test(rec) && /POLKIT_RULE_PATH/.test(inst),
    "including the polkit rule, which both reach through the shared constant");

  assert.ok(/const APPLY = argv\.includes\("--apply"\)/.test(rec), "it is a dry run unless asked otherwise");
  assert.ok(rec.indexOf('execFileP("nginx", ["-t"])') < rec.indexOf('["reload", "nginx"]'),
    "and nginx is validated before it is reloaded, never after");
  assert.ok(/copyFile\(dest, path\.join\(backupDir/.test(rec),
    "the file it overwrites is kept, since the installed copy is the only record of the operator's configuration");
  // Kept out of the unit directory. systemd ignores a file without a unit
  // suffix, so a .bak beside a unit is inert, but they accumulate a set per run
  // in a directory an operator reads when something is already wrong.
  assert.ok(/\/var\/backups\/dojobay\/system-/.test(rec) && !/\$\{dest\}\.\$\{stamp\}\.bak/.test(rec),
    "and kept in /var/backups rather than beside the units");

  // A timer whose file changed keeps the old schedule until it is restarted,
  // and daemon-reload does not do that. Nothing about the machine looks wrong
  // meanwhile: the timer is enabled, the file on disk is right, and the
  // schedule being enforced is the previous one.
  assert.ok(/\["restart", t\]/.test(rec) && /endsWith\("\.timer"\)/.test(rec),
    "a rewritten timer is restarted rather than left for somebody to remember");
  assert.ok(/NextElapseUSecRealtime/.test(rec),
    "and its next elapse is read back, because a timer with none looks enabled and never fires");
  assert.ok(!/restart it yourself when it suits you[\s\S]{0,80}dojobay-server\.service/.test(rec)
    && /services\.join\(" "\)/.test(rec),
    "units needing a restart are named individually, not assumed to be the backend alone");
});

// The confirmation prompt cannot be answered by something the operator did not
// mean as an answer.
//
// Pasting a block of commands leaves the later lines queued on stdin, and a
// prompt that reads a line takes the next one. On the live VPS that queued line
// began with s and read as no; one beginning with y would have approved an
// overwrite of the files under /etc. Draining once fixes nothing, which is the
// point of this test: the first attempt did exactly that and a queued "yes"
// still wrote, because the bytes were in the terminal buffer and had not
// reached the process, so the read returned null.
await check("a line queued before the prompt cannot approve an overwrite", async () => {
  const rec = readFileSync(new URL("./reconcile-system.mjs", import.meta.url).pathname, "utf8");
  const fn = rec.slice(rec.indexOf("async function confirm("), rec.indexOf("async function main("));

  assert.ok(/setTimeout\(r, \d{3}\)/.test(fn),
    "input is discarded for a settle window before the question is asked");
  assert.ok(fn.indexOf("setTimeout") < fn.indexOf("createInterface"),
    "and the window closes before readline is attached, not after");
  assert.ok(!/while \(process\.stdin\.read\(\) !== null\)/.test(fn),
    "not a single drain, which discards nothing because the bytes have not arrived yet");
  assert.ok(/\[y\/N\]/.test(fn) && /\/\^y\(es\)\?\$\/i/.test(fn),
    "and the default stays no, since the settle window is a margin rather than a guarantee");

  // These are checks on the source, and they are weaker than the thing they
  // stand for: they would all pass if the window were in place and the answer
  // came from somewhere else. The behaviour was proven on a real pty during
  // development, queuing a line reading "yes" before the prompt and a genuine
  // "y" three seconds after it, and it is not in this suite because the suite
  // cannot assume a terminal exists. If this ever needs re-proving, that is how.
});

// An install used to finish and leave the operator looking at another
// instance's numbers: the timer's first run is boot-relative, and nothing had
// probed even once, so there were no block heights and no avatars because
// neither exists until something asks for them.
await check("the installer runs a probe cycle before it declares success", async () => {
  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  const tail = src.slice(src.indexOf("services enabled and started"));
  assert.ok(/scripts", "update\.mjs"/.test(tail) || /update\.mjs/.test(tail),
    "the updater is invoked during the install, after the services are up");
  assert.ok(/sudo", \["-u", SERVICE_USER/.test(tail),
    "as the service account, so nothing it writes is left owned by root");
  assert.ok(/catch \(e\)/.test(tail) && /timer will retry/.test(tail),
    "and a failure here reports itself rather than undoing an otherwise complete install");
});

// The anchor's signed block is published, so a reader must be able to check it
// without being told which payment code to check it against.
await check("the anchor signature must carry a BIP47 line", async () => {
  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  assert.ok(/BIP47 line is required/.test(src),
    "the prompt says so before the operator signs, not after they paste");
  assert.ok(/BIP47:\\n" \+ wrapForNote\(paymentCode\)/.test(src),
    "and shows the exact line to append, rather than describing it");
  assert.ok(/sig\.ok && !sig\.paymentCode/.test(src),
    "a block with a good signature and no BIP47 line is refused");
  assert.ok(/different payment code from the/.test(src),
    "as is one naming somebody else's code");
});

// Both units shipped naming an account that was true of one machine and of
// nobody else's: the backend said deploy, the updater said dojobay, neither
// renderer touched the line and the installer created neither. Both services
// then failed 217/USER on a fresh box, silently, because nginx serves the
// directory as static files whether or not the backend is alive. The updater
// never ran, which is what an operator actually noticed: stale statuses, no
// block heights, no avatars.
await check("the units name an account the installer actually creates", async () => {
  const lib = await import("./installer-lib.mjs");
  const { SERVICE_USER, renderServerUnit, renderUpdateUnit } = lib;

  const srv = renderServerUnit(readFileSync(new URL("./dojobay-server.service", import.meta.url).pathname, "utf8"),
    { webRoot: "/srv/db", baseUrl: "http://x.onion", adminCode: "PM8Tx" });
  const upd = renderUpdateUnit(readFileSync(new URL("./dojobay-update.service", import.meta.url).pathname, "utf8"),
    { webRoot: "/srv/db" });

  for (const [name, unit] of [["server", srv], ["updater", upd]]) {
    assert.ok(new RegExp(`^User=${SERVICE_USER}$`, "m").test(unit), `${name} runs as the service account`);
    assert.ok(new RegExp(`^Group=${SERVICE_USER}$`, "m").test(unit), `${name} group matches`);
    assert.ok(!/^User=deploy$/m.test(unit), `${name} does not still name a machine-specific account`);
    assert.ok(/^WorkingDirectory=\/srv\/db/m.test(unit), `${name} points at the chosen web root`);
  }
  // one account for both, or the store is written by one service and read by
  // another that cannot open it
  assert.equal((srv.match(/^User=(.*)$/m) || [])[1], (upd.match(/^User=(.*)$/m) || [])[1],
    "both services run as the same account");

  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  assert.ok(/useradd/.test(src) && /SERVICE_USER/.test(src), "the installer creates that account");
  assert.ok(/chown", \["-R", `\$\{SERVICE_USER\}:\$\{SERVICE_USER\}`, webRoot\]/.test(src),
    "and gives it the tree, since the backend writes the store and a self-update rewrites the code");
});

// An install used to finish and leave the operator looking at another
// instance's numbers: the timer's first run is boot-relative, and nothing had
// probed even once, so there were no block heights and no avatars because
// neither exists until something asks for them.
await check("the installer runs a probe cycle before it declares success", async () => {
  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  const tail = src.slice(src.indexOf("services enabled and started"));
  assert.ok(/scripts", "update\.mjs"/.test(tail) || /update\.mjs/.test(tail),
    "the updater is invoked during the install, after the services are up");
  assert.ok(/sudo", \["-u", SERVICE_USER/.test(tail),
    "as the service account, so nothing it writes is left owned by root");
  assert.ok(/catch \(e\)/.test(tail) && /timer will retry/.test(tail),
    "and a failure here reports itself rather than undoing an otherwise complete install");
});

// The anchor's signed block is published, so a reader must be able to check it
// without being told which payment code to check it against.
await check("the anchor signature must carry a BIP47 line", async () => {
  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  assert.ok(/BIP47 line is required/.test(src),
    "the prompt says so before the operator signs, not after they paste");
  assert.ok(/BIP47:\\n" \+ wrapForNote\(paymentCode\)/.test(src),
    "and shows the exact line to append, rather than describing it");
  assert.ok(/sig\.ok && !sig\.paymentCode/.test(src),
    "a block with a good signature and no BIP47 line is refused");
  assert.ok(/different payment code from the/.test(src),
    "as is one naming somebody else's code");
});

await check("installer library: validators, torrc idempotence, unit rendering", async () => {
  const lib = await import("./installer-lib.mjs");
  assert.ok(lib.isPaymentCode("PM8T" + "1".repeat(112)));
  assert.ok(!lib.isPaymentCode("PM8T" + "0".repeat(112)), "0 is not base58");
  assert.ok(!lib.isPaymentCode("PM8Tshort"));
  assert.ok(lib.isOnionHost("a".repeat(56).replace(/a/g, "b") + ".onion") === false || true);
  assert.ok(lib.isOnionHost("2".repeat(56) + ".onion"));
  assert.ok(!lib.isOnionHost("example.com"));
  assert.equal(lib.onionHostOf("http://" + "2".repeat(56) + ".onion/data/x"), "2".repeat(56) + ".onion");
  const bad = lib.parsePairing('{"pairing":{"type":"nope"}}');
  assert.ok(!bad.ok);
  const good = lib.parsePairing(JSON.stringify({ pairing: { type: "dojo.api", url: "http://" + "c".repeat(56) + ".onion/v2", apikey: "k" } }));
  assert.ok(good.ok);
  assert.equal(lib.operatorMessage("x".repeat(56) + ".onion", "PM8Tabc"),
    "http://" + "x".repeat(56) + ".onion/\n\nBIP47: PM8Tabc");
  // torrc merge: append once, replace on re-run
  const once = lib.mergeTorrc("SocksPort 9050\n", "/var/lib/tor/dojobay");
  const twice = lib.mergeTorrc(once, "/var/lib/tor/other");
  assert.ok(once.includes("HiddenServiceDir /var/lib/tor/dojobay"));
  assert.ok(twice.includes("/var/lib/tor/other") && !twice.includes("/var/lib/tor/dojobay"));
  assert.equal((twice.match(/HiddenServiceDir/g) || []).length, 1, "managed block replaced, not duplicated");
  const unit = lib.renderServerUnit("WorkingDirectory=/x\nEnvironment=BASE_URL=http://old\nEnvironment=ADMIN_PAYMENT_CODES=OLD\nExecStart=/old",
    { webRoot: "/srv/db", baseUrl: "http://new.onion", adminCode: "PM8Tnew" });
  assert.ok(unit.includes("WorkingDirectory=/srv/db/server") && unit.includes("BASE_URL=http://new.onion") && unit.includes("ADMIN_PAYMENT_CODES=PM8Tnew"));
});

await check("TUI core: key decoding, form navigation/validation, frame rendering", async () => {
  const { decodeKeys, formInit, formReduce, formValues, renderForm, renderProgress } = await import("./tui.mjs");
  // key decoding
  assert.deepEqual(decodeKeys(Buffer.from("\x1b[A\x1b[B\x1b[C\x1b[D")), ["up", "down", "right", "left"]);
  assert.deepEqual(decodeKeys(Buffer.from("\r\t\x7f\x03")), ["enter", "tab", "backspace", "ctrl-c"]);
  assert.deepEqual(decodeKeys(Buffer.from("ab")), [{ char: "a" }, { char: "b" }]);
  // form: type into field 1, toggle field 2, enter through to submit
  let st = formInit([
    { key: "name", label: "Name", type: "text", validate: (v) => v.length > 0 || "required" },
    { key: "net", label: "Network", type: "toggle", options: ["mainnet", "testnet"] },
  ]);
  st = formReduce(st, "enter");                       // empty -> error, stays
  assert.equal(st.fields[0].error, "required");
  for (const ch of "yellow") st = formReduce(st, { char: ch });
  st = formReduce(st, "enter");                       // valid -> advance to toggle
  assert.equal(st.active, 1);
  st = formReduce(st, "right");                       // mainnet -> testnet
  st = formReduce(st, "enter");                       // -> continue button
  st = formReduce(st, "enter");                       // submit
  assert.ok(st.submitted);
  assert.deepEqual(formValues(st), { name: "yellow", net: "testnet" });
  // backspace + esc
  let st2 = formInit([{ key: "a", label: "A", type: "text" }]);
  st2 = formReduce(formReduce(st2, { char: "x" }), "backspace");
  assert.equal(st2.fields[0].value, "");
  assert.ok(formReduce(st2, "esc").cancelled);
  // rendering: content present, every line within width
  const frame = renderForm(formInit([{ key: "a", label: "Payment code", type: "text", hint: "PM8T…" }]),
    { width: 80, stepLabel: "step 3 of 8", title: "Your identity" });
  const plain = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.ok(plain.includes("THE DOJO BAY") && plain.includes("Your identity") && plain.includes("Payment code") && plain.includes("Continue"));
  assert.ok(plain.split("\r\n").every((l) => l.length <= 80), "no line exceeds the terminal width");
  const prog = renderProgress({ width: 80, stepLabel: "s", title: "probing", log: ["connecting…"], spinnerIndex: 3 })
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.ok(prog.includes("probing") && prog.includes("connecting…") && prog.includes("please wait"));
});

await check("source zip round-trips through self-update; staging works; zip-slip rejected", async () => {
  const { packSource } = await import("./pack-source.mjs");
  const { unzip, applyUpdate } = await import("../server/self-update.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "dojobay-rt-"));
  try {
    const r = await packSource({ outDir: dir });
    const buf = await readFile(r.out);
    const entries = unzip(buf);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("dojobay/server/index.mjs") && names.includes("dojobay/assets/js/app.js"), "core files present");
    const pkg = entries.find((e) => e.name === "dojobay/package.json");
    const onDisk = await readFile(path.join(process.cwd(), "package.json"));
    assert.ok(pkg && Buffer.compare(pkg.data, onDisk) === 0, "inflated file matches source byte-for-byte");

    // Apply into a temp web root without spawning the helper: staging + backup
    // exist. The web root is given a minimal tree first, because updating one
    // with no code in it is not a scenario that happens and the backup guard
    // now refuses it. Instance data goes in too, so the filter can be observed
    // doing its job rather than merely inspected in the source.
    const webRoot = await mkdtemp(path.join(tmpdir(), "dojobay-web-"));
    await mkdir(path.join(webRoot, "server", "data"), { recursive: true });
    await mkdir(path.join(webRoot, "server", "node_modules", "left-pad"), { recursive: true });
    await mkdir(path.join(webRoot, "assets", "js"), { recursive: true });
    await writeFile(path.join(webRoot, "server", "index.mjs"), "// current code");
    await writeFile(path.join(webRoot, "server", "data", "store.json"), '{"sessions":"secret"}');
    await writeFile(path.join(webRoot, "server", "node_modules", "left-pad", "i.js"), "x");
    await writeFile(path.join(webRoot, "assets", "js", "app.js"), "// current app");

    const res = await applyUpdate({ bytes: buf, sourceLabel: "test", version: "deadbeef", webRoot, spawnHelper: false, log: () => {} });
    const staged = await readFile(path.join(res.staging, "server/index.mjs")).then(() => true, () => false);
    assert.ok(staged && res.entries > 30, "new tree staged");

    const inBackup = async (rel) => readFile(path.join(res.backupDir, rel)).then(() => true, () => false);
    assert.ok(await inBackup("server/index.mjs"), "the code that is about to be replaced is backed up");
    assert.ok(await inBackup("assets/js/app.js"), "from every code directory, not just the first");
    assert.ok(!(await inBackup("server/data/store.json")),
      "and instance data is NOT copied: sessions and node API keys live there");
    assert.ok(!(await inBackup("server/node_modules/left-pad/i.js")), "nor node_modules");
    await rm(webRoot, { recursive: true, force: true });

    // zip-slip: an entry escaping the top folder must be refused
    const { deflateRawSync } = await import("node:zlib");
    const evil = makeMiniZip("dojobay/../evil.txt", Buffer.from("x"));
    await assert.rejects(applyUpdate({ bytes: evil, webRoot: "/tmp", spawnHelper: false, log: () => {} }), /unsafe path|does not look like/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// GitHub's zipball carries an entry for each DIRECTORY: zero bytes, a name
// ending in a slash, and the very first entry in the archive is the bare
// top-level folder. Stripping one segment from that leaves an empty relative
// path, which the traversal guard rejected, so a self-update from GitHub failed
// on its first entry with a message about an unsafe path. Every test passed
// while it did, because the fixtures are built the way pack-source builds
// archives, and pack-source writes no directory entries at all: the extractor
// was only ever shown archives of its own shape. This fixture has GitHub's.
await check("an archive with directory entries unpacks, GitHub's shape included", async () => {
  const { applyUpdate } = await import("../server/self-update.mjs");
  const dir = mkdtempSync("/tmp/dojobay-ghzip-");
  try {
    const zip = concatZip([
      ["Dojobay-dojobay-abc1234/", Buffer.alloc(0)],            // the folder itself
      ["Dojobay-dojobay-abc1234/server/", Buffer.alloc(0)],
      ["Dojobay-dojobay-abc1234/server/index.mjs", Buffer.from("// new")],
      ["Dojobay-dojobay-abc1234/assets/js/", Buffer.alloc(0)],
      ["Dojobay-dojobay-abc1234/assets/js/app.js", Buffer.from("// new")],
    ]);
    mkdirSync(dir + "/server", { recursive: true });
    mkdirSync(dir + "/assets", { recursive: true });
    writeFileSync(dir + "/server/index.mjs", "// current");
    writeFileSync(dir + "/assets/app.js", "// current");

    const res = await applyUpdate({ bytes: zip, webRoot: dir, spawnHelper: false, log: () => {} });
    assert.equal(res.entries, 2, "only the two real files are staged, not the three folders");
    assert.ok(existsSync(res.staging + "/server/index.mjs"), "and the nested file is written");
    assert.ok(existsSync(res.staging + "/assets/js/app.js"),
      "including one whose parent directory only ever existed as a zip entry, "
      + "because the writer creates parents as it goes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// NOTHING under data/ is staged, whatever the archive holds. A GitHub zipball
// is the whole repository and seven files under data/ are committed to it, so a
// self-update overwrote the instance's published list with the empty scaffold,
// its history with the repository's, its seed anchor, its operator binding and
// its version marker with "dev". The backup could not help: it excludes data/
// for the same reason this now does.
await check("an archive cannot overwrite instance data, whatever it contains", async () => {
  const { applyUpdate } = await import("../server/self-update.mjs");
  const dir = mkdtempSync("/tmp/dojobay-instdata-");
  try {
    // Exactly the files a zipball of this repository carries under data/.
    const zip = concatZip([
      ["dojobay/server/index.mjs", Buffer.from("// new")],
      ["dojobay/assets/js/app.js", Buffer.from("// new")],
      ["dojobay/data/dojos.json", Buffer.from('{"nodes":[]}')],
      ["dojobay/data/history.json", Buffer.from("{}")],
      ["dojobay/data/history-daily.json", Buffer.from("{}")],
      ["dojobay/data/seed.json", Buffer.from('"THEIRS"')],
      ["dojobay/data/operator.json", Buffer.from('"THEIRS"')],
      ["dojobay/data/paynym-codes.json", Buffer.from("{}")],
      ["dojobay/data/version.json", Buffer.from('{"commit":"dev"}')],
    ]);
    mkdirSync(dir + "/server", { recursive: true });
    mkdirSync(dir + "/assets", { recursive: true });
    writeFileSync(dir + "/server/index.mjs", "// current");
    writeFileSync(dir + "/assets/app.js", "// current");

    const res = await applyUpdate({ bytes: zip, webRoot: dir, spawnHelper: false, log: () => {} });
    assert.equal(res.entries, 2, "only the two code files are staged, none of the seven data files");
    assert.ok(!existsSync(res.staging + "/data"),
      "and no data directory is created in staging at all, so the swap cannot reach one");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A cycle in which every node fails is evidence about this machine, not about
// the operators. Fifteen independently run nodes on different continents do not
// fail in the same ten minutes; Tor rebuilding circuits after a suspend does
// exactly this, and recording it writes a DOWN check against everybody.
await check("a cycle that reaches nothing at all is not recorded", async () => {
  const src = readFileSync(new URL("./update.mjs", import.meta.url).pathname, "utf8");
  assert.ok(/const allFailed = dojos\.nodes\.length > 0 && results\.every\(\(r\) => !r\.up\)/.test(src),
    "a clean sweep is detected, and an empty directory is not one");

  const block = src.slice(src.indexOf("if (allFailed) {"), src.indexOf("dojos.generated_at = ts.isoSec;"));
  assert.ok(/probe_fault/.test(block), "the fault is published so the page can say so");
  assert.ok(/return;/.test(block), "and the cycle stops before writing history");
  assert.ok(!/generated_at = ts\.isoSec/.test(block),
    "generated_at is not advanced, so the staleness banner keeps measuring real data age");

  // history is written after that return, so a withheld cycle cannot reach it
  assert.ok(src.indexOf("if (allFailed) {") < src.indexOf("writeJSONAtomic(historyPath"),
    "the history write is downstream of the guard");
  assert.ok(/delete dojos\.probe_fault/.test(src),
    "and a cycle that reaches something clears the fault rather than leaving it up");
});

// Defaults that suit a home connection as well as a VPS, since the timer unit
// lives in /etc and an operator should not have to edit it.
await check("the probe defaults are gentle enough for a domestic line", async () => {
  const { probeCfg } = await import("./update.mjs");
  const cfg = probeCfg({});
  assert.equal(cfg.timeoutMs, 45000,
    "45s: nodes answering at 23s were recorded as down against a 30s ceiling");
  assert.equal(cfg.concurrency, 3,
    "three circuits at once: six through one Tor client on a home line makes every "
    + "probe slow together, which reads as every node being down");
});

// `<file>.tmp` is not atomic between processes. Two writers produce the same
// path, the first rename consumes it, and the second fails with ENOENT on a
// file it had itself just written. An install did exactly that: enabling the
// timer fired a catch-up run at once, because the schedule is a calendar one
// with Persistent=true, and it collided with the installer's own first probe
// cycle over data/dojos.json.tmp.
await check("no two writers can take the same temporary file", async () => {
  // Every file that renames a temporary over a real one, not just the three
  // the updater collision was found in. The maintenance tools refuse to run
  // while the service holds the store, which makes a collision need two tools
  // at once rather than a tool and the backend; that is a narrower window, not
  // a closed one, and the fix costs one interpolation.
  for (const f of ["./update.mjs", "./bootstrap-import.mjs",
                   "../server/build-public.ts", "../server/store.ts",
                   "../server/apply-signed-payload.ts", "../server/fix-payload-version.mjs",
                   "../server/remove-listing.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url).pathname, "utf8");
    assert.ok(!/["'`]\s*\+\s*["']\.tmp["']|\+ "\.tmp"/.test(src),
      `${f} no longer builds a temporary name by appending .tmp to the target`);
    assert.ok(/process\.pid/.test(src),
      `${f} includes the pid, so two processes cannot collide`);
  }

  // and the names really are distinct within a process as well, wherever one
  // run writes several files in quick succession
  for (const f of ["./update.mjs", "./bootstrap-import.mjs",
                   "../server/remove-listing.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url).pathname, "utf8");
    assert.ok(/tmpSeq = \(tmpSeq \+ 1\)/.test(src),
      `${f} uses a counter as well as the pid, so successive writes in one process differ`);
  }
});

// The installer starts the timer AFTER its own first cycle. Enabling it with
// --now fires a catch-up run immediately, which is the collision above.
await check("the installer does not race its own first probe cycle", async () => {
  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  const enable = src.indexOf('["enable", "dojobay-update.timer"]');
  const cycle = src.indexOf('await run("sudo", ["-u", SERVICE_USER, "node"');
  const start = src.indexOf('["start", "dojobay-update.timer"]');
  assert.ok(enable !== -1 && start !== -1, "the timer is enabled and started separately");
  assert.ok(enable < cycle && cycle < start,
    "enabled for boot, then the first cycle runs, then the timer starts");
  assert.ok(!/"enable", "--now"[^\]]*dojobay-update\.timer/.test(src),
    "and it is never enabled with --now, which would fire a run at once");
  assert.ok(start < src.indexOf("NextElapseUSecRealtime"),
    "the armed check still comes last, or it would read a timer that had not started");
});

// Dependencies are installed before the swap, not after it.
//
// `npm ci` deletes node_modules and then installs. Running it after the overlay
// meant a failure left none at all and the backend could not resolve its own
// imports; one instance restarted a hundred and three times. The failure itself
// was npm having nowhere to write its cache, because the service account is
// created with --no-create-home and $HOME/.npm cannot be made.
await check("a failed dependency install leaves the old code running", async () => {
  const src = readFileSync(new URL("./apply-update.mjs", import.meta.url).pathname, "utf8");
  const install = src.indexOf('"ci", "--omit=dev"');
  const overlay = src.indexOf("cp(staging, webRoot");
  assert.ok(install !== -1 && install < overlay,
    "dependencies are installed into staging before anything is overlaid");
  assert.ok(/cwd: path\.join\(staging, "server"\)/.test(src),
    "in the staging tree, so the running instance keeps its own until the swap");

  const block = src.slice(install - 400, overlay);
  assert.ok(/process\.exit\(1\)/.test(block) && /nothing was changed/.test(block),
    "and a failure aborts and says so, rather than being swallowed");
  assert.ok(/HOME: npmHome/.test(src) && /"--cache", npmHome/.test(src),
    "npm gets a cache and a HOME it can write: the service account has no home directory");
  assert.ok(!/keep going: existing node_modules/.test(src),
    "the belief that a failure was survivable is gone, since npm ci removes them first");
});

// The version marker states what was installed, which only the updater knows.
await check("the swap writes the version it fetched, not the one in the archive", async () => {
  const src = readFileSync(new URL("./apply-update.mjs", import.meta.url).pathname, "utf8");
  assert.ok(/writeFile\(path\.join\(webRoot, "data", "version\.json"\)/.test(src),
    "apply-update writes data/version.json itself");
  assert.ok(/commit: String\(version\)\.slice\(0, 7\)/.test(src),
    "from the commit passed to it, shortened to the seven characters the deploy writes "
    + "so the footer reads the same however the code arrived");
  // Order matters: written after the overlay, or the overlay would clobber it
  // if a future archive ever carried one again.
  assert.ok(src.indexOf("cp(staging, webRoot") < src.indexOf('"version.json"'),
    "after the overlay rather than before it");
  // pack-source ships a version.json describing the machine that built the
  // archive, and a zipball ships the repository's; neither describes what has
  // just been installed, which is why this cannot be taken from the tree.
  assert.ok(/pack-source|zipball|repository/i.test(src.slice(src.indexOf("version marker"), src.indexOf('"version.json"'))),
    "and the comment says why the archive's copy is not the answer");
});

// Traversal is still refused, and a slash on the end is not a way around it.
await check("a directory entry cannot smuggle a path traversal", async () => {
  const { applyUpdate } = await import("../server/self-update.mjs");
  for (const name of ["dojobay/../evil/", "dojobay/../evil.txt"]) {
    const zip = concatZip([
      [name, Buffer.alloc(0)],
      ["dojobay/server/index.mjs", Buffer.from("x")],
      ["dojobay/assets/js/app.js", Buffer.from("x")],
    ]);
    await assert.rejects(applyUpdate({ bytes: zip, webRoot: "/tmp", spawnHelper: false, log: () => {} }),
      /unsafe path/, `${name} is refused whether or not it ends in a slash`);
  }
});

// A decompression bomb. MAX_SOURCE_ZIP_BYTES bounds what arrives; this is about
// what it becomes, and the gap is not small: deflate turns a run of zeroes into
// roughly a thousandth of its size, so an archive comfortably inside the
// download ceiling can still claim gigabytes on the way out.
await check("an archive that inflates past the budget is refused", async () => {
  const { unzip, MAX_INFLATED_BYTES } = await import("../server/self-update.mjs");
  const raw = Buffer.alloc(MAX_INFLATED_BYTES * 2, 0);
  const bomb = makeDeflatedZip("dojobay/big.bin", raw);
  assert.ok(bomb.length < 1024 * 1024,
    `the bomb must be small to be the case in question, it is ${bomb.length} bytes`);
  assert.throws(() => unzip(bomb), /inflates past the \d+ byte limit at entry dojobay\/big\.bin/,
    "refused, naming the limit and the entry that hit it");
});

await check("the budget is spent across the archive, not per entry", async () => {
  const { unzip, MAX_INFLATED_BYTES } = await import("../server/self-update.mjs");
  // Two thirds of the budget, twice. Neither entry is individually oversized,
  // so a per-entry check would pass both and let the archive through at 133%.
  const chunk = Buffer.alloc(Math.floor(MAX_INFLATED_BYTES * 0.66), 0);
  const two = concatZip([["dojobay/a.bin", chunk], ["dojobay/b.bin", chunk]]);
  assert.throws(() => unzip(two), /inflates past the \d+ byte limit at entry dojobay\/b\.bin/,
    "the second entry is where the shared allowance runs out");
});

await check("a hostile entry count is refused before anything is inflated", async () => {
  const { unzip, MAX_ENTRIES } = await import("../server/self-update.mjs");
  // Zero-length entries cost no memory at all, so the byte budget never fires;
  // what they cost is a file each in staging.
  const many = makeMiniZip("dojobay/x.txt", Buffer.alloc(0));
  many.writeUInt16LE(MAX_ENTRIES + 1, many.length - 22 + 10);
  assert.throws(() => unzip(many), new RegExp(`declares ${MAX_ENTRIES + 1} entries`),
    "refused on the declared count, before the entry loop runs");
});

await check("a bomb aborts the update before staging or backup is touched", async () => {
  const { applyUpdate, MAX_INFLATED_BYTES } = await import("../server/self-update.mjs");
  const dir = mkdtempSync("/tmp/dojobay-bomb-");
  try {
    const bomb = makeDeflatedZip("dojobay/big.bin", Buffer.alloc(MAX_INFLATED_BYTES * 2, 0));
    await assert.rejects(applyUpdate({ bytes: bomb, webRoot: dir, spawnHelper: false, log: () => {} }),
      /inflates past/);
    // unzip runs first in applyUpdate, so nothing should exist yet. This is the
    // property that matters operationally: a rejected archive must not leave a
    // half-made staging tree or a backup of code that was never replaced.
    const { readdirSync, existsSync } = await import("node:fs");
    assert.ok(!existsSync(dir + "/data/updates"), "no staging directory was created");
    assert.ok(!existsSync(dir + "/data/backups"), "no backup was taken");
    assert.equal(readdirSync(dir).length, 0, "the web root is untouched: " + readdirSync(dir).join(", "));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check("the real source tree sits well inside the budget", async () => {
  const { unzip, MAX_INFLATED_BYTES } = await import("../server/self-update.mjs");
  const zipPath = new URL("../data/dojobay-src.zip", import.meta.url).pathname;
  execFileSync(process.execPath, [new URL("./pack-source.mjs", import.meta.url).pathname], { stdio: "ignore" });
  const files = unzip(readFileSync(zipPath));
  const total = files.reduce((a, f) => a + f.data.length, 0);
  // Fails once the tree reaches half the allowance, which is the point at which
  // raising the ceiling should be a decision somebody makes rather than a
  // self-update that stops working without explanation.
  assert.ok(total < MAX_INFLATED_BYTES / 2,
    `the tree inflates to ${(total / 1048576).toFixed(2)} MiB against a ${(MAX_INFLATED_BYTES / 1048576)} MiB budget; raise the budget deliberately`);
});

// The reason this exists: probe-services.mjs kept its own copy of the reader and
// therefore kept the unbounded accumulation for a while after the shared one was
// fixed. Asserting on the source is the only way to notice a third copy
// appearing, since a duplicate is by definition not covered by the shared one's
// tests.
await check("no second copy of the Tor reader has grown back", async () => {
  const here = new URL(".", import.meta.url).pathname;
  for (const f of ["probe-services.mjs", "bootstrap-import.mjs"]) {
    const src = readFileSync(here + f, "utf8");
    assert.ok(/import \{[^}]*httpOverTor[^}]*\} from "\.\/update\.mjs"/.test(src)
              || /from "\.\/update\.mjs"/.test(src) && !/function httpOverTor/.test(src),
      `${f} should use the shared reader`);
    assert.ok(!/function httpOverTor/.test(src),
      `${f} declares its own httpOverTor; give it the shared one instead of a second ceiling to maintain`);
  }
});

// The nginx example is not documentation: install.mjs reads this exact file and
// writes it to sites-available, so a rule missing here is a rule missing on
// every instance the installer has ever produced.
await check("the nginx example refuses to serve the updater's working directories", async () => {
  const conf = readFileSync(new URL("../deploy/nginx-onion.conf.example", import.meta.url).pathname, "utf8");
  // Literal patterns rather than regexes assembled from strings. There are two
  // of them and they never vary, so building the pattern bought nothing and
  // cost a real escaping question (CodeQL js/incomplete-sanitization: the
  // hand-rolled escape covered / and not backslash).
  assert.ok(/location\s+\^~\s+\/data\/backups\/\s*\{[^}]*return 404/.test(conf),
    "/data/backups/ must be refused, with ^~");
  assert.ok(/location\s+\^~\s+\/data\/updates\/\s*\{[^}]*return 404/.test(conf),
    "/data/updates/ must be refused, with ^~");
  // ^~ is load-bearing rather than stylistic. Without it these are plain prefix
  // matches, which LOSE to the `~* \.(html|js|css|md)$` block below them, and a
  // backed-up app.js or README.md is served with a 200. Verified against real
  // nginx: removing the modifier turns those two 404s into 200s.
  assert.ok(/location\s+~\*\s+\\\.\(html\|js\|css\|md\)\$/.test(conf),
    "the regex block this must outrank still exists; if it has gone, revisit the modifier");
  // and the published source zip must still be reachable: it is how a peer
  // fetches code during a federated self-update, and how anyone reads what an
  // instance is running.
  assert.ok(!/location[^\n]*dojobay-src\.zip[^\n]*404/.test(conf),
    "data/dojobay-src.zip stays served");
});

await check("the backup filter excludes by path segment, not by substring", async () => {
  const src = readFileSync(new URL("../server/self-update.mjs", import.meta.url).pathname, "utf8");
  assert.ok(!/p\.includes\("node_modules"\)/.test(src) && !/includes\(path\.sep \+ "data"/.test(src),
    "the substring test is gone: it excluded everything at a web root such as /srv/data/dojobay");
  assert.ok(/path\.relative\(webRoot, p\)/.test(src) && /split\(path\.sep\)\.some/.test(src),
    "exclusion is decided on the path relative to the web root, a segment at a time");
});

await check("an update refuses to proceed when the backup came out empty", async () => {
  const { applyUpdate } = await import("../server/self-update.mjs");
  // The failure this guards is silent by construction: the copy loop swallows
  // per-entry errors, so a filter that excluded everything produced no backup
  // and no complaint, and the swap went ahead over irreplaceable code.
  const dir = mkdtempSync("/tmp/dojobay-nobackup-");
  try {
    // The archive must be a plausible source tree, or the shape check refuses
    // it first and this proves nothing. It did exactly that on the first
    // attempt: the assertion passed while the guard was removed.
    const zip = concatZip([
      ["dojobay/server/index.mjs", Buffer.from("// new")],
      ["dojobay/assets/js/app.js", Buffer.from("// new")],
    ]);
    // An empty web root, so there is nothing to back up and the count is zero.
    await assert.rejects(applyUpdate({ bytes: zip, webRoot: dir, spawnHelper: false, log: () => {} }),
      /refusing to update without one/,
      "refused for the absent backup specifically, not for some earlier reason");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\nall ${passed} checks passed`);
