// Drop Bot Dashboard — live monitor status
// Polls the daemon's health endpoint every 3s and renders
// product stock status, error counts, and uptime.

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
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6 font-mono">
      {/* Header */}
      <header className="flex items-center justify-between mb-8 pb-4 border-b border-zinc-800">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <span className="text-3xl">⚡</span> Drop Bot
          </h1>
          <p className="text-zinc-500 text-sm mt-1">
            Pokémon product monitor — {status ? `${status.products.length} products` : "..."} across 3 retailers
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${status?.running ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
            <span className="text-zinc-400">{status?.running ? "Running" : "Stopped"}</span>
          </div>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-400">Uptime: {uptime}</span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-400">Tick #{status?.tick_count ?? 0}</span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500 text-xs">PID {status?.pid ?? "?"}</span>
          <a href="/settings" className="px-3 py-1 rounded text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors">
            ⚙️ Settings
          </a>
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200 text-sm">
          ⚠️ Daemon unreachable: {error}
          <span className="text-zinc-500 ml-2">(last fetch: {new Date(lastFetch).toLocaleTimeString()})</span>
        </div>
      )}

      {/* Retailer health */}
      <section className="mb-8">
        <h2 className="text-sm text-zinc-500 uppercase tracking-wider mb-3">Retailer Health</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {status?.retailers.map((r) => {
            const healthy = r.errors === 0 || r.errors < (r.max_errors || 10);
            const lastTick = r.last_tick ? `${Math.round((Date.now() - r.last_tick) / 1000)}s ago` : "never";
            return (
              <div
                key={r.retailer}
                className={`p-4 rounded-lg border ${healthy ? "border-zinc-700 bg-zinc-900" : "border-red-700 bg-red-900/20"}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold">
                    {RETAILER_EMOJI[r.retailer]} {r.retailer}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded ${healthy ? "bg-green-900/50 text-green-300" : "bg-red-900/50 text-red-300"}`}>
                    {r.errors}/{r.max_errors || 10}
                  </span>
                </div>
                <div className="text-xs text-zinc-500">Last check: {lastTick}</div>
              </div>
            );
          }) ?? (
            <div className="col-span-3 text-zinc-600 text-sm">No health data — daemon may not be running</div>
          )}
        </div>
      </section>

      {/* Product grid */}
      <section>
        <h2 className="text-sm text-zinc-500 uppercase tracking-wider mb-3">Products</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {status?.products.map((p) => (
            <div
              key={`${p.retailer}:${p.sku}`}
              className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 transition-colors"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                  <p >{p.label}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{p.sku}</p>
                </div>
                <span
                  className={`shrink-0 ml-2 text-xs px-2 py-0.5 rounded font-bold ${
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
              <div className="flex items-center justify-between text-xs text-zinc-500">
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
                <p className="text-[10px] text-red-400 mt-1 truncate">⚠️ {p.error}</p>
              )}
            </div>
          )) ?? (
            <div className="col-span-3 text-zinc-600 text-sm">No product data</div>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-12 pt-4 border-t border-zinc-800 text-xs text-zinc-600 flex justify-between">
        <span>Drop Bot M1 • Pokémon Monitor</span>
        <span>Last fetch: {new Date(lastFetch).toLocaleTimeString()}</span>
      </footer>
    </main>
  );
}