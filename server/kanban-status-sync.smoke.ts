import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const tmpHome = await mkdtemp(join(tmpdir(), 'agentcontrol-kanban-status-smoke-'));
const tmpHermesHome = join(tmpHome, 'hermes');
const board = 'jarvis-mission-control';
const baseUrl = 'http://127.0.0.1:47611';
let server: ChildProcess | null = null;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function waitForServer(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      const health = await request<{ ok: boolean }>('/api/health');
      if (health.ok) return;
    } catch {
      // Keep polling until the server binds.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for smoke server');
}

function startServer(): ChildProcess {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: '47611',
    HOST: '127.0.0.1',
    AGENTCONTROL_HOME: tmpHome,
    HERMES_HOME: tmpHermesHome,
    HERMES_KANBAN_HOME: tmpHermesHome,
    DB_PATH: join(tmpHome, 'data', 'agentcontrol.db'),
  };

  const nodeBinary = process.env.AGENTCONTROL_SMOKE_NODE
    || '/Users/renatowasescha/.nvm/versions/node/v22.22.0/bin/node';
  const child = spawn(nodeBinary, ['dist/server/server/index.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function stopServer(child: ChildProcess | null): Promise<void> {
  if (!child || child.killed) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

function sqlLiteral(value: string | number | null): string {
  if (typeof value === 'number') return String(value);
  if (value === null) return 'NULL';
  return `'${value.replaceAll("'", "''")}'`;
}

function runSql(dbPath: string, sql: string): void {
  execFileSync('sqlite3', [dbPath], {
    input: sql,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function createKanbanFixture(): string {
  const dbPath = join(tmpHermesHome, 'kanban', 'boards', board, 'kanban.db');
  const now = Date.now();
  const started = now - 120_000;
  const heartbeat = now - 90_000;
  runSql(dbPath, `
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      assignee TEXT,
      status TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      workspace_kind TEXT NOT NULL DEFAULT 'scratch',
      workspace_path TEXT,
      branch_name TEXT,
      claim_lock TEXT,
      claim_expires INTEGER,
      tenant TEXT,
      result TEXT,
      idempotency_key TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      worker_pid INTEGER,
      last_failure_error TEXT,
      max_runtime_seconds INTEGER,
      last_heartbeat_at INTEGER,
      current_run_id INTEGER,
      workflow_template_id TEXT,
      current_step_key TEXT,
      skills TEXT,
      model_override TEXT,
      max_retries INTEGER,
      session_id TEXT,
      goal_mode INTEGER NOT NULL DEFAULT 0,
      goal_max_turns INTEGER
    );
    CREATE TABLE task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      profile TEXT,
      step_key TEXT,
      status TEXT NOT NULL,
      claim_lock TEXT,
      claim_expires INTEGER,
      worker_pid INTEGER,
      max_runtime_seconds INTEGER,
      last_heartbeat_at INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      outcome TEXT,
      summary TEXT,
      metadata TEXT,
      error TEXT
    );
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_id INTEGER,
      kind TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      author TEXT,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO tasks (
      id, title, body, assignee, status, priority, created_by, created_at,
      started_at, workspace_kind, consecutive_failures, last_heartbeat_at,
      current_run_id
    ) VALUES (
      't_smoke001', 'Kanban status sync smoke', 'Smoke task body', 'smoke-profile',
      'running', 0, 'smoke', ${now}, ${started}, 'scratch', 0, ${heartbeat}, 1
    );
    INSERT INTO task_runs (
      id, task_id, profile, status, worker_pid, last_heartbeat_at, started_at,
      ended_at, outcome, summary, metadata, error
    ) VALUES (
      1, 't_smoke001', 'smoke-profile', 'running', 12345, ${heartbeat},
      ${started}, NULL, NULL, 'still running', ${sqlLiteral('{"source":"smoke"}')}, NULL
    );
    INSERT INTO task_events (task_id, run_id, kind, payload, created_at)
    VALUES ('t_smoke001', 1, 'worker_log', ${sqlLiteral('{"message":"real kanban log"}')}, ${now});
    INSERT INTO task_comments (task_id, author, body, created_at)
    VALUES ('t_smoke001', 'smoke', 'real kanban comment', ${now});
  `);
  return dbPath;
}
await execFileAsync('npm', ['run', 'build:server']);
await execFileAsync('npm', ['run', 'build:assets']);

try {
  await mkdir(join(tmpHermesHome, 'kanban', 'boards', board), { recursive: true });
  createKanbanFixture();
  server = startServer();
  await waitForServer();

  const created = await request<{
    task: { id: string; status: string; delegation_status: string | null; hermes_kanban_task_id: string | null };
  }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Kanban status sync smoke AC task',
      description: 'Mapped to pre-created Kanban smoke task.',
      kanban: false,
    }),
  });

  await request(`/api/tasks/${created.task.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'todo',
      delegation_status: 'running',
      hermes_kanban_task_id: 't_smoke001',
    }),
  });

  const synced = await request<{
    task: {
      id: string;
      status: string;
      delegation_status: string | null;
      hermes_kanban_task_id: string | null;
      delegation_profile: string | null;
      assignee: string | null;
    };
  }>(`/api/tasks/${created.task.id}`);

  assert.equal(synced.task.status, 'in_progress');
  assert.equal(synced.task.delegation_status, null);
  assert.equal(synced.task.delegation_profile, 'smoke-profile');
  assert.equal(synced.task.assignee, 'smoke-profile');

  const listing = await request<{ tasks: Array<{ id: string; status: string; delegation_status: string | null }> }>('/api/tasks');
  const listed = listing.tasks.find((task) => task.id === created.task.id);
  assert.equal(listed?.status, 'in_progress');
  assert.equal(listed?.delegation_status, null);

  const kanban = await request<{
    task: { status: string; delegation_status: string | null };
    kanban: { status: string; latest_run_status: string | null; latest_run_profile: string | null };
  }>(`/api/tasks/${created.task.id}/kanban`);
  assert.equal(kanban.task.status, 'in_progress');
  assert.equal(kanban.task.delegation_status, null);
  assert.equal(kanban.kanban.status, 'running');
  assert.equal(kanban.kanban.latest_run_status, 'running');
  assert.equal(kanban.kanban.latest_run_profile, 'smoke-profile');

  const logs = await request<{
    task: { status: string; delegation_status: string | null };
    logs: Array<{ event_kind: string; payload: unknown }>;
    runs: Array<{ profile: string | null; status: string; summary: string | null }>;
    comments: Array<{ author: string | null; body: string }>;
  }>(`/api/tasks/${created.task.id}/kanban/logs?limit=10`);
  assert.equal(logs.task.status, 'in_progress');
  assert.equal(logs.task.delegation_status, null);
  assert.ok(logs.logs.some((entry) => entry.event_kind === 'worker_log'));
  assert.ok(logs.runs.some((run) => run.profile === 'smoke-profile' && run.status === 'running'));
  assert.ok(logs.comments.some((comment) => comment.body === 'real kanban comment'));

  console.log('kanban-status-sync smoke passed');
} finally {
  await stopServer(server);
  await rm(tmpHome, { recursive: true, force: true });
}
