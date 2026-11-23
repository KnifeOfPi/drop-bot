"use client";

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import {
  type DaemonStatus, type ProductStatus, type Attempt,
  RETAILERS, retailerInfo, ACTION_LABELS, ago, postJson, fmtBytes,
} from "@/lib/types";

const STATUS_BADGE: Record<string, { text: string; cls: string }> = {
  in_stock: { text: "🟢 IN STOCK", cls: "bg-green-900/60 text-green-300" },
  queue: { text: "🔵 QUEUE LIVE", cls: "bg-blue-900/60 text-blue-200" },
  drawing_open: { text: "🎟️ DRAWING OPEN", cls: "bg-purple-900/60 text-purple-200" },
  drawing_entered: { text: "✅ ENTERED", cls: "bg-purple-900/40 text-purple-300" },
  oos: { text: "🔴 OOS", cls: "bg-zinc-800 text-zinc-400" },
  blocked: { text: "🧱 BLOCKED", cls: "bg-amber-900/40 text-amber-300" },
  error: { text: "⚠️ ERROR", cls: "bg-red-900/40 text-red-300" },
  unknown: { text: "⚪ UNKNOWN", cls: "bg-yellow-900/30 text-yellow-300" },
  pending: { text: "… WAITING", cls: "bg-zinc-800 text-zinc-500" },
};

const ATTEMPT_STYLE: Record<string, { icon: string; cls: string; label: string }> = {
  success: { icon: "✅", cls: "text-green-300", label: "ORDERED" },
  unconfirmed: { icon: "❓", cls: "text-amber-300", label: "UNCONFIRMED" },
  handoff: { icon: "🙋", cls: "text-yellow-300", label: "HANDED TO YOU" },
  dry_run: { icon: "🧪", cls: "text-blue-300", label: "DRY RUN OK" },
  failed: { icon: "❌", cls: "text-red-300", label: "FAILED" },
  guard: { icon: "🛑", cls: "text-zinc-300", label: "BLOCKED" },
  drawing_entered: { icon: "🎟️", cls: "text-purple-300", label: "DRAWING ENTERED" },
  drawing_manual: { icon: "🎟️", cls: "text-yellow-300", label: "ENTER DRAWING YOURSELF" },
  abandoned: { icon: "↩️", cls: "text-zinc-400", label: "NOT BOUGHT" },
  handoff_expired: { icon: "⌛", cls: "text-zinc-400", label: "HAND-OFF EXPIRED" },
  handoff_closed: { icon: "🚪", cls: "text-zinc-400", label: "HAND-OFF CLOSED" },
};

function mins(ms: number) {
  const m = Math.max(0, Math.round(ms / 60000));
  return `${m}m`;
}

export default function Dashboard() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number>(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<string>("all");

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setError(null);
      setLastFetch(Date.now());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "unreachable");
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const act = async (k: string, path: string, body: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setMsg((m) => ({ ...m, [k]: "…" }));
    const r = await postJson(path, body);
    setMsg((m) => ({ ...m, [k]: r.message || r.error || "done" }));
    fetchStatus();
  };

  const paused = !!status?.pause?.paused;
  const [pausing, setPausing] = useState(false);
  const togglePause = async () => {
    const next = !paused;
    if (next && !window.confirm("Pause the bot? Every store browser closes — no watching, queues, checkout or proxy data until you resume. Open hand-offs are closed."))
      return;
    if (!next && !window.confirm("Resume the bot? Store browsers reopen and watching (and proxy data use) starts again."))
      return;
    setPausing(true);
    const r = await postJson("/api/d/pause", { paused: next });
    setPausing(false);
    setMsg((m) => ({ ...m, pause: r.message || r.error || "" }));
    fetchStatus();
  };

  const co = status?.checkout;
  const disc = status?.discovery;
  const mode = !co ? null : !co.enabled ? "off" : co.dry_run ? "dry" : "live";
  const modeBadge =
    mode === "live" ? { text: "🛒 AUTO-BUY ON", cls: "bg-red-700 text-white" }
    : mode === "dry" ? { text: "🙋 HAND-OFF MODE", cls: "bg-blue-800 text-blue-100" }
    : mode === "off" ? { text: "⏸ ALERTS ONLY", cls: "bg-zinc-800 text-zinc-400" }
    : null;
  const uptime = status ? `${Math.floor(status.uptime_seconds / 3600)}h ${Math.floor((status.uptime_seconds % 3600) / 60)}m` : "—";
  const handoffs = co?.handoffs ?? [];
  const needsLogin = [...new Set((status?.products ?? []).filter((p) => p.action !== "notify").map((p) => p.retailer))]
    .filter((r) => status?.accounts?.[r]?.logged_in !== true);
  const busy = Object.entries(co?.busy ?? {});
  const products = (status?.products ?? []).filter((p) => filter === "all" || p.retailer === filter);
  const hot = (s: string) => ["in_stock", "queue", "drawing_open"].includes(s);
  products.sort((a, b) => Number(hot(b.status)) - Number(hot(a.status)));

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-20 pokedex-header px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-2xl font-bold flex items-center gap-2">
              <span className="pokeball text-xl sm:text-2xl" aria-hidden />
              <span>Drop Bot</span>
            </h1>
            <p className="text-zinc-500 text-xs mt-0.5 hidden sm:block">
              {status ? `${status.products.length} products · ${status.retailers.length} stores` : "Loading..."}
            </p>
          </div>
          <div className="flex items-center gap-2 sm:gap-4 text-sm">
            <span className={`w-2 h-2 rounded-full ${status?.running ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
            <span className="hidden sm:inline text-zinc-400">{status?.running ? `Up ${uptime}` : "Offline"}</span>
            {status && (
              <button
                onClick={togglePause}
                disabled={pausing}
                className={`px-2 sm:px-3 py-1 rounded-xl text-[10px] sm:text-xs font-bold whitespace-nowrap disabled:opacity-50 ${
                  paused ? "bg-green-700 hover:bg-green-600 text-white" : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200"}`}
              >
                {pausing ? "…" : paused ? "▶ Resume" : "⏸ Pause"}
              </button>
            )}
            {modeBadge && !paused && (
              <Link href="/settings?tab=checkout" className={`px-2 py-0.5 rounded-xl text-[10px] sm:text-xs font-bold whitespace-nowrap ${modeBadge.cls}`}>
                {modeBadge.text}
              </Link>
            )}
            <Link href="/accounts" className="hidden sm:inline px-3 py-1 rounded-xl text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-400">🔐 Accounts</Link>
            <Link href="/settings" className="hidden sm:inline px-3 py-1 rounded-xl text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-400">⚙️ Settings</Link>
            <button onClick={() => setMenuOpen(!menuOpen)} className="sm:hidden p-2 rounded-xl hover:bg-zinc-800">
              <span className="text-lg">{menuOpen ? "✕" : "☰"}</span>
            </button>
          </div>
        </div>
        {menuOpen && (
          <div className="mt-3 flex flex-col gap-2 sm:hidden border-t border-zinc-800 pt-3">
            <div className="text-xs text-zinc-400">Uptime: {uptime} · PID {status?.pid ?? "?"}</div>
            <Link href="/accounts" className="w-full py-2 px-3 rounded-xl text-sm bg-zinc-800 text-zinc-300 text-center">🔐 Accounts</Link>
            <Link href="/settings" className="w-full py-2 px-3 rounded-xl text-sm bg-zinc-800 text-zinc-300 text-center">⚙️ Settings</Link>
          </div>
        )}
      </header>

      <div className="p-4 sm:p-6 space-y-6">
        {error && (
          <div className="p-3 sm:p-4 bg-red-900/50 border border-red-700 rounded-2xl text-red-200 text-xs sm:text-sm">
            ⚠️ Daemon unreachable: {error}
            <span className="text-zinc-500 ml-2">(last: {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "never"})</span>
          </div>
        )}

        {/* ── Paused ── */}
        {paused && (
          <div className="p-3 sm:p-4 rounded-2xl border-2 border-zinc-600 bg-zinc-900 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-bold text-sm sm:text-base">
                {status?.pause?.reason === "data_limit" ? "⏸ Paused — daily proxy data limit reached" : "⏸ Bot paused"}
              </p>
              <p className="text-[11px] sm:text-xs text-zinc-400 mt-0.5">
                Every store browser is closed — no watching, queues, checkout, drawings or proxy data.
                {status?.pause?.reason === "data_limit"
                  ? ` Resumes automatically at midnight${status?.bandwidth?.limit_mb ? ` (limit ${status.bandwidth.limit_mb} MB/day)` : ""}. Resume now to continue anyway today.`
                  : status?.pause?.since ? ` Paused ${ago(status.pause.since)}.` : ""}
              </p>
              {msg.pause && <p className="text-[10px] text-blue-300 mt-1">{msg.pause}</p>}
            </div>
            <button onClick={togglePause} disabled={pausing} className="shrink-0 px-3 py-2 rounded-2xl bg-green-700 hover:bg-green-600 text-white text-xs sm:text-sm font-bold disabled:opacity-50">
              ▶ Resume
            </button>
          </div>
        )}
        {!paused && msg.pause && <p className="text-[10px] text-blue-300">{msg.pause}</p>}

        {/* ── Sign-in needed ── */}
        {!paused && needsLogin.length > 0 && (
          <Link href="/accounts" className="block p-3 rounded-2xl border border-amber-700 bg-amber-900/20 text-amber-200 text-xs sm:text-sm">
            🔐 Sign in to {needsLogin.map((r) => retailerInfo(r)?.name || r).join(", ")} so the bot can queue and check out there →
          </Link>
        )}

        {/* ── Your turn ── */}
        {handoffs.length > 0 && (
          <section className="space-y-2">
            {handoffs.map((h) => (
              <div key={h.id} className="p-3 sm:p-4 rounded-2xl border-2 border-yellow-500 bg-yellow-900/30 shadow-lg shadow-yellow-900/30">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-yellow-200 font-bold text-sm sm:text-base">🙋 YOUR TURN — {h.label}</p>
                    <p className="text-xs text-yellow-100/80 mt-1 break-words">{h.reason}</p>
                    <p className="text-[10px] text-yellow-100/60 mt-1">
                      {retailerInfo(h.retailer)?.name} · {h.total != null && `$${h.total.toFixed(2)} · `}held for {mins(h.expires - lastFetch)} more
                    </p>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <Link href={`/live?id=${h.id}`} className="col-span-3 sm:col-span-1 py-3 rounded-2xl bg-yellow-500 hover:bg-yellow-400 text-black font-bold text-center text-sm">
                    📱 Open Live view
                  </Link>
                  <button
                    onClick={() => act(`h:${h.id}`, "/api/d/handoff/resolve", { id: h.id, outcome: "success" })}
                    className="col-span-3 sm:col-span-1 py-2 rounded-2xl bg-green-700 hover:bg-green-600 text-white text-xs sm:text-sm"
                  >✅ I bought it</button>
                  <button
                    onClick={() => act(`h:${h.id}`, "/api/d/handoff/resolve", { id: h.id, outcome: "abandoned" }, "Close this session without buying?")}
                    className="col-span-3 sm:col-span-1 py-2 rounded-2xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs sm:text-sm"
                  >↩️ Didn&apos;t buy</button>
                </div>
                {msg[`h:${h.id}`] && <p className="text-[10px] text-yellow-200 mt-2">{msg[`h:${h.id}`]}</p>}
              </div>
            ))}
          </section>
        )}

        {/* ── Working on it ── */}
        {busy.length > 0 && (
          <section className="space-y-2">
            {busy.map(([retailer, b]) => (
              <div key={retailer} className="p-3 rounded-2xl border border-blue-700 bg-blue-900/20 text-blue-100 text-xs sm:text-sm flex items-center gap-2">
                <span className="animate-pulse">{b.in_queue ? "🔵" : b.kind === "drawing" ? "🎟️" : "⏳"}</span>
                <span className="min-w-0 break-words">
                  {b.in_queue ? "In the queue" : b.kind === "drawing" ? "Entering drawing" : b.mode === "dry_run" ? "Dry run" : b.mode === "checkout" ? "Checking out" : "Getting it into your cart"}
                  : <b>{b.label}</b> <span className="text-blue-300/70">({retailerInfo(retailer)?.name}, {ago(b.started).replace(" ago", "")})</span>
                </span>
              </div>
            ))}
          </section>
        )}

        {/* ── Stores ── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs sm:text-sm section-title uppercase tracking-wider">Stores</h2>
            {status?.bandwidth && (
              <Link href="/accounts" className="text-[10px] sm:text-xs text-zinc-500">
                📶 {fmtBytes(status.bandwidth.proxy_today)} proxy today
                {status.bandwidth.limit_mb ? ` / ${status.bandwidth.limit_mb} MB` : ""}
              </Link>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {(status?.retailers ?? []).map((r) => {
              const info = retailerInfo(r.retailer);
              const healthy = r.errors < (r.max_errors || 10);
              return (
                <button
                  key={r.retailer}
                  onClick={() => setFilter(filter === r.retailer ? "all" : r.retailer)}
                  className={`p-3 rounded-2xl border text-left transition-colors ${filter === r.retailer ? "ring-1 ring-zinc-400" : ""} ${
                    healthy ? "border-zinc-700 bg-zinc-900" : "border-red-700 bg-red-900/20"}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-xs sm:text-sm truncate">{info?.emoji} {r.name}</span>
                    {r.errors > 0 && <span className="text-[10px] px-1 rounded-xl bg-red-900/50 text-red-300">{r.errors}✗</span>}
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    {r.last_tick ? `checked ${ago(r.last_tick)}` : r.session_open ? "starting…" : "not started"}
                    {r.interval ? ` · every ${r.interval}s` : ""}
                  </div>
                  {r.hot && <div className="text-[10px] text-orange-300 mt-0.5">🔥 {r.hot}</div>}
                  {r.watch && <div className="text-[10px] text-zinc-500 mt-0.5">👁 {r.watch}</div>}
                  {status?.bandwidth?.stores[r.retailer] && (
                    <div className="text-[10px] text-zinc-500 mt-0.5">
                      📶 {fmtBytes(status.bandwidth.stores[r.retailer].total)} today{status.bandwidth.stores[r.retailer].via_proxy ? " · proxy" : ""}
                    </div>
                  )}
                </button>
              );
            })}
            {status && status.retailers.length === 0 && (
              <div className="col-span-full text-zinc-600 text-xs">No products yet — add some in Settings or from New listings below.</div>
            )}
          </div>
        </section>

        {/* ── Products ── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs sm:text-sm section-title uppercase tracking-wider">
              Watchlist {filter !== "all" && <span className="normal-case">· {retailerInfo(filter)?.name}</span>}
            </h2>
            {filter !== "all" && <button onClick={() => setFilter("all")} className="text-[10px] text-zinc-500 underline">show all</button>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2 sm:gap-3">
            {products.map((p: ProductStatus) => {
              const badge = STATUS_BADGE[p.status] || STATUS_BADGE.unknown;
              const info = retailerInfo(p.retailer);
              const isBusy = !!co?.busy[p.retailer];
              const k = p.key;
              return (
                <div key={k} className={`p-3 sm:p-4 rounded-2xl border bg-zinc-900/50 ${hot(p.status) ? "border-green-700" : "border-zinc-800"}`}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-snug break-words">
                        {p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="hover:underline">{p.label}</a> : p.label}
                      </p>
                      <p className="text-[10px] text-zinc-500 mt-0.5 truncate">{p.sku}</p>
                    </div>
                    <span className={`shrink-0 text-[10px] sm:text-xs px-1.5 py-0.5 rounded-xl font-bold whitespace-nowrap ${badge.cls}`}>{badge.text}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] sm:text-xs text-zinc-500">
                    <span className={`inline-block px-1.5 py-0.5 rounded-xl text-[10px] uppercase ${info?.color || "bg-zinc-700"} text-white`}>{info?.name || p.retailer}</span>
                    <span>{p.price !== "N/A" ? p.price : "—"}{p.max_price ? <span className="text-zinc-600"> / max ${p.max_price}</span> : null}</span>
                  </div>
                  <div className="flex items-center justify-between mt-2 text-[10px]">
                    <span className={p.action === "notify" ? "text-zinc-500" : p.action === "checkout" ? "text-red-300" : "text-yellow-300"}>
                      {ACTION_LABELS[p.action]?.short}
                    </span>
                    <span className="text-zinc-600">{p.last_checked ? `checked ${ago(p.last_checked)}` : "not checked yet"}</span>
                  </div>
                  {p.error && <p className="text-[10px] text-red-400 mt-1 break-words">⚠️ {p.error}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      disabled={isBusy}
                      onClick={() => act(k, "/api/d/flow/start", { retailer: p.retailer, id: p.sku, mode: "assist" },
                        `Go for ${p.label} now? The bot joins the queue, adds it to your cart and pings you to finish.`)}
                      className="px-2 py-1 rounded-xl text-[10px] sm:text-xs bg-green-800 hover:bg-green-700 text-green-100 disabled:opacity-40"
                    >🛒 Go now</button>
                    <button
                      disabled={isBusy}
                      onClick={() => act(k, "/api/d/checkout/test", { retailer: p.retailer, id: p.sku },
                        "Run a DRY RUN? It adds the item to your cart and stops at Place order.")}
                      className="px-2 py-1 rounded-xl text-[10px] sm:text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40"
                    >🧪 Test</button>
                    {(p.status === "drawing_open" || p.retailer === "walmart" || p.retailer === "best-buy" || p.retailer === "target") && (
                      <button
                        disabled={isBusy}
                        onClick={() => act(k, "/api/d/drawing/enter", { retailer: p.retailer, id: p.sku })}
                        className={`px-2 py-1 rounded-xl text-[10px] sm:text-xs disabled:opacity-40 ${p.status === "drawing_open" ? "bg-purple-700 hover:bg-purple-600 text-white" : "bg-zinc-800 hover:bg-zinc-700 text-zinc-400"}`}
                      >🎟️ Enter drawing</button>
                    )}
                  </div>
                  {msg[k] && <p className="text-[10px] text-blue-300 mt-1 break-words">{msg[k]}</p>}
                </div>
              );
            })}
            {status && products.length === 0 && <div className="text-zinc-600 text-xs">No products</div>}
          </div>
        </section>

        {/* ── Activity ── */}
        {co && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs sm:text-sm section-title uppercase tracking-wider">Activity</h2>
              <span className="text-[10px] sm:text-xs text-zinc-500">${co.spend_total.toFixed(2)} / ${co.max_total_spend} spent</span>
            </div>
            {co.recent.length === 0 ? (
              <div className="p-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 text-zinc-600 text-xs">
                Nothing yet. Use 🧪 Test on a product to check login + checkout for each store.
              </div>
            ) : (
              <div className="rounded-2xl border border-zinc-800 divide-y divide-zinc-800 bg-zinc-900/50">
                {co.recent.slice(0, 12).map((a: Attempt, i: number) => {
                  const st = ATTEMPT_STYLE[a.status] || { icon: "•", cls: "text-zinc-400", label: a.status };
                  return (
                    <div key={a.id || i} className="p-2 sm:p-3 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-words">
                          <span className={`font-bold ${st.cls}`}>{st.icon} {st.label}</span>{" "}
                          <span className="text-zinc-300">{a.label}</span>{" "}
                          <span className="text-zinc-600">({retailerInfo(a.retailer)?.name || a.retailer})</span>
                        </span>
                        <span className="shrink-0 text-zinc-600 text-[10px]">{ago(a.ts)}</span>
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-0.5 break-words">
                        {a.total != null && <>Total ${Number(a.total).toFixed(2)} · </>}
                        {a.order_number && <>Order #{a.order_number} · </>}
                        {a.duration_ms != null && <>{(a.duration_ms / 1000).toFixed(1)}s · </>}
                        {a.trigger}
                        {a.error && <span className="text-red-400"> · {a.error}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* ── New listings ── */}
        {disc && (
          <section>
            <div className="flex items-center justify-between mb-3 gap-2">
              <h2 className="text-xs sm:text-sm section-title uppercase tracking-wider">New listings</h2>
              <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                <span className="hidden sm:inline">{disc.enabled ? `every ${disc.interval_minutes}m · last ${ago(disc.last_run)}` : "discovery off"}</span>
                <button
                  disabled={disc.running}
                  onClick={() => act("disc", "/api/d/discovery/run", {})}
                  className="px-2 py-1 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40"
                >{disc.running ? "Searching…" : "🔎 Search now"}</button>
              </div>
            </div>
            {msg.disc && <p className="text-[10px] text-blue-300 mb-2">{msg.disc}</p>}
            {Object.keys(disc.errors || {}).length > 0 && (
              <p className="text-[10px] text-amber-400 mb-2">
                Couldn&apos;t search: {Object.entries(disc.errors).map(([r, e]) => `${retailerInfo(r)?.name || r} (${e})`).join(", ")}
              </p>
            )}
            {disc.recent.length === 0 ? (
              <div className="p-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 text-zinc-600 text-xs">
                No new listings yet. The first search on each store learns what&apos;s already listed; new Pokémon products show up here after that.
              </div>
            ) : (
              <div className="rounded-2xl border border-zinc-800 divide-y divide-zinc-800 bg-zinc-900/50">
                {disc.recent.slice(0, 15).map((l) => {
                  const k = `l:${l.retailer}:${l.id}`;
                  return (
                    <div key={k} className="p-2 sm:p-3 text-xs flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <a href={l.url} target="_blank" rel="noreferrer" className="text-zinc-200 hover:underline break-words">{l.title}</a>
                        <div className="text-[10px] text-zinc-500 mt-0.5">
                          {retailerInfo(l.retailer)?.emoji} {retailerInfo(l.retailer)?.name} · {l.price || "no price"} · {ago(l.found)}
                        </div>
                        {msg[k] && <p className="text-[10px] text-blue-300 mt-1">{msg[k]}</p>}
                      </div>
                      {l.watched ? (
                        <span className="shrink-0 text-[10px] text-green-400">✓ watching</span>
                      ) : (
                        <button
                          onClick={() => act(k, "/api/d/discovery/watch", { retailer: l.retailer, id: l.id, action: "assist" })}
                          className="shrink-0 px-2 py-1 rounded-xl bg-blue-700 hover:bg-blue-600 text-white text-[10px] sm:text-xs"
                        >+ Watch</button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        <footer className="pt-4 border-t border-zinc-800 text-[10px] sm:text-xs text-zinc-600 flex flex-col sm:flex-row justify-between gap-1">
          <span>Drop Bot · {RETAILERS.map((r) => r.emoji).join(" ")}</span>
          <span>Updated {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}</span>
        </footer>
      </div>
    </main>
  );
}
