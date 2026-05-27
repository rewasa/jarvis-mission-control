/**
 * GitHub PR merge service for AgentControl tasks.
 *
 * A task may only be completed into `done` after its linked GitHub PR is
 * actually merged into `main`. The PR link is resolved through the same
 * enrichment path as the card status badge, so Kanban comments/runs that
 * mention a PR URL are enough to bind task → PR.
 */

import { execFileSync } from 'node:child_process';
import { updateTask } from '../db/queries.js';
import { broadcast } from '../events.js';
import { refreshTaskGitHubStatus } from './github-status.js';
import type { GitHubMergeResponse, Task } from '../../shared/types.js';

interface GhPrViewForMerge {
  url: string;
  number: number;
  state: string;
  baseRefName: string;
  mergeable: string | null;
  mergeStateStatus: string | null;
  isDraft: boolean;
}

function splitGitHubPrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    number: Number.parseInt(match[3], 10),
  };
}

function ghPrView(owner: string, repo: string, number: number): GhPrViewForMerge {
  const stdout = execFileSync(
    'gh',
    [
      'pr',
      'view',
      String(number),
      '--repo',
      `${owner}/${repo}`,
      '--json',
      'url,number,state,baseRefName,mergeable,mergeStateStatus,isDraft',
    ],
    {
      encoding: 'utf-8',
      timeout: 20_000,
      maxBuffer: 1024 * 512,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return JSON.parse(stdout) as GhPrViewForMerge;
}

function runGhPrMerge(
  owner: string,
  repo: string,
  number: number,
  auto: boolean,
): { autoMergeEnabled: boolean } {
  const args = [
    'pr',
    'merge',
    String(number),
    '--repo',
    `${owner}/${repo}`,
    '--squash',
    '--delete-branch',
  ];

  if (auto) args.push('--auto');

  execFileSync('gh', args, {
    encoding: 'utf-8',
    timeout: 45_000,
    maxBuffer: 1024 * 512,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return { autoMergeEnabled: auto };
}

function buildResponse(
  task: Task,
  status: GitHubMergeResponse['status'],
  message: string,
  pr: Partial<GhPrViewForMerge> | null,
  autoMergeEnabled = false,
): GitHubMergeResponse {
  return {
    taskId: task.id,
    github_pr_url: task.github_pr_url,
    github_pr_number: task.github_pr_number,
    github_pr_state: task.github_pr_state,
    github_pr_head_ref: task.github_pr_head_ref,
    github_pr_head_sha: task.github_pr_head_sha,
    github_checks_status: task.github_checks_status,
    github_checks_summary: task.github_checks_summary,
    github_checks_updated_at: task.github_checks_updated_at,
    status,
    merged: status === 'merged',
    autoMergeEnabled,
    message,
    mergeStateStatus: pr?.mergeStateStatus ?? null,
    mergeable: pr?.mergeable ?? null,
    baseRefName: pr?.baseRefName ?? null,
  };
}

export async function mergeLinkedPullRequestForTask(task: Task): Promise<GitHubMergeResponse> {
  const refreshed = await refreshTaskGitHubStatus(task);
  const taskWithPr = refreshed ?? task;
  const prUrl = taskWithPr.github_pr_url;

  if (!prUrl) {
    return buildResponse(
      taskWithPr,
      'blocked',
      'Task has no linked GitHub PR. Add or sync a PR URL before marking it complete.',
      null,
    );
  }

  const ref = splitGitHubPrUrl(prUrl);
  if (!ref) {
    return buildResponse(taskWithPr, 'blocked', `Unsupported GitHub PR URL: ${prUrl}`, null);
  }

  let pr = ghPrView(ref.owner, ref.repo, ref.number);
  if (pr.baseRefName !== 'main') {
    return buildResponse(
      taskWithPr,
      'blocked',
      `Linked PR targets ${pr.baseRefName}, not main. Refusing to complete task.`,
      pr,
    );
  }

  if (pr.isDraft) {
    return buildResponse(taskWithPr, 'blocked', 'Linked PR is still a draft.', pr);
  }

  if (pr.state === 'MERGED') {
    const updated = updateTask(taskWithPr.id, {
      github_pr_state: 'MERGED',
      github_checks_updated_at: Date.now(),
    });
    if (updated) broadcast({ type: 'task_updated', task: updated });
    return buildResponse(
      updated ?? taskWithPr,
      'merged',
      `Linked PR already merged: ${pr.url}`,
      pr,
    );
  }

  if (pr.state !== 'OPEN') {
    return buildResponse(taskWithPr, 'blocked', `Linked PR is ${pr.state}, not OPEN.`, pr);
  }

  try {
    if (pr.mergeStateStatus === 'CLEAN') {
      runGhPrMerge(ref.owner, ref.repo, ref.number, false);
      pr = ghPrView(ref.owner, ref.repo, ref.number);
      const updated = updateTask(taskWithPr.id, {
        github_pr_state: 'MERGED',
        github_checks_updated_at: Date.now(),
      });
      if (updated) broadcast({ type: 'task_updated', task: updated });
      return buildResponse(
        updated ?? taskWithPr,
        'merged',
        `Merged linked PR into main: ${pr.url}`,
        pr,
      );
    }

    if (pr.mergeStateStatus === 'BLOCKED' || pr.mergeStateStatus === 'UNSTABLE') {
      runGhPrMerge(ref.owner, ref.repo, ref.number, true);
      return buildResponse(
        taskWithPr,
        'auto_merge_enabled',
        `Linked PR is waiting on checks/review; enabled GitHub auto-merge. Task will stay open until GitHub merges it: ${pr.url}`,
        pr,
        true,
      );
    }
  } catch (err: unknown) {
    return buildResponse(
      taskWithPr,
      'blocked',
      err instanceof Error ? err.message : 'GitHub merge command failed',
      pr,
    );
  }

  return buildResponse(
    taskWithPr,
    'blocked',
    `Linked PR is not merge-ready (${pr.mergeStateStatus ?? 'unknown'}).`,
    pr,
  );
}
