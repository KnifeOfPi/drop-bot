// Server-side helper for talking to the drop-bot daemon.
// Adds the shared DAEMON_TOKEN (must match the daemon's .env) and a timeout.

export const DAEMON_URL = process.env.DAEMON_URL || "http://localhost:4200";
const DAEMON_TOKEN = process.env.DAEMON_TOKEN || "";

export async function daemonFetch(path: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (DAEMON_TOKEN) headers.set("Authorization", `Bearer ${DAEMON_TOKEN}`);
  try {
    return await fetch(`${DAEMON_URL}${path}`, { ...init, headers, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timeout);
  }
}
