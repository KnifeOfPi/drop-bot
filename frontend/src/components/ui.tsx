// Small shared UI kit: line icons (instead of emojis) and status pills.

import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  pause: (<><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>),
  play: <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" />,
  sliders: (<><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4" /></>),
  key: (<><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2" /></>),
  dots: (<><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>),
  cart: (<><circle cx="8" cy="21" r="1" /><circle cx="19" cy="21" r="1" /><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" /></>),
  flask: <path d="M9 3h6M10 3v6L4.5 18.4A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.6L14 9V3" />,
  ticket: (<><path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4Z" /><path d="M13 6v2M13 16v2M13 11v2" /></>),
  external: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
  search: (<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M20 6 9 17l-5-5" />,
  alert: (<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>),
  phone: (<><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M11 18h2" /></>),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  back: <path d="m15 18-6-6 6-6" />,
};

export function Icon({ name, className = "w-4 h-4" }: { name: keyof typeof PATHS | string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

// Subtle tinted pill with a colour dot — one style for every status.
const TONES = {
  green: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25",
  blue: "bg-sky-500/10 text-sky-300 ring-sky-500/25",
  violet: "bg-violet-500/10 text-violet-300 ring-violet-500/25",
  amber: "bg-amber-500/10 text-amber-300 ring-amber-500/25",
  red: "bg-red-500/10 text-red-300 ring-red-500/25",
  yellow: "bg-yellow-400/10 text-yellow-300 ring-yellow-400/30",
  gray: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20",
} as const;
const DOTS = {
  green: "bg-emerald-400", blue: "bg-sky-400", violet: "bg-violet-400", amber: "bg-amber-400",
  red: "bg-red-400", yellow: "bg-yellow-400", gray: "bg-zinc-500",
} as const;
export type Tone = keyof typeof TONES;

export function Pill({ tone = "gray", pulse = false, children }: { tone?: Tone; pulse?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap ${TONES[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOTS[tone]} ${pulse ? "animate-pulse" : ""}`} />
      {children}
    </span>
  );
}

export const PRODUCT_STATUS: Record<string, { label: string; tone: Tone }> = {
  in_stock: { label: "In stock", tone: "green" },
  queue: { label: "Queue live", tone: "blue" },
  drawing_open: { label: "Drawing open", tone: "violet" },
  drawing_entered: { label: "Entered", tone: "violet" },
  oos: { label: "Out of stock", tone: "gray" },
  blocked: { label: "Blocked", tone: "amber" },
  error: { label: "Error", tone: "red" },
  unknown: { label: "Unknown", tone: "gray" },
  pending: { label: "Not checked", tone: "gray" },
};

export const ATTEMPT_STATUS: Record<string, { label: string; tone: Tone }> = {
  success: { label: "Ordered", tone: "green" },
  unconfirmed: { label: "Unconfirmed", tone: "amber" },
  handoff: { label: "Handed to you", tone: "yellow" },
  dry_run: { label: "Dry run OK", tone: "blue" },
  failed: { label: "Failed", tone: "red" },
  guard: { label: "Blocked", tone: "gray" },
  drawing_entered: { label: "Drawing entered", tone: "violet" },
  drawing_manual: { label: "Enter drawing yourself", tone: "yellow" },
  abandoned: { label: "Not bought", tone: "gray" },
  handoff_expired: { label: "Hand-off expired", tone: "gray" },
  handoff_closed: { label: "Hand-off closed", tone: "gray" },
};

// Button styles
export const btn = {
  primary: "inline-flex items-center justify-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold disabled:opacity-40 transition-colors",
  secondary: "inline-flex items-center justify-center gap-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 ring-1 ring-inset ring-zinc-700 font-medium disabled:opacity-40 transition-colors",
  ghost: "inline-flex items-center justify-center gap-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 font-medium disabled:opacity-40 transition-colors",
};
