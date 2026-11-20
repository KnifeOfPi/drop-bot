"use client";

import { useState, useEffect, useCallback } from "react";

interface ProductStatus {
  retailer: string;
  label: string;
  sku: string;
  price: string;
  in_stock: boolean | null;
  last_checked: number | null;
  error?: string;
}

interface RetailerHealth {
  retailer: string;
  errors: number;
  max_errors: number;
  last_tick: number | null;
}

interface CheckoutAttempt {
  id?: string;
  ts: number;
  key: string;
  retailer: string;
  label: string;
  status: "success" | "unconfirmed" | "dry_run" | "failed" | "guard";
  trigger?: string;
  total?: number | null;
  order_number?: string | null;
  error?: string;
  message?: string;
  duration_ms?: number;
}

interface CheckoutStatus {
  enabled: boolean;
  dry_run: boolean;
  max_orders_per_product: number;
  max_total_spend: number;
  spend_total: number;
  armed: string[];
  busy: Record<string, { key: string; started: number; dry_run: boolean }>;
  recent: CheckoutAttempt[];
}

interface DaemonStatus {
  running: boolean;
  uptime_seconds: number;
  tick_count: number;
  products: ProductStatus[];
  retailers: RetailerHealth[];
  pid: number;
  checkout?: CheckoutStatus;
}

const ATTEMPT_STYLE: Record<string, { icon: string; cls: string; label: string }> = {
  success: { icon: "✅", cls: "text-green-300", label: "ORDERED" },
  unconfirmed: { icon: "❓", cls: "text-amber-300", label: "UNCONFIRMED" },
  dry_run: { icon: "🧪", cls: "text-blue-300", label: "DRY RUN OK" },
  failed: { icon: "❌", cls: "text-red-300", label: "FAILED" },
  guard: { icon: "🛑", cls: "text-zinc-300", label: "BLOCKED" },
};

function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const RETAILER_COLORS: Record<string, string> = {
  target: "bg-red-600",
  "best-buy": "bg-blue-600",
  "pokemon-center": "bg-yellow-500",
};

const RETAILER_EMOJI: Record<string, string> = {
  target: "🎯",
  "best-buy": "🔵",
  "pokemon-center": "⚡",
};

export default function Dashboard() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number>(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});

  const runTest = async (retailer: string, id: string) => {
    const k = `${retailer}:${id}`;
    if (!window.confirm("Run a DRY RUN checkout? It adds the item to your cart and stops at Place order.")) return;
    setTestMsg((m) => ({ ...m, [k]: "Starting…" }));
    try {
      const res = await fetch("/api/checkout/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retailer, id }),
      });
      const data = await res.json();
      setTestMsg((m) => ({ ...m, [k]: data.message || data.error || `HTTP ${res.status}` }));
    } catch (e: any) {
      setTestMsg((m) => ({ ...m, [k]: e.message }));
    }
  };

  const co = status?.checkout;
  const coMode = !co ? null : !co.enabled ? "off" : co.dry_run ? "dry" : "live";
  const coBadge =
    coMode === "live" ? { text: "🛒 LIVE", cls: "bg-red-700 text-white" }
    : coMode === "dry" ? { text: "🧪 DRY RUN", cls: "bg-blue-800 text-blue-100" }
    : coMode === "off" ? { text: "🛒 OFF", cls: "bg-zinc-800 text-zinc-400" }
    : null;

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
      setError(null);
      setLastFetch(Date.now());
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const uptime = status
    ? `${Math.floor(status.uptime_seconds / 3600)}h ${Math.floor((status.uptime_seconds % 3600) / 60)}m`
    : "—";

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 font-mono">
      {/* Sticky header */}
      <header className="sticky top-0 z-20 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg sm:text-2xl font-bold flex items-center gap-2">
              <span className="text-2xl sm:text-3xl">⚡</span>
              <span className="hidden sm:inline">Drop Bot</span>
            </h1>
            <p className="text-zinc-500 text-xs mt-0.5 hidden sm:block">
              {status ? `${status.products.length} products across 3 retailers` : "Loading..."}
            </p>
          </div>

          {/* Desktop status bar */}
          <div className="hidden sm:flex items-center gap-4 text-sm">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${status?.running ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
              <span className="text-zinc-400">{status?.running ? "Running" : "Stopped"}</span>
            </div>
            <span className="text-zinc-600">|</span>
            <span className="text-zinc-400">Uptime: {uptime}</span>
            <span className="text-zinc-600">|</span>
            <span className="text-zinc-400">Tick #{status?.tick_count ?? 0}</span>
            {coBadge && (
              <a href="/settings" className={`px-2 py-0.5 rounded text-xs font-bold ${coBadge.cls}`}>{coBadge.text}</a>
            )}
            <a href="/settings" className="px-3 py-1 rounded text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors">
              ⚙️ Settings
            </a>
          </div>

          {/* Mobile hamburger + status dot */}
          <div className="flex items-center gap-2 sm:hidden">
            <span className={`w-2 h-2 rounded-full ${status?.running ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
            <span className="text-xs text-zinc-400">#{status?.tick_count ?? 0}</span>
            {coBadge && <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${coBadge.cls}`}>{coBadge.text}</span>}
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-2 rounded hover:bg-zinc-800 transition-colors"
            >
              <span className="text-lg">{menuOpen ? "✕" : "☰"}</span>
            </button>
          </div>
        </div>

        {/* Mobile dropdown menu */}
        {menuOpen && (
          <div className="mt-3 flex flex-col gap-2 sm:hidden border-t border-zinc-800 pt-3">
            <div className="text-xs text-zinc-400">Uptime: {uptime} · PID {status?.pid ?? "?"}</div>
            <a
              href="/settings"
              className="w-full py-2 px-3 rounded text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-center transition-colors"
              onClick={() => setMenuOpen(false)}
            >
              ⚙️ Settings
            </a>
          </div>
        )}
      </header>

      <div className="p-4 sm:p-6">
        {/* Error banner */}
        {error && (
          <div className="mb-4 p-3 sm:p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200 text-xs sm:text-sm">
            ⚠️ Daemon unreachable: {error}
            <span className="text-zinc-500 ml-2">(last: {new Date(lastFetch).toLocaleTimeString()})</span>
          </div>
        )}

        {/* Retailer health */}
        <section className="mb-6">
          <h2 className="text-xs sm:text-sm text-zinc-500 uppercase tracking-wider mb-3">Retailer Health</h2>
          <div className="grid grid-cols-3 sm:grid-cols-3 gap-2 sm:gap-3">
            {status?.retailers.map((r) => {
              const healthy = r.errors === 0 || r.errors < (r.max_errors || 10);
              const lastTick = r.last_tick ? `${Math.round((Date.now() - r.last_tick) / 1000)}s ago` : "never";
              return (
                <div
                  key={r.retailer}
                  className={`p-3 sm:p-4 rounded-lg border ${healthy ? "border-zinc-700 bg-zinc-900" : "border-red-700 bg-red-900/20"}`}
                >
                  <div className="flex items-center justify-between mb-1 sm:mb-2">
                    <span className="font-semibold text-xs sm:text-sm">
                      <span className="hidden sm:inline">{RETAILER_EMOJI[r.retailer]} </span>
                      {r.retailer}
                    </span>
                    <span className={`text-[10px] sm:text-xs px-1.5 py-0.5 rounded ${healthy ? "bg-green-900/50 text-green-300" : "bg-red-900/50 text-red-300"}`}>
                      {r.errors}/{r.max_errors || 10}
                    </span>
                  </div>
                  <div className="text-[10px] sm:text-xs text-zinc-500">{lastTick}</div>
                </div>
              );
            }) ?? (
              <div className="col-span-3 text-zinc-600 text-xs sm:text-sm">No health data — daemon may not be running</div>
            )}
          </div>
        </section>

        {/* Checkout */}
        {co && (
          <section className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs sm:text-sm text-zinc-500 uppercase tracking-wider">Checkout</h2>
              <span className="text-[10px] sm:text-xs text-zinc-500">
                {co.armed.length} armed · ${co.spend_total.toFixed(2)} / ${co.max_total_spend} spent
              </span>
            </div>
            {Object.values(co.busy).map((b) => (
              <div key={b.key} className="mb-2 p-2 sm:p-3 rounded-lg border border-yellow-700 bg-yellow-900/20 text-yellow-200 text-xs animate-pulse">
                ⏳ {b.dry_run ? "Dry run" : "LIVE checkout"} running: {b.key} ({ago(b.started)})
              </div>
            ))}
            {co.recent.length === 0 ? (
              <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/50 text-zinc-600 text-xs">
                No checkout attempts yet. Use 🧪 Test on a product to verify login + checkout flow.
              </div>
            ) : (
              <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800 bg-zinc-900/50">
                {co.recent.slice(0, 8).map((a, i) => {
                  const st = ATTEMPT_STYLE[a.status] || { icon: "•", cls: "text-zinc-400", label: a.status };
                  return (
                    <div key={a.id || i} className="p-2 sm:p-3 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-words">
                          <span className={`font-bold ${st.cls}`}>{st.icon} {st.label}</span>{" "}
                          <span className="text-zinc-300">{a.label}</span>{" "}
                          <span className="text-zinc-600">({a.retailer})</span>
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

        {/* Product grid */}
        <section>
          <h2 className="text-xs sm:text-sm text-zinc-500 uppercase tracking-wider mb-3">
            Products <span className="hidden sm:inline">({status?.products.length ?? 0})</span>
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3">
            {status?.products.map((p) => (
              <div
                key={`${p.retailer}:${p.sku}`}
                className="p-3 sm:p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 active:border-zinc-600 transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-snug break-words">{p.label}</p>
                    <p className="text-[10px] sm:text-xs text-zinc-500 mt-0.5 truncate">{p.sku}</p>
                  </div>
                  <span
                    className={`shrink-0 text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 rounded font-bold whitespace-nowrap ${
                      p.in_stock === true
                        ? "bg-green-900/50 text-green-300"
                        : p.in_stock === false
                        ? "bg-zinc-800 text-zinc-400"
                        : "bg-yellow-900/30 text-yellow-300"
                    }`}
                  >
                    {p.in_stock === true ? "🟢 IN STOCK" : p.in_stock === false ? "🔴 OOS" : "⚪ UNKNOWN"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[10px] sm:text-xs text-zinc-500">
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase ${RETAILER_COLORS[p.retailer] || "bg-zinc-700"} text-white`}>
                    {p.retailer}
                  </span>
                  <span>{p.price || "—"}</span>
                </div>
                {p.last_checked && (
                  <p className="text-[10px] text-zinc-600 mt-2">
                    Checked {Math.round((Date.now() - p.last_checked) / 1000)}s ago
                  </p>
                )}
                {p.error && (
                  <p className="text-[10px] text-red-400 mt-1 break-words">⚠️ {p.error}</p>
                )}
                {co && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className={`text-[10px] ${co.armed.includes(`${p.retailer}:${p.sku}`) ? "text-green-400" : "text-zinc-600"}`}>
                      {co.armed.includes(`${p.retailer}:${p.sku}`) ? "🛒 Auto-checkout armed" : "Auto-checkout off"}
                    </span>
                    <button
                      onClick={() => runTest(p.retailer, p.sku)}
                      disabled={!!co.busy[p.retailer]}
                      className="px-2 py-1 rounded text-[10px] sm:text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40 transition-colors"
                    >
                      🧪 Test
                    </button>
                  </div>
                )}
                {testMsg[`${p.retailer}:${p.sku}`] && (
                  <p className="text-[10px] text-blue-300 mt-1 break-words">{testMsg[`${p.retailer}:${p.sku}`]}</p>
                )}
              </div>
            )) ?? (
              <div className="col-span-2 text-zinc-600 text-xs sm:text-sm">No product data</div>
            )}
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-8 sm:mt-12 pt-4 border-t border-zinc-800 text-[10px] sm:text-xs text-zinc-600 flex flex-col sm:flex-row justify-between gap-1">
          <span>Drop Bot • Pokémon Monitor + Auto-Checkout</span>
          <span>Last fetch: {new Date(lastFetch).toLocaleTimeString()}</span>
        </footer>
      </div>
    </main>
  );
}