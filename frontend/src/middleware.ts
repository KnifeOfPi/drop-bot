// Auth middleware — simple password gate for single-user dashboard.
// Set DASHBOARD_PASSWORD in Vercel env vars.
// Stores a signed cookie so you only enter the password once per browser.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE_NAME = "dropbot_auth";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year
const SECRET = process.env.DASHBOARD_PASSWORD || "mattiscloseted";

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

  // Skip auth for static assets and API routes
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/api")
  ) {
    return NextResponse.next();
  }

  // If already authenticated, pass through
  if (await validCookie(req)) return NextResponse.next();

  // Check for password submission
  if (req.method === "POST" && pathname === "/login") {
    const password = req.nextUrl.searchParams.get("p");
    if (password === SECRET) {
      const ts = Date.now().toString();
      const hash = sign(ts);
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
    return NextResponse.redirect(new URL("/login?error=1", req.url));
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