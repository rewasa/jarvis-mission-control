import Database from 'better-sqlite3';
import { resolveHermesHome } from '../paths.js';
import { join } from 'node:path';
import {
  getTask,
  getTaskByKanbanId,
  insertTask,
  updateTask,
  getSubissues,
} from '../db/queries.js';
import { broadcast } from '../events.js';
import type { Task, TaskStatus, DelegationStatus } from '../../shared/types.js';

// ── Kanban DB connection ────────────────────────────────────────────────

function openKanbanDb(): Database.Database {
  const hermesHome = resolveHermesHome();
  const dbPath = join(hermesHome, 'kanban.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

// ── Types ───────────────────────────────────────────────────────────────

export interface KanbanTaskInfo {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: string;
  priority: number;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  current_run_id: number | null;
  skills: string | null;
  branch_name: string | null;
  session_id: string | null;
}

export interface KanbanRunInfo {
  id: number;
  profile: string | null;
  status: string;
  summary: string | null;
  metadata: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface KanbanEventInfo {
  id: number;
  kind: string;
  payload: string | null;
  run_id: number | null;
  created_at: number;
}

export interface KanbanCommentInfo {
  id: number;
  author: string;
  body: string;
  created_at: number;
}

export interface SyncResult {
  parent: Task;
  subtasks: Task[];
  imported: number;
  updated: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function getKanbanTaskInfo(kanbanTaskId: string): KanbanTaskInfo | null {
  const db = openKanbanDb();
  try {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(kanbanTaskId) as KanbanTaskInfo | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

export function getKanbanChildren(parentKanbanId: string): KanbanTaskInfo[] {
  const db = openKanbanDb();
  try {
    const rows = db.prepare(`
      SELECT t.* FROM tasks t
      INNER JOIN task_links l ON l.child_id = t.id
      WHERE l.parent_id = ?
      ORDER BY t.created_at ASC
    `).all(parentKanbanId) as KanbanTaskInfo[];
    return rows;
  } finally {
    db.close();
  }
}

export function getKanbanChildIds(parentKanbanId: string): string[] {
  const db = openKanbanDb();
  try {
    const rows = db.prepare('SELECT child_id FROM task_links WHERE parent_id = ?').all(parentKanbanId) as { child_id: string }[];
    return rows.map(r => r.child_id);
  } finally {
    db.close();
  }
}

/**
 * Find a Kanban task whose body or metadata references an AgentControl task id.
 * Scans task body for markers, then falls back to run summary/error/metadata.
 */
export function findKanbanTaskByAgentControlTaskId(acTaskId: string): KanbanTaskInfo | null {
  const db = openKanbanDb();
  try {
    // Try direct body markers first
    const bodyPattern = `%(${acTaskId})%`;
    const bodyMatch = db.prepare(
      `SELECT * FROM tasks WHERE body LIKE ? OR body LIKE ? ORDER BY created_at DESC LIMIT 1`
    ).get(bodyPattern, `%ac_parent: ${acTaskId}%`) as KanbanTaskInfo | undefined;
    if (bodyMatch) return bodyMatch;

    // Fallback: scan recent runs metadata for AgentControl task reference
    const runMatches = db.prepare(`
      SELECT t.* FROM tasks t
      INNER JOIN task_runs r ON r.task_id = t.id
      WHERE (r.metadata LIKE ? OR r.summary LIKE ?)
        AND (t.body IS NULL OR t.body NOT LIKE ?)
      ORDER BY r.started_at DESC LIMIT 1
    `).get(`%${acTaskId}%`, `%${acTaskId}%`, `%(${acTaskId.slice(0, 8)})%`) as KanbanTaskInfo | undefined;
    return runMatches ?? null;
  } finally {
    db.close();
  }
}

export function getKanbanTaskRuns(kanbanTaskId: string, limit = 20): KanbanRunInfo[] {
  const db = openKanbanDb();
  try {
    return db.prepare(`
      SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?
    `).all(kanbanTaskId, limit) as KanbanRunInfo[];
  } finally {
    db.close();
  }
}

export function getKanbanTaskEvents(kanbanTaskId: string, limit = 50): KanbanEventInfo[] {
  const db = openKanbanDb();
  try {
    return db.prepare(`
      SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(kanbanTaskId, limit) as KanbanEventInfo[];
  } finally {
    db.close();
  }
}

export function getKanbanTaskComments(kanbanTaskId: string, limit = 50): KanbanCommentInfo[] {
  const db = openKanbanDb();
  try {
    return db.prepare(`
      SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(kanbanTaskId, limit) as KanbanCommentInfo[];
  } finally {
    db.close();
  }
}

// ── Status Mapping ──────────────────────────────────────────────────────

interface MappedStatuses {
  status: TaskStatus;
  delegation_status: DelegationStatus | null;
}

function mapKanbanStatus(kanbanStatus: string): MappedStatuses {
  switch (kanbanStatus) {
    case 'todo':
    case 'ready':
    case 'running':
      return { status: 'in_progress', delegation_status: null };
    case 'blocked':
      return { status: 'in_progress', delegation_status: 'blocked' };
    case 'review':
      return { status: 'in_review', delegation_status: null };
    case 'done':
      return { status: 'in_review', delegation_status: 'review' };
    case 'archived':
      // Archived: don't close — keep last known state, set delegation done only if it had completed
      return { status: 'done', delegation_status: 'done' };
    default:
      return { status: 'in_progress', delegation_status: null };
  }
}

function extractAgentControlParentId(kanbanBody: string | null): string | null {
  if (!kanbanBody) return null;
  // Look for markers like "AgentControl parent task: <title> (<agentcontrol-parent-id>)"
  const match = kanbanBody.match(/AgentControl parent task:.*\(([a-f0-9-]{36})\)/i);
  if (match) return match[1];
  // Also accept bare "agentcontrol_id: <uuid>" or "ac_parent: <uuid>"
  const bareMatch = kanbanBody.match(/(?:agentcontrol_id|ac_parent):\s*([a-f0-9-]{36})\s*$/im);
  if (bareMatch) return bareMatch[1];
  return null;
}

function extractProfileFromKanban(kanbanTask: KanbanTaskInfo): string | null {
  // Profile can come from assignee or skills field
  if (kanbanTask.assignee) return kanbanTask.assignee;
  if (kanbanTask.skills) {
    try {
      const parsed = JSON.parse(kanbanTask.skills);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
    } catch { /* ignore */ }
  }
  return null;
}

// ── Main Sync ───────────────────────────────────────────────────────────

export function syncKanbanChildrenForTask(parentTask: Task): SyncResult {
  if (!parentTask.hermes_kanban_task_id) {
    throw new Error('Parent task has no hermes_kanban_task_id mapping');
  }

  const kanbanId = parentTask.hermes_kanban_task_id;
  const children = getKanbanChildren(kanbanId);
  let imported = 0;
  let updated = 0;

  for (const child of children) {
    // Check if this kanban task is already mapped to an AgentControl task
    const existing = getTaskByKanbanId(child.id);

    if (existing) {
      // Update status/profile from Kanban (don't overwrite user-edited title/description)
      const mapped = mapKanbanStatus(child.status);
      const profile = extractProfileFromKanban(child);
      const updates: Record<string, unknown> = {
        status: mapped.status,
        delegation_status: mapped.delegation_status,
        delegation_profile: profile,
      };
      // Only update title/description if they still match the original import value
      // (heuristic: if the description starts with the kanban body or vice versa)
      if (existing.description && child.body && existing.description.includes(child.body.substring(0, 50))) {
        // Still matches original — safe to update
        updates.title = child.title;
        updates.description = child.body ?? '';
      }
      const result = updateTask(existing.id, updates);
      if (result) {
        updated++;
        broadcast({ type: 'task_updated', task: result });
      }
    } else {
      // Import the kanban child as a new AgentControl subtask
      const mapped = mapKanbanStatus(child.status);
      const profile = extractProfileFromKanban(child);

      // Determine parent AC id: prefer explicit marker in body, else link to the calling parent
      const explicitParentId = extractAgentControlParentId(child.body);
      const acParentId = explicitParentId || parentTask.id;

      const created = insertTask({
        title: child.title,
        description: child.body ?? '',
        status: mapped.status,
        parent_task_id: acParentId,
        delegation_status: mapped.delegation_status,
        assignee: profile ?? undefined,
        priority: child.priority > 0 ? child.priority : undefined,
        hermes_kanban_task_id: child.id,
        delegation_profile: profile,
        external_source: 'hermes-kanban-sync',
      });
      broadcast({ type: 'task_created', task: created });
      imported++;
    }
  }

  const subtasks = getSubissues(parentTask.id);
  return { parent: parentTask, subtasks, imported, updated };
}
