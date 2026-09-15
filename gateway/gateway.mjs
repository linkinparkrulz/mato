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
export function makeHandler({
  identity = null, personalCode = null, indexStore = null,
  addressType = DEFAULT_ADDRESS_TYPE, shop = null, indexStores = null,
}) {
  // Two shapes, not five optional arguments that might combine into anything:
  // either a `shop` with `indexStores` keyed by network, which follows the
  // shop's active chain, or a single `identity` with a single `indexStore`,
  // which is a wallet with no shop state and cannot switch.
  if (!shop && (!identity || !indexStore)) {
    throw new Error("a gateway needs either a shop with per-network index stores, or one identity and one index store");
  }
  /**
   * Which chain this request runs on, resolved per request.
   *
   * A gateway that owns a shop follows the shop's ACTIVE network and re-reads it
   * every time. Capturing it at construction is what made "set-active" report
   * restartRequired, and a switch that needs a restart is one an operator makes
   * and then watches not happen — the panel said testnet4, the process kept
   * quoting mainnet, and nothing in between said so.
   *
   * A gateway with no shop is the self-test's throwaway wallet: one identity,
   * one store, no state to consult. Kept because it is what proves derivation
   * works with no shop at all.
   */
  const active = () => {
    if (!shop) return { id: identity, network: identity.network, store: indexStore };
    const network = shop.state().active;
    const id = shop.identities[network];
    const store = indexStores && indexStores[network];
    if (!id || !store) {
      // Not reachable through the socket: set-active refuses an unknown network
      // before it is ever stored. If it happens, a hand-edited state file has
      // named a chain this build does not derive, and deriving on the wrong one
      // would be worse than refusing.
      throw new Error(`this gateway has no identity or index store for ${network}`);
    }
    return { id, network, store };
  };

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
  const receiver = (network) =>
    (shop ? shop.state().networks[network]?.receiverPaymentCode : null) || personalCode || null;

  const needReceiver = (network) => ({
    error: "this shop has no receiver yet: bind the operator's personal payment code " +
      `for ${network} before asking for an address, or every payment would derive on a chain nobody owns`,
  });

  // Deriving and signing one index, in one place, so "next" and "peek" cannot
  // drift into producing different records for the same index.
  const recordFor = ({ id, network }, index, personal) => id.signAddress({
    v: 1,
    address: addressFor(id.code, personal, index, addressType, network),
    index,
    type: addressType,
    network,
    paymentCode: id.paymentCode(),
  });

  return async function handle(req) {
    switch (req && req.op) {
      case "next": {
        const cur = active();
        const personal = receiver(cur.network);
        if (!personal) return needReceiver(cur.network);
        const index = await cur.store.allocate();
        return recordFor(cur, index, personal);
      }
      case "peek": {
        const cur = active();
        const personal = receiver(cur.network);
        if (!personal) return needReceiver(cur.network);
        if (!Number.isInteger(req.index) || req.index < 0) {
          return { error: "peek needs a non-negative integer index" };
        }
        return recordFor(cur, req.index, personal);
      }
      case "release": {
        if (!Number.isInteger(req.index)) return { error: "release needs an integer index" };
        return { ok: await active().store.release(req.index) };
      }
      case "settle": {
        if (!Number.isInteger(req.index)) return { error: "settle needs an integer index" };
        return { ok: await active().store.settle(req.index) };
      }
      case "status": {
        const { id, network, store } = active();
        return {
          paymentCode: id.paymentCode(),
          notificationAddress: id.notificationAddress(),
          // Where the operator funds this bot. Absent on a gateway started
          // without a shop identity — the self-test drives derivation with a
          // throwaway wallet that has no deposit chain and needs none.
          depositAddress: shop ? shop.state().networks[network]?.depositAddress ?? null : null,
          personalCode: receiver(network),
          type: addressType,
          network,
          ...(await store.status()),
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
      // Live. The handler reads state().active on every request, so the next
      // address quoted is already on the new chain. This used to report
      // restartRequired, which meant an operator could switch the panel and
      // watch the process keep quoting the old chain with nothing saying so.
      return { ok: true, active: current.active };
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
  // One store per chain, built once and kept. IndexStore caches its state in
  // memory after the first load, so a second instance over the same file would
  // hand out an index the first has already issued — the failure index-state.ts
  // exists to prevent. Constructing them per request would do exactly that as
  // soon as the network became switchable.
  const indexStores = Object.fromEntries(
    Object.keys(identities).map((n) => [n, new IndexStore(DATA, n)]));
  const handle = makeHandler({
    // No `identity`: with a shop present the handler resolves it from
    // state().active per request, so passing one here would only suggest the
    // boot network still decided something.
    personalCode: process.env.PERSONAL_CODE,
    indexStores,
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
  // Two lines, not one. They were one line while the funding target was wrongly
  // the notification address; they are different addresses doing different jobs.
  console.log(`  fund at             ${block.depositAddress}`);
  console.log(`  verify against      ${identity.notificationAddress()}`);
  console.log(personal
    ? `  paying into         ${personal.slice(0, 16)}…`
    : "  paying into         (no receiver yet — bind one in the admin panel; addresses are refused until then)");
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => { await unlink(SOCKET).catch(() => {}); process.exit(0); });
  }
}
