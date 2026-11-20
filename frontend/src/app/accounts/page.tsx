"use client";

// Accounts — sign in to each store from the dashboard (no command line needed).
// "Sign in" opens the store's login page in the bot's own browser profile and
// takes you to Live view, where you type your email / password / 2FA code.
// The session is saved on the bot's server and reused for queues and checkout.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type DaemonStatus, RETAILERS, ago, postJson } from "@/lib/types";

export default function Accounts() {
  const router = useRouter();
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [cvv, setCvv] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "unreachable");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const signIn = async (retailer: string) => {
    setBusy(retailer);
    setMsg((m) => ({ ...m, [retailer]: "Opening sign-in page…" }));
    const r = await postJson("/api/d/accounts/login", { retailer });
    setBusy(null);
    if (r.error) return setMsg((m) => ({ ...m, [retailer]: r.error! }));
    router.push(`/live?id=${encodeURIComponent((r as { id?: string }).id || "")}`);
  };

  const check = async (retailer: string) => {
    setBusy(retailer);
    setMsg((m) => ({ ...m, [retailer]: "Checking…" }));
    const r = await postJson("/api/d/accounts/check", { retailer });
    setBusy(null);
    setMsg((m) => ({ ...m, [retailer]: r.message || r.error || "" }));
    load();
  };

  const saveCvv = async (retailer: string, value: string) => {
    const r = await postJson("/api/d/accounts/cvv", { retailer, cvv: value });
    setMsg((m) => ({ ...m, [retailer]: r.message || r.error || "" }));
    if (!r.error) setCvv((c) => ({ ...c, [retailer]: "" }));
    load();
  };

  const accounts = status?.accounts || {};
  const watched = new Set((status?.products || []).map((p) => p.retailer));
  const openSessions = status?.login_sessions || [];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 font-mono">
      <header className="sticky top-0 z-20 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg sm:text-2xl font-bold flex items-center gap-2">🔐 <span>Store accounts</span></h1>
        <Link href="/" className="px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-400">← <span className="hidden sm:inline">Dashboard</span></Link>
      </header>

      <div className="p-4 sm:p-6 space-y-4 max-w-3xl">
        {error && <div className="p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-200 text-xs sm:text-sm">⚠️ Bot unreachable: {error}</div>}

        <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/40 text-[11px] sm:text-xs text-zinc-400 space-y-1">
          <p><b className="text-zinc-200">Sign in</b> opens the store&apos;s login page in the bot&apos;s browser. Type your email, password and any 2FA code in Live view — the login is saved on the bot&apos;s server and reused for queues and checkout.</p>
          <p>Make sure each account has a <b className="text-zinc-200">default shipping address and saved card</b>. Costco and Sam&apos;s need an active membership.</p>
        </div>

        {RETAILERS.map((r) => {
          const a = accounts[r.id];
          const session = openSessions.find((s) => s.retailer === r.id);
          const state = a?.logged_in === true ? { text: "✅ Signed in", cls: "text-green-300" }
            : a?.logged_in === false ? { text: "❌ Signed out", cls: "text-red-300" }
            : { text: "❔ Not checked", cls: "text-zinc-400" };
          return (
            <div key={r.id} className={`p-3 sm:p-4 rounded-lg border bg-zinc-900/50 ${watched.has(r.id) && a?.logged_in !== true ? "border-amber-700" : "border-zinc-800"}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-sm sm:text-base">{r.emoji} {r.name}</p>
                  <p className={`text-xs mt-0.5 ${state.cls}`}>
                    {state.text}
                    {a?.checked_at && <span className="text-zinc-600"> · checked {ago(a.checked_at)}</span>}
                  </p>
                  {a?.note && <p className="text-[10px] text-zinc-500 mt-0.5">{a.note}</p>}
                  {watched.has(r.id) && a?.logged_in !== true && <p className="text-[10px] text-amber-400 mt-0.5">You&apos;re watching products here — sign in so the bot can check out.</p>}
                </div>
                <div className="flex flex-col sm:flex-row gap-1.5 shrink-0">
                  {session ? (
                    <Link href={`/live?id=${encodeURIComponent(session.id)}`} className="px-3 py-2 rounded bg-yellow-500 text-black text-xs font-bold text-center">📱 Continue sign-in</Link>
                  ) : (
                    <button disabled={busy === r.id} onClick={() => signIn(r.id)} className="px-3 py-2 rounded bg-blue-700 hover:bg-blue-600 text-white text-xs font-bold disabled:opacity-40">
                      {a?.logged_in ? "Sign in again" : "Sign in"}
                    </button>
                  )}
                  <button disabled={busy === r.id} onClick={() => check(r.id)} className="px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs disabled:opacity-40">Check</button>
                </div>
              </div>

              <form
                className="mt-3 flex items-center gap-2"
                onSubmit={(e) => { e.preventDefault(); saveCvv(r.id, cvv[r.id] || ""); }}
              >
                <label className="text-[10px] text-zinc-500 uppercase shrink-0">Card CVV</label>
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                  value={cvv[r.id] || ""}
                  onChange={(e) => setCvv((c) => ({ ...c, [r.id]: e.target.value.replace(/\D/g, "") }))}
                  placeholder={a?.cvv_set ? "•••  saved" : "3–4 digits"}
                  disabled={a?.cvv_source === "env"}
                  className="w-28 px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-sm outline-none focus:border-blue-500 disabled:opacity-50"
                />
                <button type="submit" disabled={!cvv[r.id] || a?.cvv_source === "env"} className="px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 disabled:opacity-40">Save</button>
                {a?.cvv_source === "dashboard" && (
                  <button type="button" onClick={() => saveCvv(r.id, "")} className="text-[10px] text-zinc-500 underline">remove</button>
                )}
                {a?.cvv_source === "env" && <span className="text-[10px] text-zinc-500">set in server .env</span>}
              </form>

              {msg[r.id] && <p className="text-[10px] text-blue-300 mt-2">{msg[r.id]}</p>}
            </div>
          );
        })}

        <p className="text-[10px] text-zinc-600">
          The CVV is stored only on the bot&apos;s server (never shown again) and typed in when a store asks for it at checkout.
          Sign-in status is a best guess from each store&apos;s account page.
        </p>
      </div>
    </main>
  );
}
