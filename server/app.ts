import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { tasksRouter } from './routes/tasks.js';
import { chatRouter } from './routes/chat.js';
import { createAgentRouter, createTaskAgentSettingsRouter } from './routes/agent.js';
import { createScheduledTasksRouter } from './routes/scheduled-tasks.js';
import { skillsRouter } from './routes/skills.js';
import { filesRouter } from './routes/files.js';
import { githubStatusRouter } from './routes/github-status.js';
import { githubWebhookRouter } from './routes/github-webhook.js';
import { integrationsRouter } from './routes/integrations.js';
import { kanbanBoardsRouter } from './routes/kanban.js';
import { HermesWorkerAdapter } from './adapters/hermes-worker.js';
import { initSSE, addClient, sendEvent } from './events.js';
import { getRunStatuses } from './live-chat.js';
import { getAppVersion } from './version.js';

const app = express();

app.use(cors());

const adapter = new HermesWorkerAdapter();

app.get('/api/health', async (_req, res) => {
  const hermes = await adapter.healthCheck();
  let claudeAdapter = false;
  try {
    const response = await fetch('http://127.0.0.1:8082/health');
    claudeAdapter = response.ok;
  } catch {
    // Adapter not running — report as false
  }
  res.json({ ok: true, hermes, claudeAdapter });
});

app.get('/api/auth/status', async (_req, res) => {
  try {
    const response = await fetch('http://127.0.0.1:8082/auth/status');
    if (response.ok) {
      const data = await response.json();
      res.json(data);
    } else {
      res.status(response.status).json({ error: 'Failed to fetch auth status' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Claude adapter is not reachable' });
  }
});

app.post('/api/auth/login', async (_req, res) => {
  try {
    const response = await fetch('http://127.0.0.1:8082/auth/login', { method: 'POST' });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Claude adapter is not reachable' });
  }
});

app.get('/api/version', (_req, res) => {
  res.json(getAppVersion());
});

app.get('/api/events', (req, res) => {
  initSSE(res);
  addClient(res);
  sendEvent(res, { type: 'task_runs_snapshot', runs: getRunStatuses() });
});

app.use('/api/files', express.json({ limit: '25mb' }), filesRouter);

app.use(express.json());

app.use('/api/tasks', tasksRouter);
app.use('/api/tasks', createTaskAgentSettingsRouter(adapter));
app.use('/api/tasks', chatRouter);
app.use('/api/agent', createAgentRouter(adapter));
app.use('/api/scheduled-tasks', createScheduledTasksRouter(adapter));
app.use('/api/skills', skillsRouter);
app.use('/api/tasks', githubStatusRouter);
app.use('/api/github', githubWebhookRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/kanban', kanbanBoardsRouter);

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!res.headersSent && error && typeof error === 'object' && (error as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }
  next(error);
});

export { adapter };
export default app;
