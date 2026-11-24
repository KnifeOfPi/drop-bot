// Shapes returned by the daemon's /status endpoint.

export type ProductAction = "notify" | "assist" | "checkout";

export interface ProductStatus {
  key: string;
  retailer: string;
  label: string;
  sku: string;
  action: ProductAction;
  max_price: number | null;
  url: string | null;
  status: string; // in_stock | oos | queue | drawing_open | drawing_entered | blocked | error | unknown | pending
  in_stock: boolean | null;
  price: string;
  last_checked: number | null;
  since: number | null;
  error?: string;
  via?: string | null;
}

export interface RetailerHealth {
  retailer: string;
  name: string;
  errors: number;
  max_errors: number;
  last_tick: number | null;
  interval: number | null;
  hot: string | null;
  busy: boolean;
  session_open: boolean;
  watch?: string | null;
}

export interface Attempt {
  id?: string;
  ts: number;
  key: string;
  retailer: string;
  label: string;
  status: string;
  trigger?: string;
  mode?: string;
  total?: number | null;
  order_number?: string | null;
  error?: string;
  message?: string;
  duration_ms?: number;
}

export interface Handoff {
  id: string;
  key: string;
  retailer: string;
  label: string;
  reason: string;
  code: string | null;
  total: number | null;
  started: number;
  expires: number;
  url: string | null;
}

export interface BusyFlow {
  key: string;
  label: string;
  kind: "buy" | "drawing";
  mode: string;
  started: number;
  in_queue: boolean;
}

export interface CheckoutStatus {
  enabled: boolean;
  dry_run: boolean;
  auto_enter_drawings: boolean;
  max_orders_per_product: number;
  max_total_spend: number;
  spend_total: number;
  armed: string[];
  actions: Record<string, ProductAction>;
  busy: Record<string, BusyFlow>;
  handoffs: Handoff[];
  recent: Attempt[];
}

export interface Listing {
  id: string;
  retailer: string;
  title: string;
  url: string;
  price: string | null;
  query: string;
  found: number;
  watched: boolean;
}

export interface DiscoveryStatus {
  enabled: boolean;
  interval_minutes: number;
  queries: string[];
  last_run: number | null;
  running: boolean;
  errors: Record<string, string>;
  recent: Listing[];
}

export interface AccountStatus {
  logged_in: boolean | null;
  checked_at: number | null;
  note: string | null;
  cvv_set: boolean;
  cvv_source: "env" | "dashboard" | null;
}

export interface LoginSession {
  id: string;
  retailer: string;
  started: number;
  expires: number;
  url: string | null;
}

export interface ProxyStatus {
  set: boolean;
  source: "env" | "dashboard" | null;
  server: string | null;
  user: string | null;
  stores: string[] | null; // null = every store
}

export interface StoreUsage {
  monitor: number;
  discovery: number;
  flow: number;
  total: number;
  via_proxy: boolean;
}

export interface BandwidthStatus {
  today: string;
  stores: Record<string, StoreUsage>;
  total_today: number;
  proxy_today: number;
  proxy_last_hour?: number;
  limit_mb?: number;
  days: Array<{ day: string; total: number }>;
}

export function fmtBytes(n: number | null | undefined) {
  const b = n || 0;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export interface DaemonStatus {
  running: boolean;
  pause?: {
    paused: boolean;
    since: number | null;
    reason?: "manual" | "data_limit" | null;
    history?: Array<{ at: number; paused: boolean; by: string; reason: string }>;
  };
  uptime_seconds: number;
  pid: number;
  products: ProductStatus[];
  retailers: RetailerHealth[];
  checkout?: CheckoutStatus;
  discovery?: DiscoveryStatus;
  accounts?: Record<string, AccountStatus>;
  login_sessions?: LoginSession[];
  proxy?: ProxyStatus;
  bandwidth?: BandwidthStatus;
}

export const RETAILERS: Array<{ id: string; name: string; emoji: string; color: string; idField: "tcin" | "sku" | "url"; idLabel: string }> = [
  { id: "target", name: "Target", emoji: "🎯", color: "bg-red-600", idField: "tcin", idLabel: "TCIN" },
  { id: "best-buy", name: "Best Buy", emoji: "🔵", color: "bg-blue-600", idField: "sku", idLabel: "SKU" },
  { id: "walmart", name: "Walmart", emoji: "🟦", color: "bg-sky-600", idField: "url", idLabel: "Product URL" },
  { id: "costco", name: "Costco", emoji: "🔴", color: "bg-rose-700", idField: "url", idLabel: "Product URL" },
  { id: "sams-club", name: "Sam's Club", emoji: "🔷", color: "bg-cyan-700", idField: "url", idLabel: "Product URL" },
  { id: "pokemon-center", name: "Pokémon Center", emoji: "⚡", color: "bg-yellow-500", idField: "url", idLabel: "Product URL" },
];

export const retailerInfo = (id: string) => RETAILERS.find((r) => r.id === id);

export const ACTION_LABELS: Record<ProductAction, { short: string; long: string }> = {
  notify: { short: "🔔 Notify", long: "🔔 Just notify me" },
  assist: { short: "🙋 Queue + cart", long: "🙋 Queue + cart, I finish" },
  checkout: { short: "🛒 Auto-buy", long: "🛒 Queue + buy it for me" },
};

export function ago(ts: number | null | undefined) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export async function postJson(path: string, body: unknown): Promise<{ ok?: boolean; message?: string; error?: string }> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { error: data.error || `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "request failed" };
  }
}
