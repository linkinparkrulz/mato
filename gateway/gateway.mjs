#!/usr/bin/env node
// =============================================================================
// The wallet gateway.
//
// Derives invoice addresses on the operator's personal wallet chain and signs
// them. It is the only process that holds the store's key, and it is never
// reachable from the internet: a unix socket by default, whose permissions are
// the access control.
//
// Run it beside the store server, or on a different machine entirely. It needs
// no network, no clock sync and no state but its own seed and index file.
//
//   node gateway.mjs
//
// Config (all optional):
//   GATEWAY_SOCKET   default <data>/gateway.sock
//   GATEWAY_DATA     default ./data
//   STORE_SEED       default <data>/seed.json   { mnemonic, passphrase?, network? }
//   PERSONAL_CODE    the operator's personal BIP47 payment code (required)
//   ADDRESS_TYPE     p2pkh (default) | p2sh | p2wpkh
//
// Protocol: newline-delimited JSON, one request per line.
//   {"op":"next"}            -> allocate an index and return a signed address
//   {"op":"peek","index":n}  -> derive without allocating
//   {"op":"release","index":n} -> hand an unpaid index back
//   {"op":"settle","index":n}  -> retire a paid index permanently
//   {"op":"status"}          -> counters and identity
// =============================================================================
import net from "node:net";
import path from "node:path";
import { unlink, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StoreIdentity } from "./identity.ts";
import { addressFor, parseAddressType, DEFAULT_ADDRESS_TYPE } from "./derive.ts";
import { IndexStore } from "./index-state.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.GATEWAY_DATA || path.join(HERE, "data");
const SOCKET = process.env.GATEWAY_SOCKET || path.join(DATA, "gateway.sock");
const SEED_FILE = process.env.STORE_SEED || path.join(DATA, "seed.json");
const ADDRESS_TYPE = parseAddressType(process.env.ADDRESS_TYPE);

/**
 * Build the request handler.
 *
 * Exported and constructed from its dependencies rather than reading the
 * environment itself, so the self-test drives the real handler over a real
 * socket with a throwaway wallet instead of asserting against a reimplementation
 * of it.
 */
export function makeHandler({ identity, personalCode, indexStore, addressType = DEFAULT_ADDRESS_TYPE }) {
  if (!personalCode) {
    throw new Error("no personal payment code: the gateway would derive addresses on a chain nobody owns");
  }
  const network = identity.network;

  // Deriving and signing one index, in one place, so "next" and "peek" cannot
  // drift into producing different records for the same index.
  const recordFor = (index) => identity.signAddress({
    v: 1,
    address: addressFor(identity.code, personalCode, index, addressType, network),
    index,
    type: addressType,
    network,
    paymentCode: identity.paymentCode(),
  });

  return async function handle(req) {
    switch (req && req.op) {
      case "next": {
        const index = await indexStore.allocate();
        return recordFor(index);
      }
      case "peek": {
        if (!Number.isInteger(req.index) || req.index < 0) {
          return { error: "peek needs a non-negative integer index" };
        }
        return recordFor(req.index);
      }
      case "release": {
        if (!Number.isInteger(req.index)) return { error: "release needs an integer index" };
        return { ok: await indexStore.release(req.index) };
      }
      case "settle": {
        if (!Number.isInteger(req.index)) return { error: "settle needs an integer index" };
        return { ok: await indexStore.settle(req.index) };
      }
      case "status": {
        return {
          paymentCode: identity.paymentCode(),
          notificationAddress: identity.notificationAddress(),
          personalCode,
          type: addressType,
          network,
          ...(await indexStore.status()),
        };
      }
      default:
        return { error: `unknown op: ${req && req.op}` };
    }
  };
}

/** Serve `handle` over a unix socket, one JSON request per line. */
export function serve(handle, socketPath) {
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", async (chunk) => {
      buf += chunk.toString("utf8");
      // A request is a line. Cap the buffer so a client that never sends a
      // newline cannot grow this process's memory without bound.
      if (buf.length > 64 * 1024) { conn.destroy(); return; }
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let out;
        try { out = await handle(JSON.parse(line)); }
        catch (e) { out = { error: e.message }; }
        conn.write(JSON.stringify(out) + "\n");
      }
    });
    conn.on("error", () => { /* a client that hangs up mid-request is not our problem */ });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, async () => {
      // The socket's permissions ARE the access control: there is no
      // authentication inside the protocol, deliberately, because a shared
      // secret in a config file on the same box is not one. 0600 means only the
      // account the store server runs as can ask for an address.
      try { await chmod(socketPath, 0o600); } catch { /* not all platforms */ }
      resolve(server);
    });
  });
}

// ---- CLI --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const identity = await StoreIdentity.fromFile(SEED_FILE);
  const handle = makeHandler({
    identity,
    personalCode: process.env.PERSONAL_CODE,
    indexStore: new IndexStore(DATA, identity.network),
    addressType: ADDRESS_TYPE,
  });
  await unlink(SOCKET).catch(() => {});
  await serve(handle, SOCKET);
  console.log(`gateway listening on ${SOCKET}`);
  console.log(`  store payment code  ${identity.paymentCode()}`);
  console.log(`  verify signatures at ${identity.notificationAddress()}`);
  console.log(`  paying into         ${process.env.PERSONAL_CODE?.slice(0, 16)}…`);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => { await unlink(SOCKET).catch(() => {}); process.exit(0); });
  }
}
