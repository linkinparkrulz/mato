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
import { addressFor, parseAddressType, DEFAULT_ADDRESS_TYPE } from "./derive.ts";
import { IndexStore } from "./index-state.ts";
import {
  loadOrCreate, saveState, revealMnemonic, bindReceiver, setActive, setDojo, readiness,
} from "./bootstrap.ts";

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
export function makeHandler({ identity, personalCode, indexStore, addressType = DEFAULT_ADDRESS_TYPE, shop = null }) {
  const network = identity.network;

  /**
   * The receiver, resolved per request rather than fixed at construction.
   *
   * It used to be required here and the gateway refused to start without it.
   * That cannot stand now the panel is how an operator sets it: a gateway that
   * will not boot without a receiver can never be configured through the
   * interface that sets receivers. So it boots, answers the identity ops, and
   * refuses only the ops that actually need a chain to derive on.
   *
   * State wins over the environment variable where both exist, because the
   * panel is the live source and PERSONAL_CODE is a headless convenience.
   */
  const receiver = () => (shop ? shop.state().networks[network]?.receiverPaymentCode : null) || personalCode || null;

  const needReceiver = () => ({
    error: "this shop has no receiver yet: bind the operator's personal payment code " +
      `for ${network} before asking for an address, or every payment would derive on a chain nobody owns`,
  });

  // Deriving and signing one index, in one place, so "next" and "peek" cannot
  // drift into producing different records for the same index.
  const recordFor = (index, personal) => identity.signAddress({
    v: 1,
    address: addressFor(identity.code, personal, index, addressType, network),
    index,
    type: addressType,
    network,
    paymentCode: identity.paymentCode(),
  });

  return async function handle(req) {
    switch (req && req.op) {
      case "next": {
        const personal = receiver();
        if (!personal) return needReceiver();
        const index = await indexStore.allocate();
        return recordFor(index, personal);
      }
      case "peek": {
        const personal = receiver();
        if (!personal) return needReceiver();
        if (!Number.isInteger(req.index) || req.index < 0) {
          return { error: "peek needs a non-negative integer index" };
        }
        return recordFor(req.index, personal);
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
          personalCode: receiver(),
          type: addressType,
          network,
          ...(await indexStore.status()),
        };
      }
      // ---- identity management -------------------------------------------
      // Present only when the gateway owns a shop identity. The self-test drives
      // the derivation ops with a throwaway wallet and no shop, so these are
      // absent there rather than stubbed.
      case "identity": {
        if (!shop) return { error: "this gateway was not started with a shop identity" };
        return shop.identity();
      }
      case "bind-receiver": {
        if (!shop) return { error: "this gateway was not started with a shop identity" };
        return await shop.bindReceiver(req.network, req.code);
      }
      case "set-active": {
        if (!shop) return { error: "this gateway was not started with a shop identity" };
        return await shop.setActive(req.network);
      }
      case "set-dojo": {
        if (!shop) return { error: "this gateway was not started with a shop identity" };
        return await shop.setDojo(req.network, req.dojo);
      }
      // The only op that discloses the seed. Separate from "identity" so the
      // one code path that can hand over the words is the one asked for exactly
      // that, and so nothing that merely reads status can leak them.
      case "reveal-seed": {
        if (!shop) return { error: "this gateway was not started with a shop identity" };
        return { mnemonic: await shop.revealSeed() };
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

/**
 * The shop's identity, as the handler's ops see it.
 *
 * A thin object over bootstrap.ts holding the loaded state in memory and
 * persisting every change, so the socket ops stay declarative and all the
 * refusals — a receiver that is not a payment code, one that is the shop's own,
 * one changed after the notification is on-chain — live in bootstrap.ts where
 * they are tested, rather than being restated here.
 */
export function makeShop({ dataDir, state, identities }) {
  let current = state;
  return {
    state: () => current,
    identity() {
      return {
        active: current.active,
        createdAt: current.createdAt,
        networks: Object.fromEntries(Object.entries(current.networks).map(([n, b]) => [
          n, { ...b, readiness: readiness(current, /** @type {any} */ (n)) },
        ])),
      };
    },
    async bindReceiver(network, code) {
      current = bindReceiver(current, network, code);
      await saveState(dataDir, current);
      return { ok: true, network, ...current.networks[network] };
    },
    async setActive(network) {
      current = setActive(current, network);
      await saveState(dataDir, current);
      // The running process derives on the network it booted with, so a switch
      // takes effect when it restarts. Said plainly rather than silently
      // continuing to quote on the old chain.
      return { ok: true, active: current.active, restartRequired: true };
    },
    async setDojo(network, dojo) {
      current = setDojo(current, network, dojo);
      await saveState(dataDir, current);
      return { ok: true, network, dojo: current.networks[network].dojo };
    },
    revealSeed: () => revealMnemonic(dataDir),
    identities,
  };
}

// ---- CLI --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  // Generating here rather than in a separate setup command an operator could
  // forget: a shop with no identity cannot quote an address, so the first start
  // makes one. Both networks are derived; this process serves the active one.
  const { identities, state, created } = await loadOrCreate(DATA);
  const identity = identities[state.active];
  const shop = makeShop({ dataDir: DATA, state, identities });
  const handle = makeHandler({
    identity,
    personalCode: process.env.PERSONAL_CODE,
    indexStore: new IndexStore(DATA, state.active),
    addressType: ADDRESS_TYPE,
    shop,
  });
  await unlink(SOCKET).catch(() => {});
  await serve(handle, SOCKET);
  const block = state.networks[state.active];
  const personal = block.receiverPaymentCode || process.env.PERSONAL_CODE || null;
  console.log(`gateway listening on ${SOCKET}`);
  if (created) console.log("  generated a new shop identity; back up the seed words from the admin panel");
  console.log(`  network             ${state.active}`);
  console.log(`  store payment code  ${identity.paymentCode()}`);
  console.log(`  fund / verify at    ${identity.notificationAddress()}`);
  console.log(personal
    ? `  paying into         ${personal.slice(0, 16)}…`
    : "  paying into         (no receiver yet — bind one in the admin panel; addresses are refused until then)");
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => { await unlink(SOCKET).catch(() => {}); process.exit(0); });
  }
}
