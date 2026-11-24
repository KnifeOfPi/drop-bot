"use client";

// Live view — drive one of the bot's browser tabs from your phone: a checkout
// hand-off, or signing in to a store (Accounts page).
// Tap the screenshot to click there; use the box below to type.

import Link from "next/link";
import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/types";

export default function LiveView() {
  const router = useRouter();
  const [id, setId] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ url: string; title: string }>({ url: "", title: "" });
  const [closed, setClosed] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [tap, setTap] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  // Hold mode: pressing the picture holds the bot's mouse down until you let go
  // (for "Press & hold" checks). A quick tap in normal mode is a click.
  const [holdMode, setHoldMode] = useState(false);
  const [heldSince, setHeldSince] = useState<number | null>(null);
  const [holdNow, setHoldNow] = useState(0);
  const downSent = useRef<Promise<unknown> | null>(null);
  const [kind, setKind] = useState<"handoff" | "login" | null>(null);
  const [mask, setMask] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const lastUrl = useRef<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    setId(new URLSearchParams(window.location.search).get("id"));
  }, []);

  const refresh = useCallback(async () => {
    if (!id || inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`/api/d/live/frame?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.status === 404) { setClosed(true); return; }
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
      lastUrl.current = url;
      setSrc(url);
      setMeta({
        url: decodeURIComponent(res.headers.get("x-frame-url") || ""),
        title: decodeURIComponent(res.headers.get("x-frame-title") || ""),
      });
      const k = res.headers.get("x-session-kind");
      if (k === "login" || k === "handoff") {
        setKind((prev) => {
          if (prev === null && k === "login") setMask(true); // hide what you type while signing in
          return k;
        });
      }
    } catch {
      /* transient */
    } finally {
      inFlight.current = false;
    }
  }, [id]);

  useEffect(() => {
    if (!id || closed) return;
    refresh();
    const t = setInterval(refresh, 900);
    return () => clearInterval(t);
  }, [id, closed, refresh]);

  const send = async (action: Record<string, unknown>) => {
    if (!id) return;
    const r = await postJson("/api/d/live/input", { id, ...action });
    if (r.error) setNote(r.error);
    setTimeout(refresh, 150);
  };

  const onTap = (e: React.MouseEvent<HTMLImageElement>) => {
    const el = imgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setTap({ x, y });
    setTimeout(() => setTap(null), 600);
    send({ type: "click", x, y });
  };

  const pointAt = (clientX: number, clientY: number) => {
    const rect = imgRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  };

  const holdStart = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!holdMode || !imgRef.current || !id) return;
    e.preventDefault();
    imgRef.current.setPointerCapture?.(e.pointerId);
    const { x, y } = pointAt(e.clientX, e.clientY);
    setTap({ x, y });
    setHeldSince(Date.now());
    downSent.current = postJson("/api/d/live/input", { id, type: "down", x, y });
  };

  const holdEnd = async () => {
    if (!downSent.current || !id) return;
    const pending = downSent.current;
    downSent.current = null;
    setHeldSince(null);
    setTap(null);
    await pending; // the press must land before the release
    const r = await postJson("/api/d/live/input", { id, type: "up" });
    if (r.error) setNote(r.error);
    setTimeout(refresh, 150);
  };

  useEffect(() => {
    if (!heldSince) return;
    const t = setInterval(() => setHoldNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [heldSince]);

  const resolve = async (outcome: "success" | "abandoned") => {
    if (!id) return;
    if (outcome === "abandoned" && !window.confirm("Close this session without buying?")) return;
    const r = await postJson("/api/d/handoff/resolve", { id, outcome });
    if (r.error) setNote(r.error);
    else router.push("/");
  };

  const finishLogin = async () => {
    if (!id) return;
    setFinishing(true);
    setNote("Checking that you're signed in…");
    const r = await postJson("/api/d/accounts/done", { id });
    setFinishing(false);
    setNote(r.message || r.error || null);
    if (!r.error) setTimeout(() => router.push("/accounts"), 1200);
  };

  if (!id) return <main className="min-h-screen bg-zinc-950 text-zinc-400 p-6 text-sm">No session id. Open Live view from the dashboard.</main>;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-20 pokedex-header px-3 py-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold">📱 Live view</p>
          <p className="text-[10px] text-zinc-500 truncate">{meta.title || meta.url || "connecting…"}</p>
        </div>
        <Link href="/" className="shrink-0 px-2 py-1 rounded-xl text-xs bg-zinc-800 text-zinc-400">← Dashboard</Link>
      </header>

      {closed ? (
        <div className="p-6 text-sm text-zinc-400 space-y-3">
          <p>This session is closed — it was completed, expired, or the tab was closed.</p>
          <div className="flex gap-2">
            <Link href="/" className="inline-block px-3 py-2 rounded-xl bg-zinc-800 text-zinc-200">Dashboard</Link>
            <Link href="/accounts" className="inline-block px-3 py-2 rounded-xl bg-zinc-800 text-zinc-200">Accounts</Link>
          </div>
        </div>
      ) : (
        <div className="p-2 sm:p-4 space-y-3 max-w-4xl mx-auto">
          <div className="flex items-center justify-end gap-1 text-xs">
            <button
              onClick={() => setHoldMode(!holdMode)}
              className={`mr-auto px-3 py-1 rounded-xl font-bold ${holdMode ? "bg-yellow-500 text-zinc-950" : "bg-zinc-800 text-zinc-300"}`}
              title="For 'Press & hold' checks: press the picture and keep holding"
            >✋ Hold {holdMode ? "on" : "off"}</button>
            <span className="text-zinc-500 mr-1">Zoom</span>
            {[1, 2, 3].map((z) => (
              <button key={z} onClick={() => setZoom(z)} className={`px-2 py-1 rounded-xl ${zoom === z ? "bg-blue-700 text-white" : "bg-zinc-800 text-zinc-400"}`}>{z}×</button>
            ))}
          </div>
          <div className="rounded-2xl overflow-auto border border-zinc-700 bg-black select-none max-h-[70vh]">
          <div className="relative" style={{ width: `${zoom * 100}%` }}>
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={imgRef}
                src={src}
                alt="Bot browser"
                onClick={holdMode ? undefined : onTap}
                onPointerDown={holdStart}
                onPointerUp={holdEnd}
                onPointerCancel={holdEnd}
                onContextMenu={(e) => e.preventDefault()}
                className="w-full h-auto cursor-pointer"
                style={holdMode ? { touchAction: "none", WebkitTouchCallout: "none", userSelect: "none" } : undefined}
                draggable={false}
              />
            ) : (
              <div className="aspect-video flex items-center justify-center text-zinc-600 text-xs">Loading…</div>
            )}
            {tap && (
              <span
                className="absolute w-6 h-6 -ml-3 -mt-3 rounded-full border-2 border-yellow-400 animate-ping pointer-events-none"
                style={{ left: `${tap.x * 100}%`, top: `${tap.y * 100}%` }}
              />
            )}
          </div>
          </div>

          {holdMode && (
            <p className={`text-center text-xs font-bold ${heldSince ? "text-yellow-300" : "text-zinc-400"}`}>
              {heldSince
                ? `Holding… ${(Math.max(0, holdNow - heldSince) / 1000).toFixed(1)} s — let go when the check is done`
                : "Hold mode: press on the button in the picture and keep holding until it completes."}
            </p>
          )}

          <div className="grid grid-cols-4 gap-2 text-xs">
            <button onClick={() => send({ type: "scroll", dy: -500 })} className="py-2 rounded-xl bg-zinc-800">▲ Up</button>
            <button onClick={() => send({ type: "scroll", dy: 500 })} className="py-2 rounded-xl bg-zinc-800">▼ Down</button>
            <button onClick={() => send({ type: "back" })} className="py-2 rounded-xl bg-zinc-800">← Back</button>
            <button onClick={() => send({ type: "reload" })} className="py-2 rounded-xl bg-zinc-800">⟳ Reload</button>
          </div>

          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); if (text) { send({ type: "type", text }); setText(""); } }}
          >
            <input
              type={mask ? "password" : "text"}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Tap a field above, then type here"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-zinc-800 border border-zinc-700 text-sm outline-none focus:border-blue-500"
            />
            <button type="button" onClick={() => setMask(!mask)} title={mask ? "Show what I type" : "Hide what I type"} className="px-2 py-2 rounded-xl bg-zinc-800 text-sm">{mask ? "🙈" : "👁"}</button>
            <button type="submit" className="px-3 py-2 rounded-xl bg-blue-700 text-white text-sm">Type</button>
          </form>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <button onClick={() => send({ type: "key", key: "Enter" })} className="py-2 rounded-xl bg-zinc-800">⏎ Enter</button>
            <button onClick={() => send({ type: "key", key: "Tab" })} className="py-2 rounded-xl bg-zinc-800">⇥ Tab</button>
            <button onClick={() => send({ type: "key", key: "Backspace" })} className="py-2 rounded-xl bg-zinc-800">⌫ Delete</button>
          </div>

          {note && <p className="text-xs text-amber-300">{note}</p>}

          {kind === "login" ? (
            <>
              <div className="pt-2 border-t border-zinc-800">
                <button disabled={finishing} onClick={finishLogin} className="w-full py-3 rounded-2xl bg-green-700 hover:bg-green-600 text-white text-sm font-bold disabled:opacity-50">
                  ✅ Done signing in
                </button>
              </div>
              <p className="text-[10px] text-zinc-600">
                Tap the email field in the picture, type it in the box, then the same for your password (hidden with 🙈) and any
                verification code. Tick “keep me signed in” if the store offers it. The login is saved in the bot&apos;s browser on its server.
                <br /><b className="text-amber-300">Passkeys and “sign in with your phone” can&apos;t work here</b> — this browser runs on the server,
                not on your device. Choose password (and a text/email code) instead.
              </p>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-zinc-800">
                <button onClick={() => resolve("success")} className="py-3 rounded-2xl bg-green-700 hover:bg-green-600 text-white text-sm font-bold">✅ I bought it</button>
                <button onClick={() => resolve("abandoned")} className="py-3 rounded-2xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm">↩️ Didn&apos;t buy</button>
              </div>
              <p className="text-[10px] text-zinc-600">
                The bot also notices the order confirmation page by itself. Taps go to the bot&apos;s real browser — everything you do here happens on your account.
              </p>
            </>
          )}
        </div>
      )}
    </main>
  );
}
