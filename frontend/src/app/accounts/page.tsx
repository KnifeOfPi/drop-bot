"use client";

// Accounts — sign in to each store from the dashboard (no command line needed).
// "Sign in" opens the store's login page in the bot's own browser profile and
// takes you to Live view, where you type your email / password / 2FA code.
// The session is saved on the bot's server and reused for queues and checkout.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type DaemonStatus, RETAILERS, ago, postJson, fmtBytes } from "@/lib/types";

export default function Accounts() {
  const router = useRouter();
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [cvv, setCvv] = useState<Record<string, string>>({});
  const [proxyInput, setProxyInput] = useState("");
  const [proxyMsg, setProxyMsg] = useState<string | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [limitInput, setLimitInput] = useState("");

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

  const saveProxy = async (value: string) => {
    setProxyBusy(true);
    setProxyMsg(value ? "Saving…" : "Removing…");
    const r = await postJson("/api/d/accounts/proxy", { url: value });
    setProxyBusy(false);
    setProxyMsg(r.message || r.error || null);
    if (!r.error) setProxyInput("");
    load();
  };

  const testProxy = async () => {
    setProxyBusy(true);
    setProxyMsg("Testing — opening a page through the proxy…");
    const r = await postJson("/api/d/accounts/proxy/test", {});
    setProxyBusy(false);
    setProxyMsg(r.message || r.error || null);
  };

  const saveLimit = async () => {
    const mb = Math.max(0, Math.round(Number(limitInput)));
    if (Number.isNaN(mb)) return;
    const res = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monitor: { daily_proxy_limit_mb: mb } }) });
    setProxyMsg(res.ok ? (mb ? `Daily limit set to ${mb} MB` : "Daily limit off") : "Couldn't save");
    setLimitInput("");
    load();
  };

  const setProxyStores = async (stores: string[] | null) => {
    const res = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ checkout: { proxy_stores: stores } }) });
    setProxyMsg(res.ok ? "Saved — idle store browsers restarted with the new setting" : "Couldn't save");
    load();
  };

  const proxy = status?.proxy;
  const bw = status?.bandwidth;
  const proxyStores = proxy?.stores ?? RETAILERS.map((r) => r.id);
  const accounts = status?.accounts || {};
  const watched = new Set((status?.products || []).map((p) => p.retailer));
  const openSessions = status?.login_sessions || [];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-20 pokedex-header px-4 py-3 flex items-center justify-between">
        <h1 className="flex items-center gap-2.5 font-semibold tracking-tight"><span className="pokeball text-xl" aria-hidden />Store accounts</h1>
        <Link href="/" className="px-2 sm:px-3 py-1.5 rounded-2xl text-xs sm:text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-400">← <span className="hidden sm:inline">Dashboard</span></Link>
      </header>

      <div className="p-4 sm:p-6 space-y-4 max-w-3xl">
        {error && <div className="p-3 bg-red-900/50 border border-red-700 rounded-2xl text-red-200 text-xs sm:text-sm">⚠️ Bot unreachable: {error}</div>}
        {status?.pause?.paused && (
          <div className="p-3 rounded-2xl border border-zinc-600 bg-zinc-900 text-[11px] sm:text-xs text-zinc-300">
            ⏸ The bot is paused. You can still <b>sign in</b>, <b>check</b> accounts and <b>test the proxy</b> here — each opens that
            store&apos;s browser just for that and closes it again. Watching and checkout stay off until you tap Resume on the dashboard.
          </div>
        )}

        <div className="p-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 text-[11px] sm:text-xs text-zinc-400 space-y-1">
          <p><b className="text-zinc-200">Sign in</b> opens the store&apos;s login page in the bot&apos;s browser. Type your email, password and any 2FA code in Live view — the login is saved on the bot&apos;s server and reused for queues and checkout.</p>
          <p>Make sure each account has a <b className="text-zinc-200">default shipping address and saved card</b>. Costco and Sam&apos;s need an active membership.</p>
          <p>Use <b className="text-zinc-200">password</b> sign-in — passkeys can&apos;t reach your phone from the server&apos;s browser.</p>
        </div>

        {/* ── Proxy ── */}
        <div className="p-3 sm:p-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-sm sm:text-base">🌐 Proxy</p>
              <p className="text-xs mt-0.5">
                {proxy?.set
                  ? <span className="text-green-300">✅ {proxy.server}{proxy.user ? ` · user ${proxy.user}` : ""}{proxy.source === "env" ? " · from server .env" : ""}</span>
                  : <span className="text-zinc-400">Not set — stores see your server&apos;s own IP</span>}
              </p>
            </div>
            <button disabled={proxyBusy} onClick={testProxy} className="shrink-0 px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs disabled:opacity-40">Test</button>
          </div>
          {proxy?.source !== "env" && (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (proxyInput) saveProxy(proxyInput); }}>
              <input
                type="password"
                autoComplete="off"
                value={proxyInput}
                onChange={(e) => setProxyInput(e.target.value)}
                placeholder={proxy?.set ? "Paste a new proxy to replace it" : "host:port:user:pass  or  http://user:pass@host:port"}
                className="flex-1 min-w-0 px-2 py-1.5 rounded-xl bg-zinc-800 border border-zinc-700 text-xs outline-none focus:border-blue-500"
              />
              <button type="submit" disabled={!proxyInput || proxyBusy} className="px-3 py-1.5 rounded-xl bg-blue-700 hover:bg-blue-600 text-white text-xs disabled:opacity-40">Save</button>
              {proxy?.set && <button type="button" disabled={proxyBusy} onClick={() => saveProxy("")} className="text-[10px] text-zinc-500 underline">remove</button>}
            </form>
          )}
          {proxy?.set && (
            <div>
              <p className="text-[10px] text-zinc-500 uppercase mb-1">Use it for</p>
              <div className="flex flex-wrap gap-1">
                {RETAILERS.map((r) => {
                  const on = proxyStores.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      onClick={() => {
                        const next = on ? proxyStores.filter((x) => x !== r.id) : [...proxyStores, r.id];
                        setProxyStores(next.length === RETAILERS.length ? null : next);
                      }}
                      className={`px-2 py-1 rounded-xl text-[10px] sm:text-xs ${on ? "bg-blue-700 text-white" : "bg-zinc-800 text-zinc-500"}`}
                    >{r.emoji} {r.name}</button>
                  );
                })}
              </div>
            </div>
          )}
          {proxyMsg && <p className="text-[10px] text-blue-300">{proxyMsg}</p>}
          {bw && (
            <div className="pt-2 border-t border-zinc-800">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] text-zinc-500 uppercase">Data used today</p>
                <p className="text-[10px] text-zinc-400">
                  proxy <b className="text-zinc-200">{fmtBytes(bw.proxy_today)}</b>{bw.limit_mb ? ` of ${bw.limit_mb} MB` : ""} · all {fmtBytes(bw.total_today)}
                </p>
              </div>
              <p className="text-[10px] text-zinc-400 mb-1">
                Last hour via proxy: <b className="text-zinc-200">{fmtBytes(bw.proxy_last_hour)}</b>
                {" "}(≈ {fmtBytes((bw.proxy_last_hour || 0) * 24)}/day at this pace)
              </p>
              <form className="flex items-center gap-2 mb-2" onSubmit={(e) => { e.preventDefault(); saveLimit(); }}>
                <label className="text-[10px] text-zinc-500 uppercase shrink-0">Daily limit (MB)</label>
                <input
                  inputMode="numeric"
                  value={limitInput}
                  onChange={(e) => setLimitInput(e.target.value.replace(/\D/g, ""))}
                  placeholder={bw.limit_mb ? String(bw.limit_mb) : "off"}
                  className="w-20 px-2 py-1 rounded-xl bg-zinc-800 border border-zinc-700 text-xs outline-none focus:border-blue-500"
                />
                <button type="submit" disabled={!limitInput} className="px-2 py-1 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 disabled:opacity-40">Set</button>
                <span className="text-[10px] text-zinc-600">pauses the bot when reached · 0 = off</span>
              </form>
              <table className="w-full text-[10px] sm:text-xs">
                <thead className="text-zinc-600">
                  <tr><th className="text-left font-normal">Store</th><th className="text-right font-normal">Watching</th><th className="text-right font-normal">Search</th><th className="text-right font-normal">Checkout/sign-in</th></tr>
                </thead>
                <tbody>
                  {RETAILERS.filter((r) => bw.stores[r.id]).map((r) => {
                    const u = bw.stores[r.id];
                    return (
                      <tr key={r.id} className={u.via_proxy ? "text-zinc-300" : "text-zinc-500"}>
                        <td>{r.emoji} {r.name}{u.via_proxy ? "" : " (direct)"}</td>
                        <td className="text-right">{fmtBytes(u.monitor)}</td>
                        <td className="text-right">{fmtBytes(u.discovery)}</td>
                        <td className="text-right">{fmtBytes(u.flow)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {bw.days.length > 1 && (
                <p className="text-[10px] text-zinc-600 mt-1">
                  Last {bw.days.length} days: {bw.days.map((d) => `${d.day.slice(5)} ${fmtBytes(d.total)}`).join(" · ")}
                </p>
              )}
            </div>
          )}
          <p className="text-[10px] text-zinc-600">
            Use a residential proxy with a <b>sticky session</b> (same IP for 30+ min) so store logins aren&apos;t re-challenged.
            Sign in to stores <i>after</i> setting the proxy. Watching skips images to save proxy data.
          </p>
        </div>

        {RETAILERS.map((r) => {
          const a = accounts[r.id];
          const session = openSessions.find((s) => s.retailer === r.id);
          const state = a?.logged_in === true ? { text: "✅ Signed in", cls: "text-green-300" }
            : a?.logged_in === false ? { text: "❌ Signed out", cls: "text-red-300" }
            : { text: "❔ Not checked", cls: "text-zinc-400" };
          return (
            <div key={r.id} className={`p-3 sm:p-4 rounded-2xl border bg-zinc-900/50 ${watched.has(r.id) && a?.logged_in !== true ? "border-amber-700" : "border-zinc-800"}`}>
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
                    <Link href={`/live?id=${encodeURIComponent(session.id)}`} className="px-3 py-2 rounded-xl bg-yellow-500 text-black text-xs font-bold text-center">📱 Continue sign-in</Link>
                  ) : (
                    <button disabled={busy === r.id} onClick={() => signIn(r.id)} className="px-3 py-2 rounded-xl bg-blue-700 hover:bg-blue-600 text-white text-xs font-bold disabled:opacity-40">
                      {a?.logged_in ? "Sign in again" : "Sign in"}
                    </button>
                  )}
                  <button disabled={busy === r.id} onClick={() => check(r.id)} className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs disabled:opacity-40">Check</button>
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
                  className="w-28 px-2 py-1.5 rounded-xl bg-zinc-800 border border-zinc-700 text-sm outline-none focus:border-blue-500 disabled:opacity-50"
                />
                <button type="submit" disabled={!cvv[r.id] || a?.cvv_source === "env"} className="px-2 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 disabled:opacity-40">Save</button>
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
