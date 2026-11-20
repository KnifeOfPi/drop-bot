// API route: POST /api/checkout/test  { retailer, id }
// Asks the daemon to run a DRY RUN checkout (stops at Place order).

import { NextResponse } from "next/server";
import { daemonFetch } from "@/lib/daemon";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = await daemonFetch("/checkout/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retailer: body.retailer, id: body.id }),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "daemon unreachable" }, { status: 502 });
  }
}
