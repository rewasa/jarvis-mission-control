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
import { getKanbanTaskInfo, getKanbanRuns, getKanbanComments } from './kanban-bridge.js';
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

let _ghAuthWarningIssued = false;

/**
 * Fetch PR status via `gh pr view`.
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
    console.warn(`[github-status] Failed to fetch PR ${owner}/${repo}#${number}:`, (err as Error)?.message ?? err);
    return null;
  }
}

// ── Task Content Scanning ────────────────────────────────────────────────

function gatherTaskTexts(task: Task): string[] {
  const texts: string[] = [];

  if (task.description) texts.push(task.description);
  if (task.title) texts.push(task.title);

  if (task.github_pr_url) texts.push(task.github_pr_url);

  if (task.hermes_kanban_task_id) {
    try {
      const kanbanTask = getKanbanTaskInfo(task.hermes_kanban_task_id);
      if (kanbanTask?.body) texts.push(kanbanTask.body);
      if (kanbanTask?.latest_run_metadata) {
        const meta = kanbanTask.latest_run_metadata;
        if (typeof meta.branch === 'string') texts.push(meta.branch);
        if (typeof meta.pr_url === 'string') texts.push(meta.pr_url);
      }

      const comments = getKanbanComments(task.hermes_kanban_task_id, 20);
      for (const c of comments) {
        if (c.body) texts.push(c.body);
      }

      const runs = getKanbanRuns(task.hermes_kanban_task_id, 5);
      for (const r of runs) {
        if (r.summary) texts.push(r.summary);
        if (r.error) texts.push(r.error);
      }
    } catch {
      // degrade gracefully
    }
  }

  return texts;
}

/**
 * Search GitHub for a PR that matches the task title keywords.
 * Used as a fallback when no PR URL is found in Kanban data.
 */
/** Search GitHub for PRs matching task via commit messages + PR title. */
async function searchPrByTitle(task: Task): Promise<GitHubPrRef | null> {
  try {
    // Strategy 1: search commit messages for distinctive body phrases.
    // Collect ALL unique PRs across all phrases, then pick the one with best keyword overlap.
    if (task.description) {
      // Split into atomic words, also break apart paths like /a/b/c and hyphenated terms
      const rawWords = task.description.split(/[\s,;.!?:"'()\[\]{}]+/);
      const words: string[] = [];
      for (const w of rawWords) {
        const subParts = w.split(/[\/:]+/).filter(Boolean);
        for (const part of subParts) {
          // Further split hyphenated terms (meeting-links → meeting, links)
          const hyphenParts = part.split('-').filter(Boolean);
          words.push(...hyphenParts);
        }
      }
      const phrases = words
        .map(w => w.replace(/[^a-z0-9_-]/gi, ''))
        .filter(p => p.length > 3);

      // Try each word + adjacent word pairs
      const phrasePairs: string[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < phrases.length; i++) {
        if (!seen.has(phrases[i])) { phrasePairs.push(phrases[i]); seen.add(phrases[i]); }
        if (i + 1 < phrases.length) {
          const pair = `${phrases[i]} ${phrases[i + 1]}`;
          if (!seen.has(pair)) { phrasePairs.push(pair); seen.add(pair); }
        }
        if (i + 2 < phrases.length) {
          const trio = `${phrases[i]} ${phrases[i + 1]} ${phrases[i + 2]}`;
          if (!seen.has(trio)) { phrasePairs.push(trio); seen.add(trio); }
        }
      }

      const candidatePrs = new Map<number, string>(); // prNum → url
      for (const p of phrasePairs.slice(0, 15)) {
        try {
          const commitJson = execSync(
            `cd /Users/renatowasescha/GIT/AgentSelly/monorepo && gh search commits --repo AgentSelly/monorepo ${p} --json commit --limit 3`,
            { encoding: 'utf-8', timeout: 10_000, maxBuffer: 128 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
          );
          const commits: Array<{ commit: { message: string } }> = JSON.parse(commitJson);
          for (const { commit } of commits) {
            const prMatch = commit.message.match(/\(#(\d+)\)/);
            if (prMatch) {
              const prNum = parseInt(prMatch[1], 10);
              if (!candidatePrs.has(prNum)) {
                candidatePrs.set(prNum, `https://github.com/AgentSelly/monorepo/pull/${prNum}`);
              }
            }
          }
        } catch { /* try next phrase */ }
      }
      console.log(`[github-status] Commit search collected ${candidatePrs.size} PR candidates`);

      if (candidatePrs.size > 0) {
        // Score each candidate PR by keyword overlap with task description
        const taskWords = new Set(
          [task.title, task.description].join(' ')
            .toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
            .filter(w => w.length > 2)
        );
        let bestScore = 0;
        let bestUrl = '';

        for (const [prNum, url] of candidatePrs) {
          try {
            const titleJson = execSync(
              `cd /Users/renatowasescha/GIT/AgentSelly/monorepo && gh pr view ${prNum} --json title --jq .title`,
              { encoding: 'utf-8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
            );
            const prTitle = titleJson.trim();
            const prWords = new Set(prTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/));
            let score = 0;
            for (const w of taskWords) if (prWords.has(w)) score++;
            if (score > bestScore) {
              bestScore = score;
              bestUrl = url;
            }
          } catch { /* skip */ }
        }

        if (bestUrl) {
          console.log(`[github-status] Found PR via commit search (scored: ${bestScore} keywords, ${candidatePrs.size} candidates): ${bestUrl}`);
          const m = bestUrl.match(/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pull\/(\d+)/);
          if (m) return { owner: m[1], repo: m[2], number: parseInt(m[3]), url: bestUrl };
        }
      }
    }

    // Strategy 2: search by task title + description using distinctive keywords
    const searchText = [task.title, task.description].filter(Boolean).join(' ');
    if (!searchText.trim()) return null;

    // Tokenize: lowercase, split on common delimiters, strip trailing punctuation
    const stopwords = new Set(['the','and','for','not','wie','auf','der','die','das','ist','von','mit','bei','ein','sind','wird','auch','oder','hat','des','dem','den','im','am','zu','zur','zum','es','er','sie','wir','ich','was','wie','wo','wann','dass','eine','einen','einer','sich','nach','vor','bei','aus','um','über','unter','aber','nur','noch','schon','auch','dann','mehr','sehr','als','bis','ab']);
    const allWords = searchText
      .toLowerCase()
      .replace(/[^\w\s\/\-]/g, ' ')
      .split(/[\s\/]+/)   // split on whitespace and slashes
      .flatMap(w => w.includes('-') ? w.split('-') : [w])
      .map(w => w.replace(/[^a-z0-9]/g, ''))  // strip remaining garbage
      .filter(w => w.length > 2 && !stopwords.has(w));

    // Deduplicate preserving order
    const unique = [...new Set(allWords)];

    // Strategy 2a: try multiple keyword subsets with AND-based GitHub search.
    // GitHub requires ALL terms to match, so we try progressively smaller sets
    // dropping proper nouns (HubSpot) that may not appear in the PR title.
    const properNouns = new Set(['hubspot', 'agentselly', 'renato', 'wasescha']);
    const withoutProper = unique.filter(w => !properNouns.has(w));

    const combos = [
      unique.slice(0, 12).join(' '),
      unique.slice(0, 6).join(' '),
      withoutProper.slice(0, 6).join(' '),
      unique.filter(w => w.length > 4).slice(0, 5).join(' '),
      withoutProper.filter(w => w.length > 3).slice(0, 4).join(' '),
      unique.filter(w => /\d/.test(w) || /^(api|link|meet|unified|fix|degrad|403|cach|warn|error|scope|token)$/.test(w)).slice(0, 5).join(' '),
      unique.slice(3, 9).join(' '),  // skip first 3 words (often title words)
    ].filter(c => c.length > 5);
    // Deduplicate combos
    const tried = new Set<string>();
    const uniqueCombos = combos.filter(c => !tried.has(c) && !!tried.add(c));

    // Collect ALL unique PRs across all combos, then pick the best match
    const allCandidates = new Map<number, { url: string; title: string }>();
    for (const subset of combos) {
      if (subset.length < 5) continue;
      try {
        const json2 = execSync(
          `cd /Users/renatowasescha/GIT/AgentSelly/monorepo && gh search prs --repo AgentSelly/monorepo "${subset}" --merged --json number,url,title --limit 10`,
          { encoding: 'utf-8', timeout: 15_000, maxBuffer: 1024 * 512, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const prs2: Array<{ number: number; url: string; title: string }> = JSON.parse(json2);
        for (const pr of prs2) {
          if (!allCandidates.has(pr.number)) {
            allCandidates.set(pr.number, { url: pr.url, title: pr.title });
          }
        }
      } catch {
        // try next combo
      }
    }

    if (allCandidates.size > 0) {
      // Score all candidates by keyword overlap with task description
      const taskWords = new Set(unique);
      let best: { url: string; number: number; overlap: number } | null = null;

      for (const [num, { url, title }] of allCandidates) {
        const titleWords = title.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
        const overlap = titleWords.filter(w => taskWords.has(w)).length;
        if (overlap > 0 && (!best || overlap > best.overlap)) {
          best = { url, number: num, overlap };
        }
      }

      if (best) {
        const urlMatch = best.url.match(/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pull\/(\d+)/);
        if (urlMatch) {
          console.log(`[github-status] Found PR via title search (scored: ${best.overlap} keywords, ${allCandidates.size} candidates): ${best.url}`);
          return { owner: urlMatch[1], repo: urlMatch[2], number: best.number, url: best.url };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ── Main Service ─────────────────────────────────────────────────────────

/**
 * Refresh GitHub PR status for a task.
 */
export async function refreshTaskGitHubStatus(task: Task): Promise<Task | null> {
  const texts = gatherTaskTexts(task);
  const prRefs = texts.flatMap((t) => extractGitHubPrRefs(t ?? ''));

  const seen = new Set<string>();
  const uniqueRefs: GitHubPrRef[] = [];
  for (const ref of prRefs) {
    if (!seen.has(ref.url)) {
      seen.add(ref.url);
      uniqueRefs.push(ref);
    }
  }

  // Fallback: if no PR URL found in Kanban data, search GitHub by task title
  if (uniqueRefs.length === 0) {
    const fallback = await searchPrByTitle(task);
    if (fallback) {
      console.log(`[github-status] Found PR via title search: ${fallback.url}`);
      uniqueRefs.push(fallback);
    }
  }

  if (uniqueRefs.length === 0) {
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
