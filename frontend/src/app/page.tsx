"use client";

import Link from "next/link";
import { useState, useEffect, useCallback, type ReactNode } from "react";
import {
  type DaemonStatus, type ProductStatus, type Attempt,
  RETAILERS, retailerInfo, ago, postJson, fmtBytes,
} from "@/lib/types";
import { Icon, Pill, PRODUCT_STATUS, ATTEMPT_STATUS, btn, type Tone } from "@/components/ui";

const STORE_DOT: Record<string, string> = {
  target: "bg-red-500", "best-buy": "bg-sky-500", walmart: "bg-blue-500",
  costco: "bg-rose-500", "sams-club": "bg-cyan-500", "pokemon-center": "bg-yellow-400",
};

const MODE_TEXT: Record<string, string> = { notify: "Notify", assist: "Queue + cart", checkout: "Auto-buy" };

// Desktop columns: product · status · price · mode · checked · Go now · ⋯ (fixed widths keep rows aligned)
const ROW_COLS = "md:grid-cols-[minmax(0,1fr)_130px_130px_110px_80px_100px_32px]";

function mins(ms: number) {
  return `${Math.max(0, Math.round(ms / 60000))}m`;
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-xs section-title uppercase">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "green" | "red" }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-3">
      <p className="text-[11px] font-medium text-zinc-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold tracking-tight ${tone === "green" ? "text-emerald-300" : tone === "red" ? "text-red-400" : "text-zinc-100"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-zinc-500 truncate">{sub}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number>(0);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<string>("all");
  const [pausing, setPausing] = useState(false);

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
  const togglePause = async () => {
    const next = !paused;
    if (next && !window.confirm("Pause the bot? Every store browser closes — no watching, queues, checkout or proxy data until you resume. Open hand-offs are closed."))
      return;
    if (!next && !window.confirm("Resume the bot? Store browsers reopen and watching starts again."))
      return;
    setPausing(true);
    const r = await postJson("/api/d/pause", { paused: next });
    setPausing(false);
    setMsg((m) => ({ ...m, pause: r.message || r.error || "" }));
    fetchStatus();
  };

  const co = status?.checkout;
  const disc = status?.discovery;
  const bw = status?.bandwidth;
  const mode = !co ? null : !co.enabled ? "off" : co.dry_run ? "dry" : "live";
  const modeText = mode === "live" ? "Auto-buy" : mode === "dry" ? "Hand-off" : mode === "off" ? "Alerts only" : "—";
  const uptime = status ? `${Math.floor(status.uptime_seconds / 3600)}h ${Math.floor((status.uptime_seconds % 3600) / 60)}m` : "—";
  const handoffs = co?.handoffs ?? [];
  const needsLogin = [...new Set((status?.products ?? []).filter((p) => p.action !== "notify").map((p) => p.retailer))]
    .filter((r) => status?.accounts?.[r]?.logged_in !== true);
  const busy = Object.entries(co?.busy ?? {});
  const hot = (s: string) => ["in_stock", "queue", "drawing_open"].includes(s);
  const allProducts = status?.products ?? [];
  const inStock = allProducts.filter((p) => hot(p.status)).length;
  const storeIds = RETAILERS.map((r) => r.id).filter((id) => allProducts.some((p) => p.retailer === id));
  const shownStores = filter === "all" ? storeIds : storeIds.filter((id) => id === filter);
  const runState = !status ? { tone: "gray" as Tone, text: "Connecting" }
    : error ? { tone: "red" as Tone, text: "Offline" }
    : paused ? { tone: "amber" as Tone, text: "Paused" }
    : { tone: "green" as Tone, text: "Running" };
  const last = status?.pause?.history?.[0];

  const closeMenu = (e: React.MouseEvent) => {
    const d = (e.currentTarget as HTMLElement).closest("details");
    if (d) d.open = false;
  };

  const productRow = (p: ProductStatus) => {
    const st = PRODUCT_STATUS[p.status] || PRODUCT_STATUS.unknown;
    const isBusy = !!co?.busy[p.retailer];
    const k = p.key;
    const canDraw = p.status === "drawing_open" || ["walmart", "best-buy", "target"].includes(p.retailer);
    const goNow = () => act(k, "/api/d/flow/start", { retailer: p.retailer, id: p.sku, mode: "assist" },
      `Go for ${p.label} now? The bot joins the queue, adds it to your cart and pings you to finish.`);
    return (
      <div key={k} className={`px-4 py-3 ${hot(p.status) ? "bg-emerald-500/[0.04]" : ""}`}>
        <div className={`grid grid-cols-[minmax(0,1fr)_auto] ${ROW_COLS} items-center gap-x-4 gap-y-2`}>
          {/* name — phone: top-left · desktop: col 1 */}
          <div className="min-w-0 col-start-1 row-start-1">
            <p className="text-sm font-medium text-zinc-100 truncate">{p.label}</p>
            <p className="text-[11px] text-zinc-500 truncate">
              {p.sku}
              <span className="md:hidden"> · {MODE_TEXT[p.action] || p.action} · {p.last_checked ? ago(p.last_checked) : "not checked"}</span>
            </p>
          </div>
          {/* status — phone: 2nd row left · desktop: col 2 */}
          <div className="col-start-1 row-start-2 md:col-start-2 md:row-start-1">
            <Pill tone={st.tone} pulse={hot(p.status)}>{st.label}</Pill>
          </div>
          <p className="hidden md:block md:col-start-3 md:row-start-1 text-sm tabular-nums text-zinc-300">
            {p.price !== "N/A" ? p.price : "—"}
            {p.max_price ? <span className="text-zinc-500 text-xs"> / ${p.max_price}</span> : null}
          </p>
          <p className="hidden md:block md:col-start-4 md:row-start-1 text-xs text-zinc-400">{MODE_TEXT[p.action] || p.action}</p>
          <p className="hidden md:block md:col-start-5 md:row-start-1 text-xs text-zinc-500">{p.last_checked ? ago(p.last_checked) : "—"}</p>
          {/* Go now — phone: 2nd row right · desktop: col 6 (fixed width, so columns stay aligned) */}
          <div className="col-start-2 row-start-2 md:col-start-6 md:row-start-1 justify-self-end">
            {hot(p.status) && (
              <button disabled={isBusy} onClick={goNow} className={`${btn.primary} px-3 py-1.5 text-xs`}>
                <Icon name="cart" className="w-3.5 h-3.5" /> Go now
              </button>
            )}
          </div>
          {/* ⋯ menu — phone: top-right · desktop: col 7 */}
          <div className="col-start-2 row-start-1 md:col-start-7 md:row-start-1 justify-self-end">
            <details className="row-menu relative">
              <summary className={`${btn.ghost} h-8 w-8 cursor-pointer`} aria-label="More actions">
                <Icon name="dots" />
              </summary>
              <div className="absolute right-0 z-30 mt-1 w-48 rounded-xl border border-zinc-700 bg-zinc-900 p-1 shadow-2xl shadow-black/50">
                {!hot(p.status) && (
                  <button disabled={isBusy} onClick={(e) => { closeMenu(e); goNow(); }} className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
                    <Icon name="cart" /> Go now
                  </button>
                )}
                <button
                  disabled={isBusy}
                  onClick={(e) => { closeMenu(e); act(k, "/api/d/checkout/test", { retailer: p.retailer, id: p.sku }, "Run a DRY RUN? It adds the item to your cart and stops at Place order."); }}
                  className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                ><Icon name="flask" /> Test checkout</button>
                {canDraw && (
                  <button
                    disabled={isBusy}
                    onClick={(e) => { closeMenu(e); act(k, "/api/d/drawing/enter", { retailer: p.retailer, id: p.sku }); }}
                    className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                  ><Icon name="ticket" /> Enter drawing</button>
                )}
                {p.url && (
                  <a href={p.url} target="_blank" rel="noreferrer" onClick={closeMenu} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-zinc-200 hover:bg-zinc-800">
                    <Icon name="external" /> Open product page
                  </a>
                )}
              </div>
            </details>
          </div>
        </div>
        {p.error && <p className="mt-1 text-[11px] text-red-300/90 truncate">{p.error}</p>}
        {msg[k] && <p className="mt-1 text-[11px] text-sky-300">{msg[k]}</p>}
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* ── Top bar ── */}
      <header className="sticky top-0 z-20 pokedex-header">
        <div className="mx-auto max-w-6xl px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="pokeball text-xl" aria-hidden />
            <span className="font-semibold tracking-tight">Drop Bot</span>
            <span className="hidden sm:inline"><Pill tone={runState.tone} pulse={runState.text === "Running"}>{runState.text}</Pill></span>
          </div>
          <nav className="flex items-center gap-1 sm:gap-1.5">
            {status && (
              <button onClick={togglePause} disabled={pausing} className={`${paused ? btn.primary : btn.secondary} h-8 px-3 text-xs`}>
                <Icon name={paused ? "play" : "pause"} className="w-3.5 h-3.5" />
                {pausing ? "…" : paused ? "Resume" : "Pause"}
              </button>
            )}
            <Link href="/accounts" className={`${btn.ghost} h-8 px-2.5 text-xs`}><Icon name="key" /><span className="hidden sm:inline">Accounts</span></Link>
            <Link href="/settings" className={`${btn.ghost} h-8 px-2.5 text-xs`}><Icon name="sliders" /><span className="hidden sm:inline">Settings</span></Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        {/* ── Alerts ── */}
        {error && (
          <div className="flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <Icon name="alert" className="w-4 h-4 shrink-0" />
            <span>Can&apos;t reach the bot ({error}). Last update {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "never"}.</span>
          </div>
        )}

        {paused && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <span className="mt-0.5 rounded-lg bg-amber-500/15 p-1.5 text-amber-300"><Icon name="pause" className="w-4 h-4" /></span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-amber-100">
                  {status?.pause?.reason === "data_limit" ? "Paused — daily proxy data limit reached" : "Bot is paused"}
                </p>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {status?.pause?.reason === "data_limit"
                    ? `Resumes automatically at midnight${bw?.limit_mb ? ` (limit ${bw.limit_mb} MB/day)` : ""}.`
                    : "No watching, queues or checkout. Signing in to stores still works."}
                  {last?.paused ? ` Paused by ${last.by} · ${new Date(last.at).toLocaleString()}.` : status?.pause?.since ? ` Paused ${ago(status.pause.since)}.` : ""}
                </p>
                {msg.pause && <p className="text-xs text-sky-300 mt-1">{msg.pause}</p>}
              </div>
            </div>
            <button onClick={togglePause} disabled={pausing} className={`${btn.primary} h-9 px-4 text-sm self-start sm:self-center`}>
              <Icon name="play" className="w-3.5 h-3.5" /> Resume
            </button>
          </div>
        )}
        {!paused && (msg.pause || (last && !last.paused)) && (
          <p className="text-xs text-zinc-500">
            {msg.pause || `Running since ${new Date(last!.at).toLocaleString()} · resumed by ${last!.by}`}
          </p>
        )}

        {!paused && needsLogin.length > 0 && (
          <Link href="/accounts" className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm text-zinc-300 hover:border-zinc-700">
            <Icon name="key" className="w-4 h-4 text-amber-300 shrink-0" />
            <span className="flex-1">Sign in to {needsLogin.map((r) => retailerInfo(r)?.name || r).join(", ")} so the bot can queue and check out.</span>
            <span className="text-zinc-500 text-xs">Accounts →</span>
          </Link>
        )}

        {/* ── Your turn ── */}
        {handoffs.map((h) => (
          <div key={h.id} className="rounded-xl border border-yellow-400/40 bg-yellow-400/[0.08] p-4 shadow-lg shadow-yellow-500/5">
            <div className="flex items-start gap-3">
              <span className="rounded-lg bg-yellow-400 p-1.5 text-zinc-950"><Icon name="cart" className="w-4 h-4" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-yellow-100">Your turn — {h.label}</p>
                <p className="text-xs text-zinc-300 mt-0.5">{h.reason}</p>
                <p className="text-[11px] text-zinc-500 mt-1">
                  {retailerInfo(h.retailer)?.name}{h.total != null ? ` · $${h.total.toFixed(2)}` : ""} · held for {mins(h.expires - lastFetch)} more
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 sm:pl-10">
              <Link href={`/live?id=${h.id}`} className="inline-flex items-center gap-1.5 rounded-lg bg-yellow-400 hover:bg-yellow-300 px-4 h-9 text-sm font-semibold text-zinc-950">
                <Icon name="phone" /> Open Live view
              </Link>
              <button onClick={() => act(`h:${h.id}`, "/api/d/handoff/resolve", { id: h.id, outcome: "success" })} className={`${btn.secondary} h-9 px-3 text-sm`}>
                <Icon name="check" /> I bought it
              </button>
              <button onClick={() => act(`h:${h.id}`, "/api/d/handoff/resolve", { id: h.id, outcome: "abandoned" }, "Close this session without buying?")} className={`${btn.ghost} h-9 px-3 text-sm`}>
                Didn&apos;t buy
              </button>
            </div>
            {msg[`h:${h.id}`] && <p className="text-xs text-yellow-200 mt-2 sm:pl-10">{msg[`h:${h.id}`]}</p>}
          </div>
        ))}

        {busy.map(([retailer, b]) => (
          <div key={retailer} className="flex items-center gap-3 rounded-xl border border-sky-500/25 bg-sky-500/[0.07] px-4 py-3 text-sm">
            <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
            <span className="min-w-0 text-zinc-200">
              {b.in_queue ? "In the queue" : b.kind === "drawing" ? "Entering drawing" : b.mode === "dry_run" ? "Dry run" : b.mode === "checkout" ? "Checking out" : "Adding to cart"}
              {" — "}<span className="font-medium">{b.label}</span>
              <span className="text-zinc-500"> · {retailerInfo(retailer)?.name} · {ago(b.started).replace(" ago", "")}</span>
            </span>
          </div>
        ))}

        {/* ── Summary ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Watching" value={allProducts.length} sub={`${storeIds.length} store${storeIds.length === 1 ? "" : "s"}`} />
          <Stat label="In stock now" value={inStock} tone={inStock ? "green" : undefined} sub={inStock ? "check the list below" : "nothing live"} />
          <Stat label="Mode" value={modeText} sub={<Link href="/settings?tab=checkout" className="hover:text-zinc-300">change in Settings</Link>} />
          <Stat
            label="Proxy data today"
            value={bw ? fmtBytes(bw.proxy_today) : "—"}
            sub={bw ? `${bw.limit_mb ? `limit ${bw.limit_mb} MB · ` : ""}all traffic ${fmtBytes(bw.total_today)}` : undefined}
          />
        </div>

        {/* ── Watchlist ── */}
        <Section
          title="Watchlist"
          right={
            <div className="flex items-center gap-1 overflow-x-auto">
              {["all", ...storeIds].map((id) => (
                <button
                  key={id}
                  onClick={() => setFilter(id)}
                  className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${filter === id ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                >{id === "all" ? "All" : retailerInfo(id)?.name}</button>
              ))}
            </div>
          }
        >
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/70">
            <div className={`hidden md:grid ${ROW_COLS} gap-x-4 px-4 py-2 border-b border-zinc-800 text-[11px] font-medium text-zinc-500`}>
              <span>Product</span><span>Status</span><span>Price / max</span><span>When it drops</span><span>Checked</span><span /><span />
            </div>
            {shownStores.map((id) => {
              const r = status?.retailers.find((x) => x.retailer === id);
              const items = allProducts.filter((p) => p.retailer === id).sort((a, b) => Number(hot(b.status)) - Number(hot(a.status)));
              const usage = bw?.stores[id];
              return (
                <div key={id} className="border-b border-zinc-800 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 bg-zinc-950/40">
                    <span className={`h-2 w-2 rounded-full ${STORE_DOT[id] || "bg-zinc-500"}`} />
                    <span className="text-sm font-semibold">{retailerInfo(id)?.name}</span>
                    <span className="text-[11px] text-zinc-500">
                      {r?.last_tick ? `checked ${ago(r.last_tick)}` : paused ? "paused" : r?.session_open ? "starting…" : "not started"}
                      {r?.watch ? ` · ${r.watch}` : ""}
                      {usage ? ` · ${fmtBytes(usage.total)} today${usage.via_proxy ? " (proxy)" : ""}` : ""}
                    </span>
                    {r?.hot && <Pill tone="amber">{r.hot}</Pill>}
                    {r && r.errors > 0 && <Pill tone="red">{r.errors} errors</Pill>}
                    {status?.accounts?.[id]?.logged_in === false && <Pill tone="amber">signed out</Pill>}
                  </div>
                  <div className="divide-y divide-zinc-800/70">{items.map(productRow)}</div>
                </div>
              );
            })}
            {status && allProducts.length === 0 && (
              <p className="px-4 py-6 text-sm text-zinc-500">No products yet — add some in Settings, or tap Watch on a new listing.</p>
            )}
            {!status && <p className="px-4 py-6 text-sm text-zinc-500">Loading…</p>}
          </div>
        </Section>

        {/* ── Activity + New listings ── */}
        <div className="grid lg:grid-cols-2 gap-6">
          {co && (
            <Section title="Activity" right={<span className="text-[11px] text-zinc-500">${co.spend_total.toFixed(2)} of ${co.max_total_spend} spent</span>}>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 divide-y divide-zinc-800/70">
                {co.recent.length === 0 && <p className="px-4 py-6 text-sm text-zinc-500">Nothing yet. Use “Test checkout” in a product&apos;s ⋯ menu to try a store.</p>}
                {co.recent.slice(0, 8).map((a: Attempt, i: number) => {
                  const st = ATTEMPT_STATUS[a.status] || { label: a.status, tone: "gray" as Tone };
                  return (
                    <div key={a.id || i} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex items-center gap-2">
                          <Pill tone={st.tone}>{st.label}</Pill>
                          <span className="text-sm text-zinc-200 truncate">{a.label}</span>
                        </div>
                        <span className="shrink-0 text-[11px] text-zinc-500">{ago(a.ts)}</span>
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-500 truncate">
                        {retailerInfo(a.retailer)?.name || a.retailer}
                        {a.total != null && ` · $${Number(a.total).toFixed(2)}`}
                        {a.order_number && ` · order #${a.order_number}`}
                        {a.error && <span className="text-red-300/90"> · {a.error}</span>}
                      </p>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {disc && (
            <Section
              title="New listings"
              right={
                <button disabled={disc.running} onClick={() => act("disc", "/api/d/discovery/run", {})} className={`${btn.ghost} h-7 px-2 text-xs`}>
                  <Icon name="search" className="w-3.5 h-3.5" /> {disc.running ? "Searching…" : "Search now"}
                </button>
              }
            >
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 divide-y divide-zinc-800/70">
                {msg.disc && <p className="px-4 py-2 text-xs text-sky-300">{msg.disc}</p>}
                {Object.keys(disc.errors || {}).length > 0 && (
                  <p className="px-4 py-2 text-xs text-amber-300/90">
                    Couldn&apos;t search {Object.keys(disc.errors).map((r) => retailerInfo(r)?.name || r).join(", ")}.
                  </p>
                )}
                {disc.recent.length === 0 && (
                  <p className="px-4 py-6 text-sm text-zinc-500">
                    No new listings yet. {disc.enabled ? `Searching every ${disc.interval_minutes} min.` : "Discovery is off."}
                  </p>
                )}
                {disc.recent.slice(0, 8).map((l) => {
                  const k = `l:${l.retailer}:${l.id}`;
                  return (
                    <div key={k} className="px-4 py-3 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <a href={l.url} target="_blank" rel="noreferrer" className="block text-sm text-zinc-200 hover:text-white truncate">{l.title}</a>
                        <p className="text-[11px] text-zinc-500">{retailerInfo(l.retailer)?.name} · {l.price || "no price"} · {ago(l.found)}</p>
                        {msg[k] && <p className="text-[11px] text-sky-300 mt-0.5">{msg[k]}</p>}
                      </div>
                      {l.watched ? (
                        <span className="shrink-0 inline-flex items-center gap-1 text-xs text-emerald-300"><Icon name="check" className="w-3.5 h-3.5" /> Watching</span>
                      ) : (
                        <button onClick={() => act(k, "/api/d/discovery/watch", { retailer: l.retailer, id: l.id, action: "assist" })} className={`${btn.secondary} h-8 px-3 text-xs shrink-0`}>
                          <Icon name="plus" className="w-3.5 h-3.5" /> Watch
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>
          )}
        </div>

        <footer className="pt-2 pb-6 text-[11px] text-zinc-600 flex flex-wrap justify-between gap-2">
          <span>Drop Bot · {status?.running ? `up ${uptime}` : "offline"}</span>
          <span>Updated {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}</span>
        </footer>
      </div>
    </main>
  );
}
