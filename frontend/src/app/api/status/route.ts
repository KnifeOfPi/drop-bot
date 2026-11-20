// API route: GET /api/status
// Proxies to the daemon's HTTP health endpoint and enriches with
// product stock data for the dashboard UI.
//
// The daemon exposes a simple HTTP server on DAEMON_PORT (default 4200)
// that returns in-memory state. This API route proxies and transforms
// the response for the frontend.

import { NextResponse } from "next/server";
import { daemonFetch } from "@/lib/daemon";

// Fallback mock data when daemon is unreachable — shows "offline" state
// rather than a blank page
const FALLBACK = {
  running: false,
  uptime_seconds: 0,
  tick_count: 0,
  pid: 0,
  products: [],
  retailers: [
    { retailer: "target", errors: 0, max_errors: 10, last_tick: null },
    { retailer: "best-buy", errors: 0, max_errors: 10, last_tick: null },
    { retailer: "pokemon-center", errors: 0, max_errors: 10, last_tick: null },
  ],
};

export async function GET() {
  try {
    const res = await daemonFetch("/status");

    if (!res.ok) {
      return NextResponse.json(FALLBACK, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(FALLBACK, { status: 200 });
  }
}