// Settings page — configure products, webhooks, monitor intervals

"use client";

import { useState, useEffect, useCallback } from "react";

interface Config {
  products?: Array<{
    retailer: string;
    tcin?: string;
    sku?: string;
    url?: string;
    label: string;
    max_price?: number;
  }>;
  discord?: Record<string, string>;
  monitor?: { interval_seconds?: number; max_consecutive_errors?: number };
  notifications?: Record<string, number>;
}

export default function Settings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"products" | "webhooks" | "monitor">("products");

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const data = await res.json();
        if (!data.error) setConfig(data);
      }
    } catch {}
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const updateConfig = (updates: any) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const merged = structuredClone(prev);
      function deepMerge(target: any, source: any) {
        for (const key of Object.keys(source)) {
          if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
            if (!target[key] || typeof target[key] !== "object") target[key] = {};
            deepMerge(target[key], source[key]);
          } else {
            target[key] = source[key];
          }
        }
      }
      deepMerge(merged, updates);
      return merged;
    });
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    if (!config) return;
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        setDirty(false);
        setSaved(true);
        setError(null);
        setTimeout(() => setSaved(false), 3000);
      } else {
        const data = await res.json();
        setError(data.error || "Save failed");
      }
    } catch (e: any) {
      setError(e.message);
    }
  };

  const addProduct = () => {
    updateConfig({
      products: [...(config?.products || []), { retailer: "target", tcin: "", sku: "", url: "", label: "New Product", max_price: undefined }],
    });
  };

  const removeProduct = (idx: number) => {
    const products = [...(config?.products || [])];
    products.splice(idx, 1);
    updateConfig({ products });
  };

  const updateProduct = (idx: number, field: string, value: any) => {
    const products = [...(config?.products || [])];
    products[idx] = { ...products[idx], [field]: value };
    updateConfig({ products });
  };

  if (!config) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6 font-mono flex items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading config...</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6 font-mono">
      <header className="flex items-center justify-between mb-8 pb-4 border-b border-zinc-800">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <span className="text-3xl">⚙️</span> Settings
          </h1>
          <p className="text-zinc-500 text-sm mt-1">Configure products, webhooks, and monitor behavior</p>
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="text-green-400 text-sm">✅ Saved</span>}
          {error && <span className="text-red-400 text-sm">⚠️ {error}</span>}
          <button
            onClick={save}
            disabled={!dirty}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
              dirty ? "bg-green-600 hover:bg-green-500 text-white" : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
            }`}
          >
            Save
          </button>
          <a href="/" className="px-3 py-2 rounded-lg text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors">
            ← Dashboard
          </a>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {(["products", "webhooks", "monitor"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === tab ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab === "products" ? "📦 Products" : tab === "webhooks" ? "🔗 Discord Webhooks" : "⏱️ Monitor"}
          </button>
        ))}
      </div>

      {/* Products tab */}
      {activeTab === "products" && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm text-zinc-500 uppercase tracking-wider">Watchlist ({config.products?.length || 0})</h2>
            <button
              onClick={addProduct}
              className="px-3 py-1.5 rounded text-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              + Add Product
            </button>
          </div>
          <div className="space-y-3">
            {config.products?.map((p, i) => (
              <div key={i} className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="text-[10px] text-zinc-500 uppercase block mb-1">Label</label>
                    <input
                      type="text"
                      value={p.label}
                      onChange={(e) => updateProduct(i, "label", e.target.value)}
                      className="w-full px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-sm focus:border-blue-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500 uppercase block mb-1">Retailer</label>
                    <select
                      value={p.retailer}
                      onChange={(e) => updateProduct(i, "retailer", e.target.value)}
                      className="w-full px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-sm focus:border-blue-500 outline-none"
                    >
                      <option value="target">Target</option>
                      <option value="best-buy">Best Buy</option>
                      <option value="pokemon-center">Pokémon Center</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500 uppercase block mb-1">
                      {p.retailer === "target" ? "TCIN" : p.retailer === "best-buy" ? "SKU" : "URL"}
                    </label>
                    <input
                      type="text"
                      value={p.retailer === "pokemon-center" ? p.url || "" : p.retailer === "best-buy" ? p.sku || "" : p.tcin || ""}
                      onChange={(e) => {
                        const field = p.retailer === "pokemon-center" ? "url" : p.retailer === "best-buy" ? "sku" : "tcin";
                        updateProduct(i, field, e.target.value);
                      }}
                      className="w-full px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-sm focus:border-blue-500 outline-none font-mono text-xs"
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <label className="text-[10px] text-zinc-500 uppercase block mb-1">Max Price ($)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={p.max_price ?? ""}
                        onChange={(e) => updateProduct(i, "max_price", e.target.value ? parseFloat(e.target.value) : undefined)}
                        className="w-full px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-sm focus:border-blue-500 outline-none"
                      />
                    </div>
                    <button
                      onClick={() => removeProduct(i)}
                      className="px-2 py-1.5 rounded text-sm bg-red-900/50 hover:bg-red-800 text-red-300 transition-colors shrink-0"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Webhooks tab */}
      {activeTab === "webhooks" && (
        <section>
          <h2 className="text-sm text-zinc-500 uppercase tracking-wider mb-4">Discord Webhooks ({Object.keys(config.discord || {}).length})</h2>
          <div className="space-y-3">
            {Object.entries(config.discord || {}).map(([key, value]) => (
              <div key={key} className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
                <label className="text-[10px] text-zinc-500 uppercase block mb-1">{key.replace(/_/g, " ")}</label>
                <input
                  type="text"
                  value={value || ""}
                  onChange={(e) => updateConfig({ discord: { ...config.discord, [key]: e.target.value } })}
                  placeholder="https://discord.com/api/webhooks/..."
                  className="w-full px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-sm focus:border-blue-500 outline-none font-mono text-xs"
                />
                <p className="text-[10px] text-zinc-600 mt-1">
                  {key === "drop_alerts" ? "Product stock alerts" :
                   key === "health" ? "Bot health/startup/error pings" :
                   key === "queue_live" ? "Queue opening alerts (Pokémon Center)" : ""}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Monitor tab */}
      {activeTab === "monitor" && (
        <section>
          <h2 className="text-sm text-zinc-500 uppercase tracking-wider mb-4">Monitor Settings</h2>
          <div className="space-y-4 max-w-md">
            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <label className="text-[10px] text-zinc-500 uppercase block mb-1">Poll Interval (seconds)</label>
              <input
                type="number"
                value={config.monitor?.interval_seconds ?? 3}
                onChange={(e) => updateConfig({ monitor: { ...config.monitor, interval_seconds: parseInt(e.target.value) || 3 } })}
                className="w-full px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-sm focus:border-blue-500 outline-none"
                min={1}
                max={30}
              />
              <p className="text-[10px] text-zinc-600 mt-1">How often to check each retailer (1-30s)</p>
            </div>
            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <label className="text-[10px] text-zinc-500 uppercase block mb-1">Max Consecutive Errors</label>
              <input
                type="number"
                value={config.monitor?.max_consecutive_errors ?? 10}
                onChange={(e) => updateConfig({ monitor: { ...config.monitor, max_consecutive_errors: parseInt(e.target.value) || 10 } })}
                className="w-full px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-sm focus:border-blue-500 outline-none"
                min={3}
                max={50}
              />
              <p className="text-[10px] text-zinc-600 mt-1">Pause retailer after this many errors in a row</p>
            </div>
            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <label className="text-[10px] text-zinc-500 uppercase block mb-1">Alert Throttle (seconds)</label>
              <input
                type="number"
                value={config.notifications?.throttle_same_product_seconds ?? 300}
                onChange={(e) => updateConfig({ notifications: { ...config.notifications, throttle_same_product_seconds: parseInt(e.target.value) || 300 } })}
                className="w-full px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-sm focus:border-blue-500 outline-none"
                min={30}
                max={3600}
              />
              <p className="text-[10px] text-zinc-600 mt-1">Don't re-alert for same product within this window</p>
            </div>
          </div>
        </section>
      )}

      <footer className="mt-12 pt-4 border-t border-zinc-800 text-xs text-zinc-600">
        Changes require daemon restart to take effect
      </footer>
    </main>
  );
}