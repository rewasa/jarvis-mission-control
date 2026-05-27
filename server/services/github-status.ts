/**
 * GitHub PR + Actions/check status enrichment service.
 *
 * Extracts GitHub PR URLs from task content, fetches PR state and
 * status check rollup via `gh` CLI, normalizes to a simple status,
 * and persists the results on the AgentControl task.
 */

import { execSync } from 'node:child_process';
import { getTask, updateTask } from '../db/queries.js';
import { broadcast } from '../events.js';
import { getKanbanTaskInfo, getKanbanTaskRuns, getKanbanTaskComments } from './kanban-bridge.js';
import type { Task } from '../../shared/types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface GitHubPrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface GitHubPrStatus {
  url: string;
  number: number;
  state: string;
  headRefName: string;
  headRefOid: string;
  checksStatus: CheckRollupStatus;
  checksSummary: string;
  mergeStateStatus: string | null;
}

export type CheckRollupStatus = 'success' | 'failure' | 'pending' | 'unknown';

// ── PR URL Extraction ────────────────────────────────────────────────────

const PR_URL_RE = /https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pull\/(\d+)/g;

/**
 * Extract GitHub PR references from a block of text.
 * Matches URLs like https://github.com/owner/repo/pull/123.
 */
export function extractGitHubPrRefs(text: string): GitHubPrRef[] {
  const refs: GitHubPrRef[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = PR_URL_RE.exec(text)) !== null) {
    const url = match[0].replace(/\/+$/, '');
    const key = `${match[1]}/${match[2]}#${match[3]}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({
        owner: match[1],
        repo: match[2],
        number: parseInt(match[3], 10),
        url,
      });
    }
  }
  return refs;
}

// ── gh CLI Integration ──────────────────────────────────────────────────

interface GhPrViewJson {
  url: string;
  number: number;
  state: string;
  headRefName: string;
  headRefOid: string;
  statusCheckRollup: Array<{
    state: string;
    status: string;
    conclusion: string | null;
    name?: string;
  }> | null;
  mergeStateStatus: string | null;
}

/**
 * Normalize a single check's conclusion to success/failure/pending.
 */
function normalizeCheckState(check: {
  state: string;
  status: string;
  conclusion: string | null;
}): 'success' | 'failure' | 'pending' | 'unknown' {
  const { status, conclusion } = check;
  if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
    return 'success';
  }
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled' || conclusion === 'action_required') {
    return 'failure';
  }
  if (status === 'completed' && conclusion === null) {
    return 'unknown';
  }
  // queued, in_progress, waiting, pending
  return 'pending';
}

/**
 * Aggregate the status check rollup into a single status.
 * - Any failure → failure
 * - Any pending and no failure → pending
 * - All success/neutral/skipped → success
 * - No checks or unknown → unknown
 */
function aggregateCheckRollup(
  rollup: Array<{ state: string; status: string; conclusion: string | null; name?: string }> | null,
): { status: CheckRollupStatus; summary: string } {
  if (!rollup || rollup.length === 0) {
    return { status: 'unknown', summary: 'No checks found' };
  }

  let hasFailure = false;
  let hasPending = false;
  let successCount = 0;
  let failureCount = 0;
  const details: string[] = [];

  for (const check of rollup) {
    const st = normalizeCheckState(check);
    if (st === 'failure') {
      hasFailure = true;
      failureCount++;
    } else if (st === 'pending') {
      hasPending = true;
    } else {
      successCount++;
    }
    const name = check.name || `check #${details.length + 1}`;
    details.push(`${name}: ${st}`);
  }

  let status: CheckRollupStatus;
  if (hasFailure) {
    status = 'failure';
  } else if (hasPending) {
    status = 'pending';
  } else if (successCount > 0) {
    status = 'success';
  } else {
    status = 'unknown';
  }

  // Build a concise summary (keep it under 500 chars)
  const summary = `${successCount} passed, ${failureCount} failed${hasPending ? ', some pending' : ''}`;

  return { status, summary };
}

let _ghAuthWarningIssued = false;

/**
 * Fetch PR status via `gh pr view`.
 * Returns null if gh is not available or auth is missing.
 */
export async function fetchPrStatus(
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubPrStatus | null> {
  try {
    const json = execSync(
      `gh pr view --repo "${owner}/${repo}" ${number} --json url,number,state,headRefName,headRefOid,statusCheckRollup,mergeStateStatus`,
      {
        encoding: 'utf-8',
        timeout: 15_000,
        maxBuffer: 1024 * 512,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const data: GhPrViewJson = JSON.parse(json);

    const { status: checksStatus, summary: checksSummary } = aggregateCheckRollup(data.statusCheckRollup);

    return {
      url: data.url,
      number: data.number,
      state: data.state,
      headRefName: data.headRefName,
      headRefOid: data.headRefOid,
      checksStatus,
      checksSummary,
      mergeStateStatus: data.mergeStateStatus,
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('not authenticated')) {
      if (!_ghAuthWarningIssued) {
        console.warn('[github-status] gh CLI not authenticated — GitHub status enrichment degraded');
        _ghAuthWarningIssued = true;
      }
      return null;
    }
    // Could also be "pull request not found" or network error — log and return null
    console.warn(`[github-status] Failed to fetch PR ${owner}/${repo}#${number}:`, (err as Error)?.message ?? err);
    return null;
  }
}

// ── Task Content Scanning ────────────────────────────────────────────────

/**
 * Gather all text sources from a task for PR URL extraction.
 * Sources in order: task description, kanban task body, comments, runs.
 */
function gatherTaskTexts(task: Task): string[] {
  const texts: string[] = [];

  if (task.description) texts.push(task.description);
  if (task.title) texts.push(task.title);

  // Kanban task content
  if (task.hermes_kanban_task_id) {
    try {
      const kanbanTask = getKanbanTaskInfo(task.hermes_kanban_task_id);
      if (kanbanTask?.body) texts.push(kanbanTask.body);
      if (kanbanTask?.branch_name) texts.push(kanbanTask.branch_name);

      // Kanban comments
      const comments = getKanbanTaskComments(task.hermes_kanban_task_id, 20);
      for (const c of comments) {
        if (c.body) texts.push(c.body);
      }

      // Kanban run summaries
      const runs = getKanbanTaskRuns(task.hermes_kanban_task_id, 5);
      for (const r of runs) {
        if (r.summary) texts.push(r.summary);
        if (r.error) texts.push(r.error);
        if (r.metadata) texts.push(r.metadata);
      }
    } catch {
      // Kanban bridge may not work if there's no kanban.db — degrade gracefully
    }
  }

  return texts;
}

// ── Main Service ─────────────────────────────────────────────────────────

/**
 * Refresh GitHub PR status for a task.
 * Scans task description, title, linked kanban content for PR URLs,
 * fetches status via gh CLI, persists to DB, and broadcasts update.
 *
 * Returns the updated task, or null if no PR URL found or fetch failed.
 */
export async function refreshTaskGitHubStatus(task: Task): Promise<Task | null> {
  const texts = gatherTaskTexts(task);
  const prRefs = texts.flatMap((t) => extractGitHubPrRefs(t ?? ''));

  // Deduplicate by URL
  const seen = new Set<string>();
  const uniqueRefs: GitHubPrRef[] = [];
  for (const ref of prRefs) {
    if (!seen.has(ref.url)) {
      seen.add(ref.url);
      uniqueRefs.push(ref);
    }
  }

  if (uniqueRefs.length === 0) {
    // No PR URLs found — clear stale data
    const cleared = updateTask(task.id, {
      github_pr_url: null,
      github_pr_number: null,
      github_pr_state: null,
      github_pr_head_ref: null,
      github_pr_head_sha: null,
      github_checks_status: 'unknown',
      github_checks_summary: 'No PR URL found',
      github_checks_updated_at: Date.now(),
    });
    if (cleared) broadcast({ type: 'task_updated', task: cleared });
    return cleared ?? null;
  }

  // Process the first PR reference
  const ref = uniqueRefs[0];
  const prStatus = await fetchPrStatus(ref.owner, ref.repo, ref.number);

  if (!prStatus) {
    console.warn(`[github-status] Could not fetch status for ${ref.url}`);
    return null;
  }

  const updated = updateTask(task.id, {
    github_pr_url: prStatus.url,
    github_pr_number: prStatus.number,
    github_pr_state: prStatus.state,
    github_pr_head_ref: prStatus.headRefName,
    github_pr_head_sha: prStatus.headRefOid,
    github_checks_status: prStatus.checksStatus,
    github_checks_summary: prStatus.checksSummary,
    github_checks_updated_at: Date.now(),
  });

  if (updated) {
    broadcast({ type: 'task_updated', task: updated });
  }

  return updated ?? null;
}
