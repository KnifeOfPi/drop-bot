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
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-3xl overflow-hidden shadow-2xl shadow-black/40 bg-zinc-900 border border-zinc-800">
        <div className="pokedex-header px-6 pt-8 pb-6 text-center">
          <span className="pokeball text-5xl" aria-hidden />
          <h1 className="text-2xl font-extrabold mt-4">Drop Bot</h1>
          <p className="text-sm text-zinc-200 mt-1">Enter your password to continue</p>
        </div>
        <form onSubmit={submit} className="space-y-4 p-6">
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(false); }}
            placeholder="Password"
            autoFocus
            className="w-full px-4 py-3 rounded-2xl bg-zinc-800 border border-zinc-700 focus:border-blue-500 outline-none text-base sm:text-lg text-center"
            inputMode="text"
            autoComplete="off"
          />
          {error && (
            <p className="text-red-400 text-xs sm:text-sm text-center font-semibold">Wrong password</p>
          )}
          <button
            type="submit"
            className="w-full py-3 rounded-2xl bg-yellow-500 hover:bg-yellow-400 active:bg-yellow-600 text-zinc-950 font-extrabold text-sm sm:text-base transition-colors"
          >
            Unlock
          </button>
        </form>
      </div>
    </main>
  );
}
