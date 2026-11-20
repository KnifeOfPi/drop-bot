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

interface DaemonStatus {
  running: boolean;
  uptime_seconds: number;
  tick_count: number;
  products: ProductStatus[];
  retailers: RetailerHealth[];
  pid: number;
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
            <a href="/settings" className="px-3 py-1 rounded text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors">
              ⚙️ Settings
            </a>
          </div>

          {/* Mobile hamburger + status dot */}
          <div className="flex items-center gap-2 sm:hidden">
            <span className={`w-2 h-2 rounded-full ${status?.running ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
            <span className="text-xs text-zinc-400">#{status?.tick_count ?? 0}</span>
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
              </div>
            )) ?? (
              <div className="col-span-2 text-zinc-600 text-xs sm:text-sm">No product data</div>
            )}
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-8 sm:mt-12 pt-4 border-t border-zinc-800 text-[10px] sm:text-xs text-zinc-600 flex flex-col sm:flex-row justify-between gap-1">
          <span>Drop Bot M1 • Pokémon Monitor</span>
          <span>Last fetch: {new Date(lastFetch).toLocaleTimeString()}</span>
        </footer>
      </div>
    </main>
  );
}