// The backend's only knowledge that the gateway exists.
//
// One request, one line of JSON, one line back, close. The gateway speaks
// newline-delimited JSON over a unix socket whose permissions ARE the access
// control — 0600, owned by the account both processes run as — so there is no
// authentication inside the protocol and none is invented here. If this client
// can open the socket it is already the store server; if it cannot, no token
// would have helped.
//
// Deliberately connectionless: a fresh socket per request rather than a pooled
// one. The traffic is a handful of admin calls and an address per checkout, and
// a pool would buy nothing except a class of bug where a half-read reply from
// one request is returned to the next.

import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the gateway listens. Both processes must agree, hence one default. */
export const GATEWAY_SOCKET = process.env.GATEWAY_SOCKET
  || path.join(process.env.GATEWAY_DATA || path.join(ROOT, "gateway", "data"), "gateway.sock");

export class GatewayUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayUnavailable";
  }
}

/**
 * Ask the gateway one thing.
 *
 * Rejects with GatewayUnavailable when the socket is not there or does not
 * answer, so a caller can tell "the gateway is down" from "the gateway said
 * no" — the first is an operator problem with a remedy, the second is a
 * refusal that should be shown as it was written.
 */
export function ask(req, { socketPath = GATEWAY_SOCKET, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; try { sock.destroy(); } catch {} fn(arg); } };

    const sock = net.connect(socketPath);
    let buf = "";

    const timer = setTimeout(
      () => done(reject, new GatewayUnavailable(`the gateway at ${socketPath} did not answer within ${timeoutMs}ms`)),
      timeoutMs);

    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) {
        // A reply larger than this is not a reply; refuse rather than grow.
        if (buf.length > 256 * 1024) { clearTimeout(timer); done(reject, new Error("the gateway sent an oversized reply")); }
        return;
      }
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(buf.slice(0, nl)); }
      catch (e) { return done(reject, new Error(`the gateway sent something that is not JSON: ${e.message}`)); }
      done(resolve, parsed);
    });
    sock.on("error", (/** @type {NodeJS.ErrnoException} */ e) => {
      clearTimeout(timer);
      // ENOENT is the ordinary case: the gateway is not running, or is running
      // somewhere this process cannot see. Say which, since both are fixable
      // and the fixes differ.
      done(reject, new GatewayUnavailable(
        e.code === "ENOENT"
          ? `no gateway socket at ${socketPath}: is mise-gateway.service running, and does it share GATEWAY_DATA with this process?`
          : `cannot reach the gateway at ${socketPath}: ${e.message}`));
    });
    sock.on("close", () => {
      clearTimeout(timer);
      done(reject, new GatewayUnavailable("the gateway closed the connection without answering"));
    });
  });
}
