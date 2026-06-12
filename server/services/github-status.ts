/**
 * GitHub PR + Actions/check status enrichment service.
 *
 * Detection strategy per task/subtask, most precise signal first:
 *
 *  1. Branch → PR lookup: the task's own git branch (Hermes Kanban
 *     `branch_name`, run metadata) is resolved to its PR via
 *     `gh pr list --head <branch>`. An OPEN PR on the task's own branch
 *     always wins — it is the task's PR by construction.
 *  2. PR URLs mentioned in task/Kanban content (newest evidence first).
 *  3. A merged/closed PR found via the branch lookup.
 *
 * If a branch is known but has no PR yet, the branch is still persisted on
 * the task (`github_pr_head_ref`) so GitHub webhooks can match pushes by
 * branch and the UI can show the branch before the PR exists.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { getAllTasks, updateTask } from '../db/queries.js';
import { broadcast } from '../events.js';
import { getKanbanTaskInfo, getKanbanRuns, getKanbanComments } from './kanban-bridge.js';
import type { KanbanTaskInfo, Task } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────

export interface GitHubPrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface GitHubRepoRef {
  owner: string;
  repo: string;
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

// ── Repo Candidate Resolution ────────────────────────────────────────────

const REPO_URL_RE = /https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/g;

/** First path segments on github.com that are never repo owners. */
const NON_REPO_OWNERS = new Set([
  'orgs', 'features', 'topics', 'marketplace', 'settings', 'search',
  'sponsors', 'notifications', 'about', 'pricing', 'apps', 'login',
  'enterprise', 'collections', 'issues', 'pulls', 'codespaces',
]);

function extractGitHubRepoRefs(texts: string[]): GitHubRepoRef[] {
  const refs: GitHubRepoRef[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    const re = new RegExp(REPO_URL_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const owner = match[1];
      const repo = match[2].replace(/\.git$/, '');
      if (NON_REPO_OWNERS.has(owner.toLowerCase())) continue;
      const key = `${owner}/${repo}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ owner, repo });
      }
    }
  }
  return refs;
}

let _originRepoRef: GitHubRepoRef | null | undefined;

/**
 * GitHub repo of this server's working directory (cached). Acts as the
 * default repo for branch → PR lookups when task content names no repo.
 */
function getOriginRepoRef(): GitHubRepoRef | null {
  if (_originRepoRef !== undefined) return _originRepoRef;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = url.match(/github\.com[/:]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
    _originRepoRef = match ? { owner: match[1], repo: match[2] } : null;
  } catch {
    _originRepoRef = null;
  }
  return _originRepoRef;
}

/** Comma-separated `owner/repo` list, e.g. AGENTCONTROL_GITHUB_REPOS=acme/app,acme/infra */
function getEnvRepoRefs(): GitHubRepoRef[] {
  const raw = process.env.AGENTCONTROL_GITHUB_REPOS ?? process.env.AGENTCONTROL_GITHUB_REPO ?? '';
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): GitHubRepoRef | null => {
      const [owner, repo] = entry.split('/');
      return owner && repo ? { owner, repo } : null;
    })
    .filter((ref): ref is GitHubRepoRef => ref !== null);
}

const MAX_REPO_CANDIDATES = 3;

/**
 * Repos to try for branch → PR lookups, in priority order:
 * repos named in task/Kanban content → env override → this server's origin.
 */
export function resolveRepoCandidates(texts: string[]): GitHubRepoRef[] {
  const all = [...extractGitHubRepoRefs(texts), ...getEnvRepoRefs()];
  const origin = getOriginRepoRef();
  if (origin) all.push(origin);

  const seen = new Set<string>();
  const unique: GitHubRepoRef[] = [];
  for (const ref of all) {
    const key = `${ref.owner}/${ref.repo}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(ref);
    }
    if (unique.length >= MAX_REPO_CANDIDATES) break;
  }
  return unique;
}

// ── Branch Candidate Resolution ──────────────────────────────────────────

const BRANCH_DENYLIST = new Set(['main', 'master', 'head', 'develop']);

function isPlausibleBranchName(value: string): boolean {
  if (!value || value.length > 200) return false;
  if (/\s/.test(value)) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (value.startsWith('-') || value.endsWith('/') || value.includes('..')) return false;
  if (BRANCH_DENYLIST.has(value.toLowerCase())) return false;
  return true;
}

/**
 * Branch candidates for a task, most specific first: the Kanban task's own
 * assigned branch, then branches from run metadata, then the stored head ref.
 */
export function findTaskBranchCandidates(task: Task, kanban?: KanbanTaskInfo | null): string[] {
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed && isPlausibleBranchName(trimmed) && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  if (kanban) {
    push(kanban.branch_name);
    push(kanban.latest_run_metadata?.branch);
    push(kanban.latest_run_metadata?.pr_branch);
    push(kanban.latest_run_metadata?.head_ref);
  }
  push(task.github_pr_head_ref);

  return candidates;
}

// ── gh CLI Integration ──────────────────────────────────────────────────

let _ghAuthWarningIssued = false;

async function execGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf-8',
    timeout: 15_000,
    maxBuffer: 1024 * 512,
  });
  return stdout;
}

function isGhAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const stderr = (err as Error & { stderr?: string }).stderr ?? '';
  return /not authenticated|gh auth login|GH_TOKEN/i.test(`${err.message}\n${stderr}`);
}

function warnGhFailure(context: string, err: unknown): void {
  if (isGhAuthError(err)) {
    if (!_ghAuthWarningIssued) {
      console.warn('[github-status] gh CLI not authenticated — GitHub status enrichment degraded');
      _ghAuthWarningIssued = true;
    }
    return;
  }
  console.warn(`[github-status] ${context}:`, (err as Error)?.message ?? err);
}

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
  return 'pending';
}

/**
 * Aggregate the status check rollup into a single status.
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

  const summary = `${successCount} passed, ${failureCount} failed${hasPending ? ', some pending' : ''}`;
  return { status, summary };
}

/**
 * Fetch PR status via `gh pr view`.
 */
export async function fetchPrStatus(
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubPrStatus | null> {
  try {
    const json = await execGh([
      'pr', 'view', String(number),
      '--repo', `${owner}/${repo}`,
      '--json', 'url,number,state,headRefName,headRefOid,statusCheckRollup,mergeStateStatus',
    ]);
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
    warnGhFailure(`Failed to fetch PR ${owner}/${repo}#${number}`, err);
    return null;
  }
}

// ── Branch → PR Lookup ───────────────────────────────────────────────────

export interface BranchPrCandidate {
  ref: GitHubPrRef;
  state: string;
}

interface GhPrListItem {
  number: number;
  url: string;
  state: string;
  headRefName: string;
  updatedAt?: string;
}

const BRANCH_PR_CACHE_TTL_MS = 30_000;
const _branchPrCache = new Map<string, { at: number; result: BranchPrCandidate | null }>();

/**
 * Find the PR whose head is `branch` in `owner/repo` via `gh pr list --head`.
 * Prefers OPEN over MERGED over CLOSED; newest within the same state.
 * Results (including misses) are cached briefly to keep gh usage low.
 */
export async function findPrForBranch(
  owner: string,
  repo: string,
  branch: string,
): Promise<BranchPrCandidate | null> {
  const key = `${owner}/${repo}#${branch}`;
  const cached = _branchPrCache.get(key);
  if (cached && Date.now() - cached.at < BRANCH_PR_CACHE_TTL_MS) return cached.result;

  let result: BranchPrCandidate | null = null;
  try {
    const json = await execGh([
      'pr', 'list',
      '--repo', `${owner}/${repo}`,
      '--head', branch,
      '--state', 'all',
      '--limit', '10',
      '--json', 'number,url,state,headRefName,updatedAt',
    ]);
    const items = JSON.parse(json) as GhPrListItem[];
    const stateRank = (state: string): number =>
      state === 'OPEN' ? 0 : state === 'MERGED' ? 1 : 2;
    const best = items
      .filter((item) => item.headRefName === branch)
      .sort((a, b) =>
        stateRank(a.state) - stateRank(b.state)
        || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
    if (best) {
      result = {
        ref: {
          owner,
          repo,
          number: best.number,
          url: best.url.replace(/\/+$/, ''),
        },
        state: best.state,
      };
    }
  } catch (err: unknown) {
    warnGhFailure(`Branch PR lookup failed for ${owner}/${repo} head=${branch}`, err);
  }

  _branchPrCache.set(key, { at: Date.now(), result });
  return result;
}

const MAX_BRANCH_LOOKUPS = 2;

/**
 * Resolve the first branch candidate that has a PR in any candidate repo.
 * An OPEN PR returns immediately; otherwise the best merged/closed PR is
 * kept as a fallback.
 */
async function detectPrFromBranches(
  branches: string[],
  repos: GitHubRepoRef[],
): Promise<BranchPrCandidate | null> {
  let fallback: BranchPrCandidate | null = null;
  for (const branch of branches.slice(0, MAX_BRANCH_LOOKUPS)) {
    for (const repo of repos) {
      const candidate = await findPrForBranch(repo.owner, repo.repo, branch);
      if (!candidate) continue;
      if (candidate.state === 'OPEN') return candidate;
      if (!fallback) fallback = candidate;
    }
  }
  return fallback;
}

// ── Task Content Scanning ────────────────────────────────────────────────

interface GitHubStatusRefreshOptions {
  extraTexts?: Array<string | null | undefined>;
}

function safeGetKanbanInfo(kanbanId: string): KanbanTaskInfo | null {
  try {
    return getKanbanTaskInfo(kanbanId);
  } catch {
    return null;
  }
}

function gatherTaskTexts(
  task: Task,
  kanban: KanbanTaskInfo | null,
  options?: GitHubStatusRefreshOptions,
): string[] {
  const texts: string[] = [];

  if (task.description) texts.push(task.description);
  if (task.title) texts.push(task.title);

  if (kanban) {
    try {
      if (kanban.body) texts.push(kanban.body);
      if (kanban.latest_run_metadata) {
        const meta = kanban.latest_run_metadata;
        if (typeof meta.branch === 'string') texts.push(meta.branch);
        if (typeof meta.pr_url === 'string') texts.push(meta.pr_url);
      }

      const comments = getKanbanComments(kanban.kanban_id, 20);
      for (const c of comments) {
        if (c.body) texts.push(c.body);
      }

      const runs = getKanbanRuns(kanban.kanban_id, 5);
      for (const r of runs) {
        if (r.summary) texts.push(r.summary);
        if (r.error) texts.push(r.error);
      }
    } catch {
      // degrade gracefully
    }
  }

  // Keep the stored PR URL as a fallback, not as the first match. Subtasks can
  // inherit a parent PR during creation, but a worker may later create its own
  // PR and mention it in the child Kanban run/comment/body. Prefer the newest
  // task/kanban evidence over the stale inherited value.
  if (task.github_pr_url) texts.push(task.github_pr_url);

  if (options?.extraTexts) {
    for (const text of options.extraTexts) {
      if (text) texts.push(text);
    }
  }

  return texts;
}

export function findTaskGitHubPrRefs(task: Task, options?: GitHubStatusRefreshOptions): GitHubPrRef[] {
  const kanban = task.hermes_kanban_task_id ? safeGetKanbanInfo(task.hermes_kanban_task_id) : null;
  const texts = gatherTaskTexts(task, kanban, options);
  return dedupePrRefs(texts);
}

function dedupePrRefs(texts: string[]): GitHubPrRef[] {
  const prRefs = texts.flatMap((t) => extractGitHubPrRefs(t ?? ''));

  const seen = new Set<string>();
  const uniqueRefs: GitHubPrRef[] = [];
  for (const ref of prRefs) {
    if (!seen.has(ref.url)) {
      seen.add(ref.url);
      uniqueRefs.push(ref);
    }
  }
  return uniqueRefs;
}

// ── Main Service ─────────────────────────────────────────────────────────

type TaskGitHubFields = Pick<Task,
  | 'github_pr_url'
  | 'github_pr_number'
  | 'github_pr_state'
  | 'github_pr_head_ref'
  | 'github_pr_head_sha'
  | 'github_checks_status'
  | 'github_checks_summary'
>;

/**
 * Persist GitHub fields on a task; broadcast only when something actually
 * changed so periodic sweeps don't spam SSE clients or churn updated_at.
 */
function persistTaskGitHubFields(task: Task, fields: TaskGitHubFields): Task | null {
  const changed = (Object.keys(fields) as (keyof TaskGitHubFields)[])
    .some((key) => task[key] !== fields[key]);

  if (!changed) return task;

  const updated = updateTask(task.id, {
    ...fields,
    github_checks_updated_at: Date.now(),
  });
  if (updated) broadcast({ type: 'task_updated', task: updated });
  return updated ?? null;
}

/**
 * Refresh GitHub PR status for a task or subtask.
 *
 * Resolution order: OPEN PR on the task's own branch → PR URL found in
 * task/Kanban content → merged/closed PR on the branch → branch only.
 */
export async function refreshTaskGitHubStatus(
  task: Task,
  options?: GitHubStatusRefreshOptions,
): Promise<Task | null> {
  const kanban = task.hermes_kanban_task_id ? safeGetKanbanInfo(task.hermes_kanban_task_id) : null;
  const texts = gatherTaskTexts(task, kanban, options);
  const textRefs = dedupePrRefs(texts);
  const branches = findTaskBranchCandidates(task, kanban);
  const repos = resolveRepoCandidates(texts);

  const branchPr = branches.length > 0 && repos.length > 0
    ? await detectPrFromBranches(branches, repos)
    : null;

  let ref: GitHubPrRef | null = null;
  if (branchPr && branchPr.state === 'OPEN') {
    // The task's own branch has an open PR — strongest possible signal.
    ref = branchPr.ref;
  } else if (textRefs.length > 0) {
    ref = textRefs[0];
  } else if (branchPr) {
    ref = branchPr.ref;
  }

  if (!ref) {
    const detectedBranch = branches[0] ?? null;
    return persistTaskGitHubFields(task, {
      github_pr_url: null,
      github_pr_number: null,
      github_pr_state: null,
      github_pr_head_ref: detectedBranch,
      github_pr_head_sha: detectedBranch ? task.github_pr_head_sha : null,
      github_checks_status: 'unknown',
      github_checks_summary: detectedBranch
        ? `Branch ${detectedBranch} — no PR yet`
        : 'No PR URL found',
    });
  }

  const prStatus = await fetchPrStatus(ref.owner, ref.repo, ref.number);

  if (!prStatus) {
    console.warn(`[github-status] Could not fetch status for ${ref.url}`);
    return null;
  }

  return persistTaskGitHubFields(task, {
    github_pr_url: prStatus.url,
    github_pr_number: prStatus.number,
    github_pr_state: prStatus.state,
    github_pr_head_ref: prStatus.headRefName,
    github_pr_head_sha: prStatus.headRefOid,
    github_checks_status: prStatus.checksStatus,
    github_checks_summary: prStatus.checksSummary,
  });
}

// ── Automatic Background Refresh ─────────────────────────────────────────

const AUTO_REFRESH_DEFAULT_INTERVAL_MS = 60_000;
const AUTO_REFRESH_BATCH_SIZE = 5;

let _autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let _sweepInFlight = false;
const _lastSweepCheckAt = new Map<string, number>();

function isAutoRefreshCandidate(task: Task): boolean {
  if (task.status !== 'in_progress' && task.status !== 'in_review') return false;
  if (task.github_pr_state === 'MERGED' || task.github_pr_state === 'CLOSED') return false;
  return Boolean(task.hermes_kanban_task_id || task.github_pr_url || task.github_pr_head_ref);
}

/**
 * One sweep: refresh the GitHub status of the least-recently-checked active
 * tasks/subtasks. Batch-limited so gh CLI usage stays modest.
 */
export async function sweepGitHubStatuses(limit = AUTO_REFRESH_BATCH_SIZE): Promise<number> {
  if (_sweepInFlight) return 0;
  _sweepInFlight = true;
  try {
    const allTasks = getAllTasks();
    const liveIds = new Set(allTasks.map((t) => t.id));
    for (const id of _lastSweepCheckAt.keys()) {
      if (!liveIds.has(id)) _lastSweepCheckAt.delete(id);
    }

    const candidates = allTasks
      .filter(isAutoRefreshCandidate)
      .sort((a, b) => (_lastSweepCheckAt.get(a.id) ?? 0) - (_lastSweepCheckAt.get(b.id) ?? 0))
      .slice(0, limit);

    let refreshed = 0;
    for (const task of candidates) {
      _lastSweepCheckAt.set(task.id, Date.now());
      const result = await refreshTaskGitHubStatus(task).catch(() => null);
      if (result) refreshed++;
    }
    return refreshed;
  } finally {
    _sweepInFlight = false;
  }
}

/**
 * Start the periodic GitHub status auto-refresh for active tasks/subtasks.
 * Configure via GITHUB_STATUS_REFRESH_INTERVAL_MS; disable with
 * GITHUB_STATUS_AUTO_REFRESH=off.
 */
export function startGitHubStatusAutoRefresh(intervalMs?: number): () => void {
  if (_autoRefreshTimer) return stopGitHubStatusAutoRefresh;
  if (process.env.GITHUB_STATUS_AUTO_REFRESH === 'off') return stopGitHubStatusAutoRefresh;

  const envMs = Number(process.env.GITHUB_STATUS_REFRESH_INTERVAL_MS);
  const ms = intervalMs
    ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : AUTO_REFRESH_DEFAULT_INTERVAL_MS);

  _autoRefreshTimer = setInterval(() => void sweepGitHubStatuses(), ms);
  _autoRefreshTimer.unref?.();
  return stopGitHubStatusAutoRefresh;
}

export function stopGitHubStatusAutoRefresh(): void {
  if (!_autoRefreshTimer) return;
  clearInterval(_autoRefreshTimer);
  _autoRefreshTimer = null;
}
