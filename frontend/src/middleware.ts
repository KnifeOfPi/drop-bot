// Auth middleware — simple password gate for single-user dashboard.
// Set DASHBOARD_PASSWORD in Vercel env vars. There is deliberately no fallback:
// without it the dashboard refuses every request instead of accepting a known password.
// Stores a signed cookie so you only enter the password once per browser.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE_NAME = "dropbot_auth";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year
const SECRET = process.env.DASHBOARD_PASSWORD || "";

async function sign(val: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(val));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function validCookie(req: NextRequest): Promise<boolean> {
  const cookie = req.cookies.get(COOKIE_NAME);
  if (!cookie?.value) return false;
  const [ts, hash] = cookie.value.split(".");
  if (!ts || !hash) return false;
  return hash === await sign(ts);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method;

  // Skip auth for static assets
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  // Fail closed when no password is configured.
  if (!SECRET) {
    const msg = "Dashboard locked: DASHBOARD_PASSWORD is not set on the server.";
    if (pathname.startsWith("/api")) return NextResponse.json({ error: msg }, { status: 503 });
    return new NextResponse(msg, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  // If already authenticated, pass through
  if (await validCookie(req)) return NextResponse.next();

  // API routes require the auth cookie too — they can change config and arm
  // auto-checkout. The dashboard's same-origin fetches send the cookie.
  if (pathname.startsWith("/api")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Check for password submission (GET with ?p= param)
  if (method === "GET" && pathname === "/login") {
    const password = req.nextUrl.searchParams.get("p");
    if (password === SECRET) {
      const ts = Date.now().toString();
      const hash = await sign(ts);
      const res = NextResponse.redirect(new URL("/", req.url));
      res.cookies.set(COOKIE_NAME, `${ts}.${hash}`, {
        maxAge: COOKIE_MAX_AGE,
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      });
      return res;
    }
    // Wrong password — redirect back to login with error
    if (password && password !== SECRET) {
      return NextResponse.redirect(new URL("/login?error=1", req.url));
    }
  }

  // Not authenticated — show login page
  if (pathname !== "/login") {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};