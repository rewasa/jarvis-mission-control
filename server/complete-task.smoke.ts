import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const tmpHome = await mkdtemp(join(tmpdir(), 'agentcontrol-complete-smoke-'));
const baseUrl = 'http://127.0.0.1:47610';
let server: ChildProcess | null = null;
let ghCalls = 0;

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
    PORT: '47610',
    HOST: '127.0.0.1',
    AGENTCONTROL_HOME: tmpHome,
    DB_PATH: join(tmpHome, 'data', 'agentcontrol.db'),
  };

  const child = spawn(process.execPath, ['dist/server/server/index.js'], {
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

async function createTask(title: string, description: string) {
  return request<{ task: { id: string; status: string; github_pr_url: string | null } }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title, description, kanban: false }),
  });
}

async function completeTask(id: string) {
  return request<{
    task: { id: string; status: string; github_pr_state: string | null };
    githubMerge?: { status: string; merged: boolean; message: string } | null;
  }>(`/api/tasks/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ status: 'done' }),
  });
}

await execFileAsync('npm', ['run', 'build:server']);
await execFileAsync('npm', ['run', 'build:assets']);

try {
  server = startServer();
  await waitForServer();

  const noPr = await createTask('Smoke no PR', 'No pull request is linked here.');
  const noPrDone = await completeTask(noPr.task.id);
  assert.equal(noPrDone.task.status, 'done');
  assert.equal(noPrDone.githubMerge?.status, 'skipped_no_pr');

  const originalFetch = globalThis.fetch;
  const pr = await createTask('Smoke linked PR', 'PR: https://github.com/AgentSelly/agentcontrol-smoke/pull/123');
  const ghScript = join(tmpHome, 'gh');
  await import('node:fs/promises').then(({ writeFile, chmod }) => writeFile(
    ghScript,
    `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.GH_CALLS_FILE, args.join(' ') + '\\n');\nif (args[0] === 'pr' && args[1] === 'view') {\n  console.log(JSON.stringify({\n    url: 'https://github.com/AgentSelly/agentcontrol-smoke/pull/123',\n    number: 123,\n    state: 'MERGED',\n    baseRefName: 'main',\n    mergeable: 'MERGEABLE',\n    mergeStateStatus: 'CLEAN',\n    isDraft: false,\n    headRefName: 'smoke',\n    headRefOid: 'abc123',\n    statusCheckRollup: [],\n  }));\n  process.exit(0);\n}\nprocess.exit(1);\n`,
  ).then(() => chmod(ghScript, 0o755)));

  const callsFile = join(tmpHome, 'gh-calls.log');
  await stopServer(server);
  process.env.PATH = `${tmpHome}:${process.env.PATH}`;
  process.env.GH_CALLS_FILE = callsFile;
  server = startServer();
  await waitForServer();

  const prDone = await completeTask(pr.task.id);
  assert.equal(prDone.task.status, 'done');
  assert.equal(prDone.githubMerge?.status, 'merged');
  assert.equal(prDone.task.github_pr_state, 'MERGED');
  const calls = await import('node:fs/promises').then(({ readFile }) => readFile(callsFile, 'utf-8'));
  ghCalls = calls.split('\n').filter(Boolean).length;
  assert.ok(ghCalls >= 1, 'expected gh pr view to be called for linked PR completion');
  globalThis.fetch = originalFetch;

  console.log(`complete-task smoke tests passed (gh calls: ${ghCalls})`);
} finally {
  await stopServer(server);
  await rm(tmpHome, { recursive: true, force: true });
}
