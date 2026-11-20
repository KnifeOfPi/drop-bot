"use client";

import { useState } from "react";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);

  const submit = (e: React.FormEvent) => {
    if (!password.trim()) {
      e.preventDefault();
      return;
    }
    // Redirect via GET param — checked by middleware
    window.location.href = `/login?p=${encodeURIComponent(password.trim())}`;
    e.preventDefault();
  };

  // Check for error param on load
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "1" && !error) {
      setError(true);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center font-mono">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl mb-2">⚡</h1>
          <h2 className="text-xl font-bold">Drop Bot</h2>
          <p className="text-zinc-500 text-sm mt-1">Enter password to continue</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(false); }}
            placeholder="Password"
            autoFocus
            className="w-full px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-700 focus:border-blue-500 outline-none text-lg text-center"
          />
          {error && (
            <p className="text-red-400 text-sm text-center">Wrong password</p>
          )}
          <button
            type="submit"
            className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold transition-colors"
          >
            Unlock
          </button>
        </form>
      </div>
    </main>
  );
}