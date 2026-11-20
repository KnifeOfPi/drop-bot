// API route: GET/PUT /api/config
// Reads and updates config.yaml on the daemon host.
// GET returns current config (sanitized — no secrets in response).
// PUT accepts partial config updates and writes back.

import { NextResponse } from "next/server";
import { daemonFetch } from "@/lib/daemon";

export async function GET() {
  try {
    const res = await daemonFetch("/config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "daemon unreachable" }, { status: 502 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const res = await daemonFetch("/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: err }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "daemon unreachable" }, { status: 502 });
  }
}