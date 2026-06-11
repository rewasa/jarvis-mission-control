import { Router } from "express";

const router = Router();

const CLAUDE_ADAPTER = "http://127.0.0.1:8082";

/**
 * Proxy to the Node.js Claude Adapter's session management endpoints.
 * GET  /api/claude/sessions       → list active sessions
 * GET  /api/claude/sessions/:id   → session detail
 * GET  /api/claude/auth/status    → claude auth status
 * POST /api/claude/auth/login     → trigger login
 */
router.get("/sessions", async (_req, res) => {
  try {
    const response = await fetch(`${CLAUDE_ADAPTER}/api/sessions`);
    const data = await response.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: "Claude adapter unreachable" });
  }
});

router.get("/sessions/:id", async (req, res) => {
  try {
    const response = await fetch(`${CLAUDE_ADAPTER}/api/sessions/${req.params.id}`);
    const data = await response.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: "Claude adapter unreachable" });
  }
});

router.get("/auth/status", async (_req, res) => {
  try {
    const response = await fetch(`${CLAUDE_ADAPTER}/auth/status`);
    const data = await response.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: "Claude adapter unreachable" });
  }
});

router.post("/auth/login", async (_req, res) => {
  try {
    const response = await fetch(`${CLAUDE_ADAPTER}/auth/login`, { method: "POST" });
    const data = await response.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: "Claude adapter unreachable" });
  }
});

export default router;
