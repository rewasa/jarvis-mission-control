/**
 * ClaudePanel — AgentControl UI component for Claude Code session management.
 *
 * Shows:
 * - Adapter status (claude-code-node vs python)
 * - Active sessions with cost/turn stats
 * - Auth status (logged in/out)
 * - Login button
 */

import React, { useEffect, useState } from "react";

interface ClaudeSession {
  id: string;
  model: string;
  createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  status: "idle" | "running";
  totalCostUsd: number;
}

interface AuthStatus {
  loggedIn?: boolean;
  account?: string;
  error?: string;
}

export function ClaudePanel() {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/claude/sessions")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setSessions(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    fetch("/api/claude/auth/status")
      .then((r) => r.json())
      .then(setAuth)
      .catch(() => {});
  }, []);

  const handleLogin = async () => {
    const r = await fetch("/api/claude/auth/login", { method: "POST" });
    const d = await r.json();
    alert(`Login: ${JSON.stringify(d)}`);
  };

  if (loading) {
    return (
      <div className="p-4 text-sm text-gray-400">Loading Claude adapter...</div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200">Claude Code</h3>
        {auth?.loggedIn ? (
          <span className="text-xs rounded-full bg-green-900/40 px-2 py-0.5 text-green-400">
            {auth.account || "Authenticated"}
          </span>
        ) : (
          <button
            onClick={handleLogin}
            className="text-xs rounded bg-blue-700 px-2 py-1 text-white hover:bg-blue-600"
          >
            Login
          </button>
        )}
      </div>

      {sessions.length === 0 ? (
        <p className="text-xs text-gray-500">No active sessions</p>
      ) : (
        <div className="flex flex-col gap-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="rounded border border-gray-800 bg-gray-900/50 p-2 text-xs"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-gray-300">{s.id}</span>
                <span className="text-gray-500">{s.model}</span>
              </div>
              <div className="mt-1 flex gap-3 text-gray-500">
                <span>{s.turnCount} turns</span>
                <span>${s.totalCostUsd.toFixed(4)}</span>
                <span className="text-gray-600">
                  {new Date(s.createdAt).toLocaleTimeString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="text-[10px] text-gray-600">
        Adapter: claude-code-node · Port 8082
      </div>
    </div>
  );
}
