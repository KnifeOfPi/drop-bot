// Generic, allow-listed proxy to the daemon for dashboard actions:
//   GET  /api/d/live/frame?id=…          → JPEG of a handed-off browser tab
//   POST /api/d/flow/start               → { retailer, id, mode: 'assist' | 'dry_run' }
//   POST /api/d/checkout/test            → { retailer, id }  (dry run)
//   POST /api/d/drawing/enter            → { retailer, id }
//   POST /api/d/handoff/resolve          → { id, outcome: 'success' | 'abandoned' }
//   POST /api/d/live/input               → { id, type, … }
//   POST /api/d/discovery/run | discovery/watch
//   POST /api/d/accounts/login | done | check | cvv | proxy | proxy/test   (Accounts page)
// Protected by the dashboard auth middleware.

import { daemonFetch } from "@/lib/daemon";

// Opening a store's sign-in page / checking an account can take a while.
export const maxDuration = 60;

const ALLOWED: Record<string, string[]> = {
  GET: ["live/frame"],
  POST: [
    "flow/start", "checkout/test", "drawing/enter", "handoff/resolve", "live/input", "discovery/run", "discovery/watch",
    "accounts/login", "accounts/done", "accounts/check", "accounts/cvv", "accounts/proxy", "accounts/proxy/test", "pause",
  ],
};

async function forward(req: Request, method: "GET" | "POST", path: string[]) {
  const p = path.join("/");
  if (!ALLOWED[method].includes(p)) return Response.json({ error: "not found" }, { status: 404 });
  const search = new URL(req.url).search;
  try {
    const res = await daemonFetch(
      `/${p}${search}`,
      method === "POST"
        ? { method, headers: { "Content-Type": "application/json" }, body: await req.text() }
        : { method },
      p === "live/input" ? 15000 : p.startsWith("accounts/") ? 60000 : 8000,
    );
    const headers = new Headers({ "Cache-Control": "no-store" });
    for (const h of ["content-type", "x-frame-width", "x-frame-height", "x-frame-url", "x-frame-title", "x-session-kind", "x-session-retailer"]) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(await res.arrayBuffer(), { status: res.status, headers });
  } catch {
    return Response.json({ error: "daemon unreachable" }, { status: 502 });
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, "GET", (await params).path);
}

export async function POST(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, "POST", (await params).path);
}
