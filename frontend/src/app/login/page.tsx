"use client";

import { useState } from "react";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    window.location.href = `/login?p=${encodeURIComponent(password.trim())}`;
  };

  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "1" && !error) {
      setError(true);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4 font-mono">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-4xl mb-3">⚡</h1>
          <h2 className="text-xl sm:text-2xl font-bold">Drop Bot</h2>
          <p className="text-zinc-500 text-xs sm:text-sm mt-1">Enter password to continue</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(false); }}
            placeholder="Password"
            autoFocus
            className="w-full px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-700 focus:border-blue-500 outline-none text-base sm:text-lg text-center"
            inputMode="text"
            autoComplete="off"
          />
          {error && (
            <p className="text-red-400 text-xs sm:text-sm text-center">Wrong password</p>
          )}
          <button
            type="submit"
            className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-bold text-sm sm:text-base transition-colors"
          >
            Unlock
          </button>
        </form>
      </div>
    </main>
  );
}