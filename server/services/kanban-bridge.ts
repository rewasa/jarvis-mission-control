/**
 * Kanban Bridge — manages the Hermes Kanban ↔ AgentControl mapping.
 *
 * Writes go through the Hermes CLI so board-side invariants stay intact.
 * Read APIs use read-only SQLite queries against the Hermes Kanban DB, which
 * gives AgentControl real task status, event logs, comments, and run history
 * without parsing terminal output.
 */

import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolveHermesHome } from '../paths.js';
import {
  getAllTasks,
  getTask,
  getTaskByKanbanId,
  getSubtasks,
  insertTask,
  updateTask,
} from '../db/queries.js';
import { broadcast } from '../events.js';
import { refreshTaskGitHubStatus } from './github-status.js';
import type {
  DelegationStatus,
  KanbanCommentEntry,
  KanbanLogEntry,
  KanbanRunEntry,
  KanbanTaskInfo,
  Task,
  TaskStatus,
} from '../../shared/types.js';

export const KANBAN_BOARD = 'jarvis-mission-control';

type KanbanTaskRow = {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: string;
  priority: number | null;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  current_run_id: number | null;
  skills: string | null;
  branch_name: string | null;
  session_id: string | null;
};

function resolveKanbanRoot(): string {
  const override = process.env.HERMES_KANBAN_HOME?.trim();
  if (override) return override;

  const hermesHome = resolveHermesHome();

  // Hermes Kanban is intentionally shared across profiles. If AgentControl is
  // launched under HERMES_HOME=~/.hermes/profiles/<profile>, collapse it back
  // to ~/.hermes, matching hermes_cli/kanban_db.py::kanban_home().
  if (basename(dirname(hermesHome)) === 'profiles') {
    return dirname(dirname(hermesHome));
  }

  return hermesHome;
}

export function getKanbanDbPath(): string {
  const direct = process.env.HERMES_KANBAN_DB?.trim();
  if (direct) return direct;

  const root = resolveKanbanRoot();
  const board = KANBAN_BOARD as string;
  return board === 'default'
    ? join(root, 'kanban.db')
    : join(root, 'kanban', 'boards', board, 'kanban.db');
}

export function getKanbanDbPathForBoard(board: string): string {
  const root = resolveKanbanRoot();
  return board === 'default'
    ? join(root, 'kanban.db')
    : join(root, 'kanban', 'boards', board, 'kanban.db');
}

function openKanbanDbForBoard(board: string): Database.Database | null {
  const dbPath = getKanbanDbPathForBoard(board);
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function openWritableKanbanDbForBoard(board: string): Database.Database | null {
  const dbPath = getKanbanDbPathForBoard(board);
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { fileMustExist: true });
}

function openKanbanDb(): Database.Database | null {
  const dbPath = getKanbanDbPath();
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

const KANBAN_TASK_ID_RE = /\bt_[a-f0-9]{8}\b/gi;

export function extractKanbanTaskIdsFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  return Array.from(new Set(text.match(KANBAN_TASK_ID_RE) ?? []));
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { raw: value };
  }
}

function clampLimit(limit: number, fallback: number, max: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), max);
}

function mapTaskRow(row: KanbanTaskRow | undefined): KanbanTaskInfo | null {
  if (!row) return null;
  const metadata = row.current_run_id
    ? {}
    : {};
  return {
    kanban_id: row.id,
    title: row.title,
    status: row.status,
    assignee: row.assignee,
    body: row.body,
    outcome: null,
    summary: null,
    error: null,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    current_run_id: row.current_run_id,
    latest_run_id: null,
    latest_run_status: null,
    latest_run_profile: null,
    latest_run_metadata: metadata,
  };
}

function runKanbanCli(args: string[]): string {
  return execFileSync(
    'hermes',
    ['kanban', '--board', KANBAN_BOARD, ...args],
    {
      encoding: 'utf-8',
      timeout: 30_000,
      env: {
        ...process.env,
        HERMES_KANBAN_HOME: resolveKanbanRoot(),
      },
    },
  );
}

export function createKanbanTask(
  title: string,
  assigneeProfile: string,
  body: string,
  options?: {
    parentKanbanId?: string | null;
    workspace?: string | null;
    branch?: string | null;
    idempotencyKey?: string | null;
    initialStatus?: 'blocked' | 'running' | null;
  },
): string {
  const args = [
    'create',
    '--json',
    '--assignee',
    assigneeProfile,
    '--body',
    body,
  ];
  if (options?.parentKanbanId) args.push('--parent', options.parentKanbanId);
  if (options?.workspace) args.push('--workspace', options.workspace);
  if (options?.branch) args.push('--branch', options.branch);
  if (options?.idempotencyKey) args.push('--idempotency-key', options.idempotencyKey);
  if (options?.initialStatus) args.push('--initial-status', options.initialStatus);
  args.push(title);

  const stdout = runKanbanCli(args);

  const parsed = JSON.parse(stdout.trim()) as { id?: unknown };
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new Error('Hermes Kanban create did not return a task id');
  }
  return parsed.id;
}

export function ensureKanbanRootTaskForAgentControlTask(
  task: Task,
  options?: {
    defaultAssignee?: string | null;
    prUrl?: string | null;
    branch?: string | null;
    workspace?: string | null;
  },
): Task {
  if (task.hermes_kanban_task_id) return task;

  const assignee = options?.defaultAssignee?.trim() || task.delegation_profile || task.assignee || 'orchestrator';
  const body = [
    task.description ?? task.title,
    '',
    '---',
    `AgentControl task id: ${task.id}`,
    `AgentControl board: ${KANBAN_BOARD}`,
    options?.prUrl ? `GitHub PR: ${options.prUrl}` : null,
    options?.branch ? `Shared branch: ${options.branch}` : null,
    'All child Kanban tasks should work in the same PR/worktree context and commit their final changes there.',
  ].filter(Boolean).join('\n');

  const kanbanId = createKanbanTask(task.title, assignee, body, {
    workspace: options?.workspace || 'worktree',
    branch: options?.branch || undefined,
    idempotencyKey: `agentcontrol-root:${task.id}`,
  });

  const updated = updateTask(task.id, {
    hermes_kanban_task_id: kanbanId,
    delegation_profile: assignee,
    assignee,
    external_source: 'agentcontrol-kanban-root',
    ...(options?.prUrl ? { github_pr_url: options.prUrl } : {}),
  });
  if (!updated) throw new Error('Could not persist Kanban root mapping');
  broadcast({ type: 'task_updated', task: updated });
  return updated;
}

export function appendKanbanComment(
  kanbanId: string,
  body: string,
  author = 'agentcontrol',
): void {
  runKanbanCli([
    'comment',
    kanbanId,
    body,
    '--author',
    author,
  ]);
}

export function updateKanbanTaskStatusFromAgentControl(
  kanbanId: string | null,
  status: TaskStatus,
): void {
  if (!kanbanId) return;

  const board = findBoardForKanbanTask(kanbanId) ?? KANBAN_BOARD;
  switch (status) {
    case 'todo': {
      setKanbanTaskStatusDirect(
        board,
        kanbanId,
        'todo',
        'AgentControl moved task to todo',
      );
      return;
    }
    case 'in_progress': {
      const info = getKanbanTaskInfo(kanbanId);
      if (info?.status === 'running') return;
      setKanbanTaskStatusDirect(
        board,
        kanbanId,
        'running',
        'AgentControl moved task to in progress',
      );
      return;
    }
    case 'in_review': {
      setKanbanTaskStatusDirect(
        board,
        kanbanId,
        'review',
        'AgentControl moved task to review',
      );
      return;
    }
    case 'done': {
      const info = getKanbanTaskInfo(kanbanId);
      if (info?.status === 'ready' || info?.status === 'running' || info?.status === 'blocked') {
        runKanbanCli(['complete', kanbanId, '--result', 'Marked done from AgentControl']);
        return;
      }
      setKanbanTaskStatusDirect(
        board,
        kanbanId,
        'done',
        'AgentControl moved task to done',
      );
      return;
    }
  }
}

function setKanbanTaskStatusDirect(
  board: string,
  kanbanId: string,
  status: string,
  reason: string,
): void {
  const conn = openWritableKanbanDbForBoard(board);
  if (!conn) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const row = conn.prepare('SELECT status, current_run_id FROM tasks WHERE id = ?').get(kanbanId) as {
      status: string;
      current_run_id: number | null;
    } | undefined;
    if (!row || row.status === status) return;

    const tx = conn.transaction(() => {
      if (row.current_run_id !== null) {
        conn.prepare(`
          UPDATE task_runs
             SET status = 'reclaimed',
                 outcome = 'reclaimed',
                 summary = COALESCE(summary, ?),
                 ended_at = COALESCE(ended_at, ?),
                 claim_lock = NULL,
                 claim_expires = NULL,
                 worker_pid = NULL
           WHERE id = ? AND ended_at IS NULL
        `).run(reason, now, row.current_run_id);
      }

      conn.prepare(`
        UPDATE tasks
           SET status = ?,
               claim_lock = NULL,
               claim_expires = NULL,
               worker_pid = NULL,
               current_run_id = NULL
         WHERE id = ?
      `).run(status, kanbanId);

      conn.prepare(`
        INSERT INTO task_events (task_id, run_id, kind, payload, created_at)
        VALUES (?, ?, 'agentcontrol_status_changed', ?, ?)
      `).run(
        kanbanId,
        row.current_run_id,
        JSON.stringify({ from: row.status, to: status, reason }),
        now,
      );
    });
    tx();
  } finally {
    conn.close();
  }
}

const kanbanTaskBoardCache = new Map<string, string>();

function boardContainsKanbanTask(board: string, kanbanId: string): boolean {
  const conn = openKanbanDbForBoard(board);
  if (!conn) return false;
  try {
    const row = conn.prepare('SELECT 1 FROM tasks WHERE id = ?').get(kanbanId) as { 1: number } | undefined;
    return Boolean(row);
  } finally {
    conn.close();
  }
}

export function findBoardForKanbanTask(kanbanId: string | null): string | null {
  if (!kanbanId) return null;

  const cached = kanbanTaskBoardCache.get(kanbanId);
  if (cached && boardContainsKanbanTask(cached, kanbanId)) return cached;
  if (cached) kanbanTaskBoardCache.delete(kanbanId);

  if (boardContainsKanbanTask(KANBAN_BOARD, kanbanId)) {
    kanbanTaskBoardCache.set(kanbanId, KANBAN_BOARD);
    return KANBAN_BOARD;
  }

  const root = resolveKanbanRoot();
  const boardsDir = join(root, 'kanban', 'boards');
  if (existsSync(boardsDir)) {
    for (const entry of readdirSync(boardsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === KANBAN_BOARD) continue;
      if (boardContainsKanbanTask(entry.name, kanbanId)) {
        kanbanTaskBoardCache.set(kanbanId, entry.name);
        return entry.name;
      }
    }
  }

  if (boardContainsKanbanTask('default', kanbanId)) {
    kanbanTaskBoardCache.set(kanbanId, 'default');
    return 'default';
  }

  return null;
}

export function getKanbanTaskInfo(kanbanId: string | null): KanbanTaskInfo | null {
  if (!kanbanId) return null;

  const board = findBoardForKanbanTask(kanbanId) ?? KANBAN_BOARD;
  const conn = openKanbanDbForBoard(board);
  if (!conn) return null;

  try {
    const row = conn.prepare(`
      SELECT
        t.*,
        r.id AS latest_run_id,
        r.status AS latest_run_status,
        r.outcome,
        r.summary,
        r.error,
        r.profile AS latest_run_profile,
        r.metadata AS latest_run_metadata
      FROM tasks t
      LEFT JOIN task_runs r ON r.id = (
        SELECT id FROM task_runs
        WHERE task_id = t.id
        ORDER BY started_at DESC
        LIMIT 1
      )
      WHERE t.id = ?
    `).get(kanbanId) as (KanbanTaskRow & {
      latest_run_id: number | null;
      latest_run_status: string | null;
      outcome: string | null;
      summary: string | null;
      error: string | null;
      latest_run_profile: string | null;
      latest_run_metadata: string | null;
    }) | undefined;

    if (!row) return null;
    return {
      kanban_id: row.id,
      title: row.title,
      status: row.status,
      assignee: row.assignee,
      body: row.body,
      outcome: row.outcome,
      summary: row.summary,
      error: row.error,
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      current_run_id: row.current_run_id,
      latest_run_id: row.latest_run_id,
      latest_run_status: row.latest_run_status,
      latest_run_profile: row.latest_run_profile,
      latest_run_metadata: parseJsonRecord(row.latest_run_metadata),
    };
  } finally {
    conn.close();
  }
}

export function getKanbanChildren(parentKanbanId: string): KanbanTaskInfo[] {
  const conn = openKanbanDb();
  if (!conn) return [];

  try {
    const rows = conn.prepare(`
      SELECT t.*
      FROM tasks t
      INNER JOIN task_links l ON l.child_id = t.id
      WHERE l.parent_id = ?
      ORDER BY t.created_at ASC
    `).all(parentKanbanId) as KanbanTaskRow[];
    return rows.map(mapTaskRow).filter((task): task is KanbanTaskInfo => task !== null);
  } finally {
    conn.close();
  }
}

export function getKanbanChildIds(parentKanbanId: string): string[] {
  const conn = openKanbanDb();
  if (!conn) return [];

  try {
    const rows = conn.prepare('SELECT child_id FROM task_links WHERE parent_id = ?').all(parentKanbanId) as { child_id: string }[];
    return rows.map(row => row.child_id);
  } finally {
    conn.close();
  }
}

export function findKanbanTaskByAgentControlTaskId(acTaskId: string): KanbanTaskInfo | null {
  const conn = openKanbanDb();
  if (!conn) return null;

  try {
    const bodyMatch = conn.prepare(`
      SELECT * FROM tasks
      WHERE body LIKE ? OR body LIKE ? OR body LIKE ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(`%(${acTaskId})%`, `%ac_parent: ${acTaskId}%`, `%AgentControl subtask id: ${acTaskId}%`) as KanbanTaskRow | undefined;
    if (bodyMatch) return mapTaskRow(bodyMatch);

    const runMatch = conn.prepare(`
      SELECT t.*
      FROM tasks t
      INNER JOIN task_runs r ON r.task_id = t.id
      WHERE r.metadata LIKE ? OR r.summary LIKE ?
      ORDER BY r.started_at DESC
      LIMIT 1
    `).get(`%${acTaskId}%`, `%${acTaskId}%`) as KanbanTaskRow | undefined;
    return mapTaskRow(runMatch);
  } finally {
    conn.close();
  }
}

export function getKanbanLogs(kanbanId: string | null, limit = 50): KanbanLogEntry[] {
  if (!kanbanId) return [];

  const board = findBoardForKanbanTask(kanbanId) ?? KANBAN_BOARD;
  const conn = openKanbanDbForBoard(board);
  if (!conn) return [];

  try {
    const rows = conn.prepare(`
      SELECT
        id AS log_id,
        run_id,
        kind AS event_kind,
        payload,
        created_at
      FROM task_events
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(kanbanId, clampLimit(limit, 50, 200)) as Array<{
      log_id: number;
      run_id: number | null;
      event_kind: string;
      payload: string | null;
      created_at: number;
    }>;

    return rows.map(row => ({
      log_id: row.log_id,
      run_id: row.run_id,
      event_kind: row.event_kind,
      payload: parseJsonRecord(row.payload),
      created_at: row.created_at,
    }));
  } finally {
    conn.close();
  }
}

export function getKanbanRuns(kanbanId: string | null, limit = 20): KanbanRunEntry[] {
  if (!kanbanId) return [];

  const board = findBoardForKanbanTask(kanbanId) ?? KANBAN_BOARD;
  const conn = openKanbanDbForBoard(board);
  if (!conn) return [];

  try {
    const rows = conn.prepare(`
      SELECT
        id AS run_id,
        profile,
        status,
        outcome,
        started_at,
        ended_at,
        summary,
        metadata,
        error,
        worker_pid
      FROM task_runs
      WHERE task_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(kanbanId, clampLimit(limit, 20, 100)) as Array<{
      run_id: number;
      profile: string | null;
      status: string;
      outcome: string | null;
      started_at: number;
      ended_at: number | null;
      summary: string | null;
      metadata: string | null;
      error: string | null;
      worker_pid: number | null;
    }>;

    return rows.map(row => ({
      run_id: row.run_id,
      profile: row.profile,
      status: row.status,
      outcome: row.outcome,
      started_at: row.started_at,
      ended_at: row.ended_at,
      summary: row.summary,
      metadata: parseJsonRecord(row.metadata),
      error: row.error,
      worker_pid: row.worker_pid,
    }));
  } finally {
    conn.close();
  }
}

export function getKanbanComments(kanbanId: string | null, limit = 20): KanbanCommentEntry[] {
  if (!kanbanId) return [];

  const board = findBoardForKanbanTask(kanbanId) ?? KANBAN_BOARD;
  const conn = openKanbanDbForBoard(board);
  if (!conn) return [];

  try {
    const rows = conn.prepare(`
      SELECT
        id AS comment_id,
        author,
        body,
        created_at
      FROM task_comments
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(kanbanId, clampLimit(limit, 20, 100)) as KanbanCommentEntry[];

    return rows;
  } finally {
    conn.close();
  }
}

export const getKanbanTaskRuns = getKanbanRuns;
export const getKanbanTaskEvents = getKanbanLogs;
export const getKanbanTaskComments = getKanbanComments;

interface MappedStatuses {
  status: TaskStatus;
  delegation_status: DelegationStatus | null;
}

function mapKanbanStatus(kanbanStatus: string): MappedStatuses {
  switch (kanbanStatus) {
    case 'todo':
    case 'ready':
      return { status: 'todo', delegation_status: null };
    case 'running':
      // AgentControl's column state is the canonical user-facing progress
      // signal. A Hermes Kanban card can remain `running` after the worker
      // process/session has already stopped (stale claim, crash, interrupted
      // API call, or dispatcher lag). Showing that as a delegation badge keeps
      // stale smoke cards visually stuck in "running" even though the correct
      // AgentControl state is simply active work in progress.
      return { status: 'in_progress', delegation_status: null };
    case 'blocked':
      return { status: 'in_progress', delegation_status: 'blocked' };
    case 'review':
      return { status: 'in_review', delegation_status: 'review' };
    case 'done':
    case 'archived':
      return { status: 'done', delegation_status: 'done' };
    default:
      return { status: 'todo', delegation_status: null };
  }
}

export function syncTaskStatusFromKanban(task: Task): { task: Task; changed: boolean } {
  if (!task.hermes_kanban_task_id) return { task, changed: false };

  const info = getKanbanTaskInfo(task.hermes_kanban_task_id);
  if (!info) return { task, changed: false };

  const mapped = mapKanbanStatus(info.status);
  const profile = task.delegation_profile ?? extractProfileFromKanban(info);
  const updates: Partial<Pick<Task, 'status' | 'delegation_status' | 'delegation_profile' | 'assignee'>> = {};

  if (task.status !== mapped.status) updates.status = mapped.status;
  if (task.delegation_status !== mapped.delegation_status) updates.delegation_status = mapped.delegation_status;
  if (!task.delegation_profile && profile) updates.delegation_profile = profile;
  if (!task.assignee && profile) updates.assignee = profile;

  if (Object.keys(updates).length === 0) return { task, changed: false };

  const updated = updateTask(task.id, updates);
  if (!updated) return { task, changed: false };

  broadcast({ type: 'task_updated', task: updated });
  return { task: updated, changed: true };
}

function extractAgentControlParentId(kanbanBody: string | null): string | null {
  if (!kanbanBody) return null;
  const match = kanbanBody.match(/AgentControl parent task:.*\(([a-f0-9-]{36})\)/i);
  if (match) return match[1];
  const labelMatch = kanbanBody.match(/AgentControl parent(?: task)?:\s*([a-f0-9-]{36})/i);
  if (labelMatch) return labelMatch[1];
  const bareMatch = kanbanBody.match(/(?:agentcontrol_id|ac_parent):\s*([a-f0-9-]{36})\s*$/im);
  if (bareMatch) return bareMatch[1];
  return null;
}

function resolveExistingAgentControlParentId(
  explicitParentId: string | null,
  fallbackParentId: string,
): string {
  if (!explicitParentId) return fallbackParentId;
  return getTask(explicitParentId) ? explicitParentId : fallbackParentId;
}

function extractProfileFromKanban(kanbanTask: KanbanTaskInfo): string | null {
  if (kanbanTask.assignee) return kanbanTask.assignee;
  return kanbanTask.latest_run_profile;
}

export interface SyncResult {
  parent: Task;
  subtasks: Task[];
  imported: number;
  updated: number;
}

function broadcastSubtasksSynced(result: SyncResult): void {
  broadcast({
    type: 'subtasks_synced',
    parentTaskId: result.parent.id,
    subtasks: result.subtasks,
    imported: result.imported,
    updated: result.updated,
  });
}

export async function syncKanbanChildrenForTask(
  parentTask: Task,
  options?: { extraChildIds?: string[]; refreshGitHub?: boolean },
): Promise<SyncResult> {
  if (!parentTask.hermes_kanban_task_id) {
    throw new Error('Parent task has no hermes_kanban_task_id mapping');
  }

  const shouldRefreshGitHub = options?.refreshGitHub ?? true;
  if (shouldRefreshGitHub) {
    const refreshedParent = await refreshTaskGitHubStatus(parentTask);
    if (refreshedParent) parentTask = refreshedParent;
  }
  const parentKanbanId = parentTask.hermes_kanban_task_id;
  if (!parentKanbanId) {
    throw new Error('Parent task lost hermes_kanban_task_id mapping during refresh');
  }

  const linkedChildren = getKanbanChildren(parentKanbanId);
  const linkedIds = new Set(linkedChildren.map((child) => child.kanban_id));
  const childrenById = new Map(linkedChildren.map((child) => [child.kanban_id, child]));
  for (const childId of options?.extraChildIds ?? []) {
    if (childId === parentKanbanId || childrenById.has(childId)) continue;
    const child = getKanbanTaskInfo(childId);
    if (!child) continue;
    childrenById.set(child.kanban_id, child);
  }
  const children = Array.from(childrenById.values());
  let imported = 0;
  let updated = 0;

  for (const child of children) {
    const existing = getTaskByKanbanId(child.kanban_id);
    const mapped = mapKanbanStatus(child.status);
    const profile = extractProfileFromKanban(child);

    const taskUpdates: Partial<Pick<Task,
      | 'status'
      | 'delegation_status'
      | 'delegation_profile'
      | 'assignee'
      | 'github_pr_url'
      | 'github_pr_number'
      | 'github_pr_state'
      | 'github_pr_head_ref'
      | 'github_pr_head_sha'
      | 'github_checks_status'
      | 'github_checks_summary'
      | 'github_checks_updated_at'
    >> = {
      status: mapped.status,
      delegation_status: mapped.delegation_status,
      delegation_profile: profile,
      assignee: profile,
    };
    if (parentTask.github_pr_url) {
      taskUpdates.github_pr_url = parentTask.github_pr_url;
      taskUpdates.github_pr_number = parentTask.github_pr_number;
      taskUpdates.github_pr_state = parentTask.github_pr_state;
      taskUpdates.github_pr_head_ref = parentTask.github_pr_head_ref;
      taskUpdates.github_pr_head_sha = parentTask.github_pr_head_sha;
      taskUpdates.github_checks_status = parentTask.github_checks_status;
      taskUpdates.github_checks_summary = parentTask.github_checks_summary;
      taskUpdates.github_checks_updated_at = parentTask.github_checks_updated_at;
    }

    if (existing) {
      const refreshedExisting = shouldRefreshGitHub
        ? await refreshTaskGitHubStatus(existing)
        : null;
      const existingWithPr = refreshedExisting ?? existing;
      const desiredUpdates = {
        ...taskUpdates,
        github_pr_url: existingWithPr.github_pr_url ?? taskUpdates.github_pr_url,
        github_pr_number: existingWithPr.github_pr_number ?? taskUpdates.github_pr_number,
        github_pr_state: existingWithPr.github_pr_state ?? taskUpdates.github_pr_state,
        github_pr_head_ref: existingWithPr.github_pr_head_ref ?? taskUpdates.github_pr_head_ref,
        github_pr_head_sha: existingWithPr.github_pr_head_sha ?? taskUpdates.github_pr_head_sha,
        github_checks_status: existingWithPr.github_checks_status ?? taskUpdates.github_checks_status,
        github_checks_summary: existingWithPr.github_checks_summary ?? taskUpdates.github_checks_summary,
        github_checks_updated_at: existingWithPr.github_checks_updated_at ?? taskUpdates.github_checks_updated_at,
      };
      const changedUpdates: typeof taskUpdates = {};
      const updateKeys = Object.keys(desiredUpdates) as (keyof typeof taskUpdates)[];
      for (const key of updateKeys) {
        const value = desiredUpdates[key];
        if (existingWithPr[key] !== value) {
          Object.assign(changedUpdates, { [key]: value });
        }
      }

      if (Object.keys(changedUpdates).length > 0) {
        const result = updateTask(existing.id, changedUpdates);
        if (result) {
          updated++;
          broadcast({ type: 'task_updated', task: result });
        }
      }
      continue;
    }

    const explicitParentId = extractAgentControlParentId(child.body);
    const acParentId = resolveExistingAgentControlParentId(explicitParentId, parentTask.id);
    const created = insertTask({
      title: child.title,
      description: child.body ?? '',
      status: mapped.status,
      parent_task_id: acParentId,
      delegation_status: mapped.delegation_status,
      assignee: profile ?? undefined,
      priority: null,
      hermes_kanban_task_id: child.kanban_id,
      delegation_profile: profile,
      external_source: linkedIds.has(child.kanban_id) ? 'hermes-kanban-sync' : 'hermes-kanban-chat-reference',
      github_pr_url: taskUpdates.github_pr_url,
      github_pr_number: taskUpdates.github_pr_number,
      github_pr_state: taskUpdates.github_pr_state,
      github_pr_head_ref: taskUpdates.github_pr_head_ref,
      github_pr_head_sha: taskUpdates.github_pr_head_sha,
      github_checks_status: taskUpdates.github_checks_status,
      github_checks_summary: taskUpdates.github_checks_summary,
      github_checks_updated_at: taskUpdates.github_checks_updated_at,
    });
    broadcast({ type: 'task_created', task: created });
    imported++;
  }

  const subtasks = getSubtasks(parentTask.id);
  const result = { parent: parentTask, subtasks, imported, updated };
  if (imported > 0 || updated > 0) broadcastSubtasksSynced(result);
  return result;
}

let kanbanLiveSyncTimer: ReturnType<typeof setInterval> | null = null;
let kanbanLiveSyncRunning = false;

async function syncAllMappedKanbanParents(): Promise<void> {
  if (kanbanLiveSyncRunning) return;
  kanbanLiveSyncRunning = true;
  try {
    const parents = getAllTasks()
      .filter((task) => task.hermes_kanban_task_id && !task.parent_task_id);

    for (const parent of parents) {
      try {
        await syncKanbanChildrenForTask(parent, { refreshGitHub: false });
      } catch (error) {
        console.warn(
          `[kanban-bridge] Live child sync skipped for ${parent.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  } finally {
    kanbanLiveSyncRunning = false;
  }
}

export function startKanbanLiveSync(intervalMs = 2_000): () => void {
  if (kanbanLiveSyncTimer) return stopKanbanLiveSync;
  void syncAllMappedKanbanParents();
  kanbanLiveSyncTimer = setInterval(() => void syncAllMappedKanbanParents(), intervalMs);
  kanbanLiveSyncTimer.unref?.();
  return stopKanbanLiveSync;
}

export function stopKanbanLiveSync(): void {
  if (!kanbanLiveSyncTimer) return;
  clearInterval(kanbanLiveSyncTimer);
  kanbanLiveSyncTimer = null;
}

// ── Multi-Board support ────────────────────────────────────────────────

import { readdirSync } from 'node:fs';

export interface BoardSummary {
  name: string;
  dbPath: string;
  taskCount: number;
  activeTaskCount: number;
  doneTaskCount: number;
}

export function listKanbanBoards(): BoardSummary[] {
  const root = resolveKanbanRoot();
  const boardsDir = join(root, 'kanban', 'boards');
  const boards: BoardSummary[] = [];

  // Default board
  const defaultPath = join(root, 'kanban.db');
  if (existsSync(defaultPath)) {
    const conn = new Database(defaultPath, { readonly: true, fileMustExist: true });
    try {
      const counts = conn.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN status IN ('done','archived') THEN 1 ELSE 0 END) as done
        FROM tasks
      `).get() as { total: number; active: number; done: number };
      boards.push({ name: 'default', dbPath: defaultPath, taskCount: counts.total, activeTaskCount: counts.active, doneTaskCount: counts.done });
    } finally { conn.close(); }
  }

  // Named boards
  if (existsSync(boardsDir)) {
    for (const entry of readdirSync(boardsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dbPath = join(boardsDir, entry.name, 'kanban.db');
      if (!existsSync(dbPath)) continue;

      const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const counts = conn.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN status IN ('done','archived') THEN 1 ELSE 0 END) as done
          FROM tasks
        `).get() as { total: number; active: number; done: number };
        boards.push({ name: entry.name, dbPath, taskCount: counts.total, activeTaskCount: counts.active, doneTaskCount: counts.done });
      } finally { conn.close(); }
    }
  }

  return boards;
}

export function getBoardTasks(board: string): KanbanTaskInfo[] {
  const conn = openKanbanDbForBoard(board);
  if (!conn) return [];

  try {
    const rows = conn.prepare(`
      SELECT t.*,
        r.id AS latest_run_id, r.status AS latest_run_status,
        r.outcome, r.summary, r.error, r.profile AS latest_run_profile, r.metadata AS latest_run_metadata
      FROM tasks t
      LEFT JOIN task_runs r ON r.id = (
        SELECT id FROM task_runs WHERE task_id = t.id ORDER BY started_at DESC LIMIT 1
      )
      ORDER BY t.created_at DESC
    `).all() as Array<KanbanTaskRow & {
      latest_run_id: number | null; latest_run_status: string | null;
      outcome: string | null; summary: string | null; error: string | null;
      latest_run_profile: string | null; latest_run_metadata: string | null;
    }>;

    return rows.map(row => ({
      kanban_id: row.id,
      title: row.title,
      status: row.status,
      assignee: row.assignee,
      body: row.body,
      outcome: row.outcome,
      summary: row.summary,
      error: row.error,
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      current_run_id: row.current_run_id,
      latest_run_id: row.latest_run_id,
      latest_run_status: row.latest_run_status,
      latest_run_profile: row.latest_run_profile,
      latest_run_metadata: parseJsonRecord(row.latest_run_metadata),
    }));
  } finally { conn.close(); }
}

export function getBoardTaskInfo(board: string, kanbanId: string): KanbanTaskInfo | null {
  const conn = openKanbanDbForBoard(board);
  if (!conn) return null;

  try {
    const row = conn.prepare(`
      SELECT t.*,
        r.id AS latest_run_id, r.status AS latest_run_status,
        r.outcome, r.summary, r.error, r.profile AS latest_run_profile, r.metadata AS latest_run_metadata
      FROM tasks t
      LEFT JOIN task_runs r ON r.id = (
        SELECT id FROM task_runs WHERE task_id = t.id ORDER BY started_at DESC LIMIT 1
      )
      WHERE t.id = ?
    `).get(kanbanId) as (KanbanTaskRow & {
      latest_run_id: number | null; latest_run_status: string | null;
      outcome: string | null; summary: string | null; error: string | null;
      latest_run_profile: string | null; latest_run_metadata: string | null;
    }) | undefined;

    if (!row) return null;
    return {
      kanban_id: row.id,
      title: row.title,
      status: row.status,
      assignee: row.assignee,
      body: row.body,
      outcome: row.outcome,
      summary: row.summary,
      error: row.error,
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      current_run_id: row.current_run_id,
      latest_run_id: row.latest_run_id,
      latest_run_status: row.latest_run_status,
      latest_run_profile: row.latest_run_profile,
      latest_run_metadata: parseJsonRecord(row.latest_run_metadata),
    };
  } finally { conn.close(); }
}

export function getBoardKanbanLogs(board: string, kanbanId: string, limit = 50): KanbanLogEntry[] {
  const conn = openKanbanDbForBoard(board);
  if (!conn) return [];

  try {
    const rows = conn.prepare(`
      SELECT id AS log_id, run_id, kind AS event_kind, payload, created_at
      FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(kanbanId, clampLimit(limit, 50, 200)) as Array<{
      log_id: number; run_id: number | null; event_kind: string; payload: string | null; created_at: number;
    }>;

    return rows.map(row => ({
      log_id: row.log_id,
      run_id: row.run_id,
      event_kind: row.event_kind,
      payload: parseJsonRecord(row.payload),
      created_at: row.created_at,
    }));
  } finally { conn.close(); }
}

export function getBoardKanbanRuns(board: string, kanbanId: string, limit = 20): KanbanRunEntry[] {
  const conn = openKanbanDbForBoard(board);
  if (!conn) return [];

  try {
    const rows = conn.prepare(`
      SELECT id AS run_id, profile, status, outcome, started_at, ended_at, summary, metadata, error, worker_pid
      FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?
    `).all(kanbanId, clampLimit(limit, 20, 100)) as Array<{
      run_id: number; profile: string | null; status: string; outcome: string | null;
      started_at: number; ended_at: number | null; summary: string | null;
      metadata: string | null; error: string | null; worker_pid: number | null;
    }>;

    return rows.map(row => ({
      run_id: row.run_id,
      profile: row.profile,
      status: row.status,
      outcome: row.outcome,
      started_at: row.started_at,
      ended_at: row.ended_at,
      summary: row.summary,
      metadata: parseJsonRecord(row.metadata),
      error: row.error,
      worker_pid: row.worker_pid,
    }));
  } finally { conn.close(); }
}

export function getBoardKanbanComments(board: string, kanbanId: string, limit = 20): KanbanCommentEntry[] {
  const conn = openKanbanDbForBoard(board);
  if (!conn) return [];

  try {
    return conn.prepare(`
      SELECT id AS comment_id, author, body, created_at
      FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(kanbanId, clampLimit(limit, 20, 100)) as KanbanCommentEntry[];
  } finally { conn.close(); }
}

export function getBoardKanbanChildren(board: string, parentKanbanId: string): KanbanTaskInfo[] {
  const conn = openKanbanDbForBoard(board);
  if (!conn) return [];

  try {
    const rows = conn.prepare(`
      SELECT t.* FROM tasks t
      INNER JOIN task_links l ON l.child_id = t.id
      WHERE l.parent_id = ? ORDER BY t.created_at ASC
    `).all(parentKanbanId) as KanbanTaskRow[];
    return rows.map(mapTaskRow).filter((task): task is KanbanTaskInfo => task !== null);
  } finally { conn.close(); }
}

export function getBoardTaskTranscriptPath(board: string, taskId: string): string | null {
  const root = resolveKanbanRoot();
  const logDir = board === 'default'
    ? join(root, 'kanban', 'logs')
    : join(root, 'kanban', 'boards', board, 'logs');
  const logFile = join(logDir, `${taskId}.log`);
  return existsSync(logFile) ? logFile : null;
}

// ── Blockers ────────────────────────────────────────────────────────────

export interface BlockerInfo {
  kanban_id: string;
  title: string;
  status: string;
}

/** Return the tasks that this task is waiting on (direct parents in task_links that are not done/archived). */
export function getBoardTaskBlockers(board: string, kanbanId: string): BlockerInfo[] {
  const conn = openKanbanDbForBoard(board);
  if (!conn) return [];

  try {
    const rows = conn.prepare(`
      SELECT t.id AS kanban_id, t.title, t.status
      FROM tasks t
      INNER JOIN task_links l ON l.parent_id = t.id
      WHERE l.child_id = ?
        AND t.status NOT IN ('done', 'archived')
    `).all(kanbanId) as BlockerInfo[];
    return rows;
  } finally { conn.close(); }
}
