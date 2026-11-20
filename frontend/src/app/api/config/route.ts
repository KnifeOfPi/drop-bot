// API route: GET/PUT /api/config
// Reads and updates config.yaml on the daemon host.
// GET returns current config (sanitized — no secrets in response).
// PUT accepts partial config updates and writes back.

import { NextResponse } from "next/server";

const DAEMON_URL = process.env.DAEMON_URL || "http://localhost:4200";

export async function GET() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${DAEMON_URL}/config`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${DAEMON_URL}/config`, {
      method: "PUT",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    clearTimeout(timeout);
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