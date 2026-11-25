"use client";

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import { RETAILERS, ACTION_LABELS, retailerInfo, type ProductAction } from "@/lib/types";

interface Product {
  retailer: string;
  tcin?: string;
  sku?: string;
  url?: string;
  label: string;
  max_price?: number;
  action?: ProductAction;
  auto_checkout?: boolean;
  drawings?: boolean;
}

interface HotWindow {
  name?: string;
  retailers?: string[];
  days?: string[];
  start?: string;
  end?: string;
  timezone?: string;
  interval_seconds?: number;
}

interface CheckoutSettings {
  enabled?: boolean;
  dry_run?: boolean;
  headless?: boolean;
  auto_enter_drawings?: boolean;
  max_orders_per_product?: number;
  max_total_spend?: number;
  max_total_overage_pct?: number;
  retry_cooldown_seconds?: number;
  step_timeout_seconds?: number;
  queue_wait_minutes?: number;
  handoff_hold_minutes?: number;
}

interface Config {
  stores?: string[];
  products?: Product[];
  discord?: Record<string, string>;
  monitor?: {
    interval_seconds?: number; max_consecutive_errors?: number; hot_windows?: HotWindow[]; save_bandwidth?: boolean;
    watch_mode?: "lite" | "full"; full_check_minutes?: number; hot_full_check_minutes?: number; daily_proxy_limit_mb?: number;
  };
  notifications?: Record<string, number>;
  checkout?: CheckoutSettings;
  discovery?: { enabled?: boolean; interval_minutes?: number; queries?: string[]; must_match?: string; retailers?: string[] };
}

type Tab = "products" | "checkout" | "schedule" | "discovery" | "webhooks";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "products", label: "📦 Products" },
  { id: "checkout", label: "🛒 Automation" },
  { id: "schedule", label: "⏱️ Schedule" },
  { id: "discovery", label: "🔎 Discovery" },
  { id: "webhooks", label: "🔗 Webhooks" },
];

const ENV_MARKER = "(set via env)";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const CHECKOUT_DEFAULTS: Required<CheckoutSettings> = {
  enabled: false,
  dry_run: true,
  headless: false,
  auto_enter_drawings: true,
  max_orders_per_product: 1,
  max_total_spend: 300,
  max_total_overage_pct: 20,
  retry_cooldown_seconds: 60,
  step_timeout_seconds: 20,
  queue_wait_minutes: 45,
  handoff_hold_minutes: 20,
};

const CHECKOUT_NUMBER_FIELDS: Array<{ key: keyof CheckoutSettings; label: string; hint: string; min: number; max: number }> = [
  { key: "max_orders_per_product", label: "Max orders per product", hint: "Lifetime limit (hand-offs count until you mark them)", min: 1, max: 10 },
  { key: "max_total_spend", label: "Max total spend ($)", hint: "Lifetime cap across every product", min: 0, max: 10000 },
  { key: "max_total_overage_pct", label: "Order total headroom (%)", hint: "Total may exceed max price by this much (tax/shipping)", min: 0, max: 100 },
  { key: "queue_wait_minutes", label: "Queue wait (minutes)", hint: "How long to sit in a queue / waiting room", min: 1, max: 240 },
  { key: "handoff_hold_minutes", label: "Hand-off hold (minutes)", hint: "How long a session stays open for you to finish", min: 2, max: 120 },
  { key: "retry_cooldown_seconds", label: "Retry cooldown (seconds)", hint: "Wait after a failed attempt", min: 10, max: 3600 },
  { key: "step_timeout_seconds", label: "Step timeout (seconds)", hint: "Per page/button wait", min: 5, max: 120 },
];

const WEBHOOK_HINTS: Record<string, string> = {
  drop_alerts: "In stock / drop alerts (fallback for all others)",
  queue_live: "Queue open / joined / through",
  checkout_success: "Orders placed + dry runs",
  checkout_fail: "Failed / blocked / unconfirmed checkouts",
  action_needed: "🙋 Your turn — finish a purchase or enter a drawing",
  drawings: "Drawings opened / entered",
  discovery: "New listings found",
  health: "Startup / error pings",
};

const inputCls = "w-full px-2 py-1.5 rounded-xl bg-zinc-800 border border-zinc-700 text-sm focus:border-blue-500 outline-none";
const card = "p-3 sm:p-4 rounded-2xl border border-zinc-800 bg-zinc-900/50";

function Toggle({ on, onChange, label, hint, accent = "accent-green-500" }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; accent?: string }) {
  return (
    <label className={`${card} flex items-center justify-between gap-3 cursor-pointer`}>
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-[10px] text-zinc-600">{hint}</p>}
      </div>
      <input type="checkbox" className={`w-5 h-5 shrink-0 ${accent}`} checked={on} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Chips({ options, value, onChange }: { options: Array<{ id: string; label: string }>; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== o.id) : [...value, o.id])}
            className={`px-2 py-1 rounded-xl text-[10px] sm:text-xs ${on ? "bg-blue-700 text-white" : "bg-zinc-800 text-zinc-500"}`}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

// Target wants a TCIN and Best Buy a SKU — accept a pasted product link and pull the ID out of it.
function productIdFrom(retailer: string, raw: string): string {
  const v = raw.trim();
  if (retailer === "target") {
    const m = v.match(/\/A-(\d{6,10})/i) || v.match(/[?&](?:tcin|preselect)=(\d{6,10})/i);
    if (m) return m[1];
  }
  if (retailer === "best-buy") {
    const m = v.match(/[?&]skuId=(\d{6,8})/i) || v.match(/\/(\d{6,8})\.p\b/i) || v.match(/\/sku\/(\d{6,8})/i);
    if (m) return m[1];
  }
  return v;
}

export default function Settings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("products");

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (t && TABS.some((x) => x.id === t)) setActiveTab(t);
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch("/api/config", { signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Daemon unreachable");
      setConfig(data);
      setError(null);
    } catch {
      setError("Daemon offline — showing defaults (saving won't work until it's back)");
      setConfig({ products: [], discord: {}, monitor: { interval_seconds: 30, max_consecutive_errors: 10, hot_windows: [] }, checkout: { ...CHECKOUT_DEFAULTS }, discovery: {} });
    }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const patch = (fn: (c: Config) => void) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    if (!config) return;
    try {
      const res = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Save failed");
      setDirty(false);
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  };

  if (!config) return null;

  const products = config.products || [];
  // Stores switched on (no list yet = all on). Products of stores that are off stay saved but hidden.
  const storesOn = config.stores ?? RETAILERS.map((r) => r.id);
  const toggleStore = (id: string, on: boolean) => patch((c) => {
    const next = RETAILERS.map((r) => r.id).filter((r) => (r === id ? on : storesOn.includes(r)));
    c.stores = next;
  });
  const visibleStores = RETAILERS.filter((r) => storesOn.includes(r.id));
  const hiddenCount = products.filter((p) => !storesOn.includes(p.retailer)).length;
  const checkout = { ...CHECKOUT_DEFAULTS, ...(config.checkout || {}) };
  const setCheckout = (p: Partial<CheckoutSettings>) => patch((c) => { c.checkout = { ...checkout, ...p }; });
  const monitor = {
    interval_seconds: 60, max_consecutive_errors: 10, hot_windows: [] as HotWindow[], save_bandwidth: true,
    watch_mode: "lite" as "lite" | "full", full_check_minutes: 15, hot_full_check_minutes: 3, daily_proxy_limit_mb: 500,
    ...(config.monitor || {}),
  };
  const setMonitor = (p: Partial<typeof monitor>) => patch((c) => { c.monitor = { ...monitor, ...p }; });
  const windows = monitor.hot_windows || [];
  const setWindow = (i: number, p: Partial<HotWindow>) => patch((c) => {
    c.monitor = { ...monitor, hot_windows: windows.map((w, j) => (j === i ? { ...w, ...p } : w)) };
  });
  const discovery = {
    enabled: true, interval_minutes: 15, queries: ["pokemon trading card game", "pokemon tcg"], must_match: "pok[eé]mon",
    retailers: RETAILERS.map((r) => r.id), ...(config.discovery || {}),
  };
  const setDiscovery = (p: Partial<typeof discovery>) => patch((c) => { c.discovery = { ...discovery, ...p }; });
  const mode = !checkout.enabled ? "off" : checkout.dry_run ? "dry" : "live";

  const productAction = (p: Product): ProductAction => p.action || (p.auto_checkout ? "checkout" : "notify");
  const updateProduct = (i: number, p: Partial<Product>) => patch((c) => {
    const list = [...(c.products || [])];
    list[i] = { ...list[i], ...p };
    c.products = list;
  });
  const changeRetailer = (i: number, retailer: string) => patch((c) => {
    const list = [...(c.products || [])];
    const { tcin: _t, sku: _s, url: _u, ...rest } = list[i];
    void _t; void _s; void _u;
    list[i] = { ...rest, retailer };
    c.products = list;
  });

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-20 pokedex-header px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-2.5 font-semibold tracking-tight">
            <span className="pokeball text-xl" aria-hidden />Settings
          </h1>
          <div className="flex items-center gap-2 sm:gap-3">
            {saved && <span className="text-green-400 text-[10px] sm:text-sm">✅ Saved</span>}
            <button
              onClick={save}
              disabled={!dirty}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-2xl text-xs sm:text-sm font-bold ${dirty ? "bg-green-600 hover:bg-green-500 text-white" : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}`}
            >Save</button>
            <Link href="/" className="px-2 sm:px-3 py-1.5 sm:py-2 rounded-2xl text-xs sm:text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-400">
              ← <span className="hidden sm:inline">Dashboard</span>
            </Link>
          </div>
        </div>
      </header>

      <div className="p-4 sm:p-6">
        {error && <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded-2xl text-red-200 text-xs sm:text-sm">⚠️ {error}</div>}

        <div className="flex gap-1 sm:gap-2 mb-6 overflow-x-auto -mx-1 px-1 pb-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`shrink-0 px-3 sm:px-4 py-2 rounded-2xl text-xs sm:text-sm font-medium ${activeTab === t.id ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"}`}
            >{t.label}</button>
          ))}
        </div>

        {/* ── Products ── */}
        {activeTab === "products" && (
          <section>
            <div className={`${card} mb-4`}>
              <h2 className="text-xs sm:text-sm section-title uppercase tracking-wider mb-1">Stores</h2>
              <p className="text-[11px] text-zinc-500 mb-3">A store that&apos;s off isn&apos;t checked, searched or opened, and is hidden from the dashboard. Its products stay saved for when you turn it back on.</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {RETAILERS.map((r) => {
                  const on = storesOn.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="switch"
                      aria-checked={on}
                      onClick={() => toggleStore(r.id, !on)}
                      className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm ring-1 ring-inset transition-colors ${on ? "bg-emerald-500/10 ring-emerald-500/30 text-zinc-100" : "bg-zinc-900 ring-zinc-800 text-zinc-500"}`}
                    >
                      <span className="truncate">{r.name}</span>
                      <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-emerald-500" : "bg-zinc-700"}`}>
                        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-zinc-500 mt-2">Tap Save to apply.</p>
            </div>

            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs sm:text-sm section-title uppercase tracking-wider">Watchlist ({products.length - hiddenCount})</h2>
              <button
                disabled={!visibleStores.length}
                onClick={() => patch((c) => {
                  const r = visibleStores[0]?.id || "walmart";
                  c.products = [...products, { retailer: r, label: "New product", action: "assist" }];
                })}
                className="px-3 py-1.5 rounded-xl text-xs sm:text-sm bg-blue-600 hover:bg-blue-500 text-white"
              >+ Add</button>
            </div>
            <div className="space-y-2 sm:space-y-3">
              {hiddenCount > 0 && (
                <p className="text-[11px] text-zinc-500">{hiddenCount} product{hiddenCount === 1 ? "" : "s"} hidden — {hiddenCount === 1 ? "its store is" : "their stores are"} off.</p>
              )}
              {products.map((p, i) => {
                if (!storesOn.includes(p.retailer)) return null;
                const info = retailerInfo(p.retailer);
                const field = info?.idField || "url";
                const action = productAction(p);
                return (
                  <div key={i} className={card}>
                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-3">
                      <div className="sm:col-span-4">
                        <label className="text-[10px] text-zinc-500 uppercase block mb-1">Label</label>
                        <input type="text" value={p.label} onChange={(e) => updateProduct(i, { label: e.target.value })} className={inputCls} />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="text-[10px] text-zinc-500 uppercase block mb-1">Store</label>
                        <select value={p.retailer} onChange={(e) => changeRetailer(i, e.target.value)} className={inputCls}>
                          {visibleStores.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                      </div>
                      <div className="sm:col-span-4">
                        <label className="text-[10px] text-zinc-500 uppercase block mb-1">{info?.idLabel || "URL"}</label>
                        <input
                          type="text"
                          value={(p[field] as string) || ""}
                          placeholder={field === "url" ? "Paste the product link" : "Paste the product link or the " + (info?.idLabel || "ID")}
                          onChange={(e) => updateProduct(i, { [field]: productIdFrom(p.retailer, e.target.value) } as Partial<Product>)}
                          className={`${inputCls} text-xs`}
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="text-[10px] text-zinc-500 uppercase block mb-1">Max $</label>
                        <input
                          type="number" step="0.01" value={p.max_price ?? ""}
                          onChange={(e) => updateProduct(i, { max_price: e.target.value ? parseFloat(e.target.value) : undefined })}
                          className={inputCls}
                        />
                      </div>
                      <div className="sm:col-span-6">
                        <label className="text-[10px] text-zinc-500 uppercase block mb-1">When it drops</label>
                        <select
                          value={action}
                          onChange={(e) => updateProduct(i, { action: e.target.value as ProductAction, auto_checkout: undefined })}
                          className={inputCls}
                        >
                          {(Object.keys(ACTION_LABELS) as ProductAction[]).map((a) => <option key={a} value={a}>{ACTION_LABELS[a].long}</option>)}
                        </select>
                        {action === "checkout" && !(p.max_price && p.max_price > 0) && (
                          <p className="text-[10px] text-amber-400 mt-1">Auto-buy needs a Max $ — until then it only alerts.</p>
                        )}
                      </div>
                      <div className="sm:col-span-6 flex items-end justify-between gap-2">
                        <label className="flex items-center gap-2 text-xs cursor-pointer select-none pb-1.5">
                          <input
                            type="checkbox" className="w-4 h-4 accent-purple-500"
                            checked={p.drawings !== false}
                            onChange={(e) => updateProduct(i, { drawings: e.target.checked ? undefined : false })}
                          />
                          <span className={p.drawings !== false ? "text-purple-300" : "text-zinc-500"}>🎟️ Auto-enter drawings</span>
                        </label>
                        <button
                          onClick={() => patch((c) => { c.products = products.filter((_, j) => j !== i); })}
                          className="px-2 py-1.5 rounded-xl text-xs bg-red-900/50 hover:bg-red-800 text-red-300"
                        >✕ Remove</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Automation ── */}
        {activeTab === "checkout" && (
          <section className="space-y-2 sm:space-y-3">
            <div className={`p-3 sm:p-4 rounded-2xl border text-xs sm:text-sm ${
              mode === "live" ? "border-red-700 bg-red-900/30 text-red-200"
              : mode === "dry" ? "border-blue-700 bg-blue-900/20 text-blue-200"
              : "border-zinc-800 bg-zinc-900/50 text-zinc-400"}`}>
              {mode === "live" && "🛒 AUTO-BUY — products set to “check out for me” are purchased automatically; “I finish” products are handed to you."}
              {mode === "dry" && "🙋 HAND-OFF MODE — the bot joins queues, adds to cart and gets to Place order, then pings you to finish. It never clicks Place order."}
              {mode === "off" && "⏸ Alerts only — monitoring and Discord alerts run, but the bot won't touch carts, queues or drawings."}
            </div>

            <Toggle on={!!checkout.enabled} onChange={(v) => setCheckout({ enabled: v })} label="Enable automation" hint="Master switch for queues, carts, checkout and drawings" />
            <Toggle
              on={!!checkout.dry_run}
              accent="accent-blue-500"
              onChange={(v) => {
                if (!v && !window.confirm("Allow the bot to click Place order? Products set to “check out for me” will be bought with real money.")) return;
                setCheckout({ dry_run: v });
              }}
              label="Never click Place order (hand off to me)"
              hint="Turn off only after 🧪 Test succeeds for each store you use"
            />
            <Toggle on={!!checkout.auto_enter_drawings} accent="accent-purple-500" onChange={(v) => setCheckout({ auto_enter_drawings: v })} label="Auto-enter drawings" hint="Walmart / Best Buy / Target “enter to win” drawings on watched products" />
            <Toggle on={!!checkout.headless} accent="accent-zinc-400" onChange={(v) => setCheckout({ headless: v })} label="Hide browser windows (headless)" hint="Off = visible Chrome windows, which pass bot checks far more often" />

            {CHECKOUT_NUMBER_FIELDS.map((f) => (
              <div key={f.key} className={card}>
                <label className="text-[10px] text-zinc-500 uppercase block mb-1">{f.label}</label>
                <input
                  type="number" min={f.min} max={f.max} value={Number(checkout[f.key])}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) setCheckout({ [f.key]: v } as Partial<CheckoutSettings>); }}
                  className={inputCls}
                />
                <p className="text-[10px] text-zinc-600 mt-1">{f.hint}</p>
              </div>
            ))}

            <div className="p-3 sm:p-4 rounded-2xl border border-zinc-800 bg-zinc-900/30 text-[10px] sm:text-xs text-zinc-500 space-y-1">
              <p className="text-zinc-400 font-medium">Setup</p>
              <p>1. <Link href="/accounts" className="underline">🔐 Accounts</Link> → Sign in to each store you use (address + card saved on the account).</p>
              <p>2. Same page: save the card CVV for each store.</p>
              <p>3. Dashboard → 🧪 Test on a product per store → expect “DRY RUN OK”.</p>
              <p>4. Turn on automation. Leave “Never click Place order” on until you trust it.</p>
            </div>
          </section>
        )}

        {/* ── Schedule ── */}
        {activeTab === "schedule" && (
          <section className="space-y-2 sm:space-y-3">
            <div className={card}>
              <label className="text-[10px] text-zinc-500 uppercase block mb-1">Normal check interval (seconds)</label>
              <input
                type="number" min={5} max={600} value={monitor.interval_seconds}
                onChange={(e) => patch((c) => { c.monitor = { ...monitor, interval_seconds: parseInt(e.target.value) || 30 }; })}
                className={inputCls}
              />
              <p className="text-[10px] text-zinc-600 mt-1">Each store re-checks its watchlist this often. Very fast polling on a logged-in account risks flags — use hot windows for drop times.</p>
            </div>
            <div className={card}>
              <label className="text-[10px] text-zinc-500 uppercase block mb-1">Errors before alert</label>
              <input
                type="number" min={3} max={100} value={monitor.max_consecutive_errors}
                onChange={(e) => patch((c) => { c.monitor = { ...monitor, max_consecutive_errors: parseInt(e.target.value) || 10 }; })}
                className={inputCls}
              />
            </div>

            <div className={card}>
              <label className="text-[10px] text-zinc-500 uppercase block mb-1">How to watch</label>
              <select value={monitor.watch_mode} onChange={(e) => setMonitor({ watch_mode: e.target.value as "lite" | "full" })} className={inputCls}>
                <option value="lite">Light checks (recommended — a few KB per check)</option>
                <option value="full">Full page every check (uses far more data)</option>
              </select>
              <p className="text-[10px] text-zinc-600 mt-1">Light: reads stock from one small response; opens the full page only to confirm a drop, or when it can&apos;t tell (at most as often as below).</p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
              <div className={card}>
                <label className="text-[10px] text-zinc-500 uppercase block mb-1">Full check at most every (min)</label>
                <input type="number" min={1} max={240} value={monitor.full_check_minutes}
                  onChange={(e) => setMonitor({ full_check_minutes: parseInt(e.target.value) || 15 })} className={inputCls} />
              </div>
              <div className={card}>
                <label className="text-[10px] text-zinc-500 uppercase block mb-1">…during hot windows (min)</label>
                <input type="number" min={1} max={60} value={monitor.hot_full_check_minutes}
                  onChange={(e) => setMonitor({ hot_full_check_minutes: parseInt(e.target.value) || 3 })} className={inputCls} />
              </div>
            </div>
            <div className={card}>
              <label className="text-[10px] text-zinc-500 uppercase block mb-1">Daily proxy data limit (MB)</label>
              <input type="number" min={0} max={100000} value={monitor.daily_proxy_limit_mb}
                onChange={(e) => setMonitor({ daily_proxy_limit_mb: Math.max(0, parseInt(e.target.value) || 0) })} className={inputCls} />
              <p className="text-[10px] text-zinc-600 mt-1">The bot pauses itself when today&apos;s proxy data reaches this, and resumes at midnight. 0 = no limit.</p>
            </div>

            <Toggle
              on={monitor.save_bandwidth !== false}
              onChange={(v) => patch((c) => { c.monitor = { ...monitor, save_bandwidth: v }; })}
              label="Save proxy data while watching"
              hint="Watch + search tabs skip images, video, fonts and ad/analytics trackers, and keep the browser cache so store scripts download once. Checkout and Live view load fully. Applies when a store's browser restarts."
            />

            <div className="flex items-center justify-between pt-2">
              <h2 className="text-xs sm:text-sm section-title uppercase tracking-wider">🔥 Hot windows (faster checks)</h2>
              <button
                onClick={() => patch((c) => { c.monitor = { ...monitor, hot_windows: [...windows, { name: "New window", retailers: [], days: ["wed"], start: "09:00", end: "13:00", timezone: "America/New_York", interval_seconds: 10 }] }; })}
                className="px-3 py-1.5 rounded-xl text-xs bg-blue-600 hover:bg-blue-500 text-white"
              >+ Add</button>
            </div>
            {windows.map((w, i) => (
              <div key={i} className={`${card} space-y-2`}>
                <div className="flex gap-2">
                  <input value={w.name || ""} onChange={(e) => setWindow(i, { name: e.target.value })} placeholder="Name" className={inputCls} />
                  <button
                    onClick={() => patch((c) => { c.monitor = { ...monitor, hot_windows: windows.filter((_, j) => j !== i) }; })}
                    className="px-2 rounded-xl text-xs bg-red-900/50 hover:bg-red-800 text-red-300 shrink-0"
                  >✕</button>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-500 uppercase mb-1">Stores (none = all)</p>
                  <Chips options={RETAILERS.map((r) => ({ id: r.id, label: r.name }))} value={w.retailers || []} onChange={(v) => setWindow(i, { retailers: v })} />
                </div>
                <div>
                  <p className="text-[10px] text-zinc-500 uppercase mb-1">Days (none = every day)</p>
                  <Chips options={DAYS.map((d) => ({ id: d, label: d }))} value={w.days || []} onChange={(v) => setWindow(i, { days: v })} />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div>
                    <p className="text-[10px] text-zinc-500 uppercase mb-1">Start</p>
                    <input type="time" value={w.start || "00:00"} onChange={(e) => setWindow(i, { start: e.target.value })} className={inputCls} />
                  </div>
                  <div>
                    <p className="text-[10px] text-zinc-500 uppercase mb-1">End</p>
                    <input type="time" value={w.end || "23:59"} onChange={(e) => setWindow(i, { end: e.target.value })} className={inputCls} />
                  </div>
                  <div>
                    <p className="text-[10px] text-zinc-500 uppercase mb-1">Every (s)</p>
                    <input type="number" min={2} max={120} value={w.interval_seconds ?? 10} onChange={(e) => setWindow(i, { interval_seconds: parseInt(e.target.value) || 10 })} className={inputCls} />
                  </div>
                  <div>
                    <p className="text-[10px] text-zinc-500 uppercase mb-1">Timezone</p>
                    <select value={w.timezone || "America/New_York"} onChange={(e) => setWindow(i, { timezone: e.target.value })} className={inputCls}>
                      {["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"].map((tz) => <option key={tz} value={tz}>{tz.split("/")[1].replace("_", " ")}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            ))}
            {windows.length === 0 && <p className="text-xs text-zinc-600">No hot windows — every store uses the normal interval.</p>}
          </section>
        )}

        {/* ── Discovery ── */}
        {activeTab === "discovery" && (
          <section className="space-y-2 sm:space-y-3">
            <Toggle on={!!discovery.enabled} onChange={(v) => setDiscovery({ enabled: v })} label="Search stores for new Pokémon listings" hint="New products appear on the dashboard with a one-tap Watch button" />
            <div className={card}>
              <label className="text-[10px] text-zinc-500 uppercase block mb-1">Search every (minutes)</label>
              <input type="number" min={2} max={240} value={discovery.interval_minutes} onChange={(e) => setDiscovery({ interval_minutes: parseInt(e.target.value) || 15 })} className={inputCls} />
            </div>
            <div className={card}>
              <label className="text-[10px] text-zinc-500 uppercase block mb-1">Search terms (one per line)</label>
              <textarea
                rows={4}
                value={(discovery.queries || []).join("\n")}
                onChange={(e) => setDiscovery({ queries: e.target.value.split("\n").map((q) => q.trim()).filter(Boolean) })}
                className={`${inputCls} text-xs`}
              />
            </div>
            <div className={card}>
              <p className="text-[10px] text-zinc-500 uppercase mb-1">Stores to search</p>
              <Chips options={RETAILERS.map((r) => ({ id: r.id, label: r.name }))} value={discovery.retailers || []} onChange={(v) => setDiscovery({ retailers: v })} />
            </div>
            <div className={card}>
              <label className="text-[10px] text-zinc-500 uppercase block mb-1">Title must match (regex)</label>
              <input value={discovery.must_match || ""} onChange={(e) => setDiscovery({ must_match: e.target.value })} className={`${inputCls} text-xs`} />
              <p className="text-[10px] text-zinc-600 mt-1">Filters out non-Pokémon results</p>
            </div>
          </section>
        )}

        {/* ── Webhooks ── */}
        {activeTab === "webhooks" && (
          <section>
            <h2 className="text-xs sm:text-sm section-title uppercase tracking-wider mb-4">Discord webhooks</h2>
            <div className="space-y-2 sm:space-y-3">
              {Object.entries(config.discord || {}).map(([key, value]) => (
                <div key={key} className={card}>
                  <label className="text-[10px] text-zinc-500 uppercase block mb-1">{key.replace(/_/g, " ")}</label>
                  {value === ENV_MARKER ? (
                    <div className="w-full px-2 py-1.5 rounded-xl bg-zinc-900 border border-green-900 text-xs text-green-400">🔒 Set via daemon .env (DISCORD_{key.toUpperCase()})</div>
                  ) : (
                    <input
                      type="text" value={value || ""}
                      onChange={(e) => patch((c) => { c.discord = { ...(c.discord || {}), [key]: e.target.value }; })}
                      placeholder={`Recommended: DISCORD_${key.toUpperCase()} in the daemon's .env`}
                      className={`${inputCls} text-xs`}
                    />
                  )}
                  <p className="text-[10px] text-zinc-600 mt-1">{WEBHOOK_HINTS[key] || ""}</p>
                </div>
              ))}
              <p className="text-[10px] text-zinc-600">
                Set <code>DISCORD_MENTION_USER_ID</code> in the daemon&apos;s .env so “your turn” alerts @mention you, and <code>DASHBOARD_URL</code> so they link to Live view.
              </p>
            </div>
          </section>
        )}

        <footer className="mt-8 sm:mt-12 pt-4 border-t border-zinc-800 text-[10px] sm:text-xs text-zinc-600">
          Changes apply on the bot&apos;s next pass — no restart needed.
        </footer>
      </div>
    </main>
  );
}
