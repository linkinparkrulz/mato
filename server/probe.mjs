// On-demand Tor reachability check, reusing the exact probe from the updater so
// the self-service "connection gate" and the cron checker agree.
export { probe, socks5Connect } from "../scripts/update.mjs";

export const PROBE_CFG = {
  proxyHost: process.env.TOR_SOCKS_HOST || "127.0.0.1",
  proxyPort: +(process.env.TOR_SOCKS_PORT || 9050),
  timeoutMs: +(process.env.TIMEOUT_MS || 30000),
  connectOnly: process.env.CONNECT_ONLY === "1",
};
