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
  getTaskByKanbanId,
  getSubtasks,
  insertTask,
  updateTask,
} from '../db/queries.js';
import { broadcast } from '../events.js';
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

function openKanbanDb(): Database.Database | null {
  const dbPath = getKanbanDbPath();
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true, fileMustExist: true });
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

export function getKanbanTaskInfo(kanbanId: string | null): KanbanTaskInfo | null {
  if (!kanbanId) return null;

  const conn = openKanbanDb();
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

  const conn = openKanbanDb();
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

  const conn = openKanbanDb();
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

  const conn = openKanbanDb();
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
      return { status: 'in_progress', delegation_status: 'running' };
    case 'blocked':
      return { status: 'in_progress', delegation_status: 'blocked' };
    case 'review':
    case 'done':
      return { status: 'in_review', delegation_status: 'review' };
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
  const bareMatch = kanbanBody.match(/(?:agentcontrol_id|ac_parent):\s*([a-f0-9-]{36})\s*$/im);
  if (bareMatch) return bareMatch[1];
  return null;
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

export function syncKanbanChildrenForTask(parentTask: Task): SyncResult {
  if (!parentTask.hermes_kanban_task_id) {
    throw new Error('Parent task has no hermes_kanban_task_id mapping');
  }

  const children = getKanbanChildren(parentTask.hermes_kanban_task_id);
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
      const result = updateTask(existing.id, taskUpdates);
      if (result) {
        updated++;
        broadcast({ type: 'task_updated', task: result });
      }
      continue;
    }

    const explicitParentId = extractAgentControlParentId(child.body);
    const acParentId = explicitParentId || parentTask.id;
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
      external_source: 'hermes-kanban-sync',
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
  return { parent: parentTask, subtasks, imported, updated };
}
