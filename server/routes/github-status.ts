/**
 * GitHub PR + check status API endpoints for tasks.
 *
 * GET  /api/tasks/:id/github  — read current stored GitHub status
 * POST /api/tasks/:id/github/refresh — fetch fresh status from GitHub
 * POST /api/tasks/:id/github/merge — merge or enable auto-merge for linked PR
 */

import { Router } from 'express';
import { getTask, updateTask } from '../db/queries.js';
import { mergeLinkedPullRequestForTask } from '../services/github-merge.js';
import { extractGitHubPrRefs, refreshTaskGitHubStatus } from '../services/github-status.js';
import type { Task } from '../../shared/types.js';

export const githubStatusRouter = Router({ mergeParams: true });

function githubStatusPayload(task: Task) {
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
  };
}

/**
 * GET /api/tasks/:id/github
 */
githubStatusRouter.get('/:id/github', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  res.json(githubStatusPayload(task));
});

/**
 * POST /api/tasks/:id/github/refresh
 */
githubStatusRouter.post('/:id/github/refresh', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  try {
    const updated = await refreshTaskGitHubStatus(task);

    if (!updated) {
      return res.json({
        ...githubStatusPayload(task),
        refreshed: false,
        note: 'No PR URL found or fetch failed',
        github_checks_status: task.github_checks_status ?? 'unknown',
      });
    }

    res.json({
      ...githubStatusPayload(updated),
      refreshed: true,
    });
  } catch (err: unknown) {
    console.error('[github-status] Refresh error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'GitHub refresh failed',
      github_checks_status: 'unknown',
    });
  }
});

/**
 * POST /api/tasks/:id/github/link
 */
githubStatusRouter.post('/:id/github/link', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const rawPrUrl = typeof req.body?.prUrl === 'string' ? req.body.prUrl.trim() : '';
  if (!rawPrUrl) {
    const updated = updateTask(task.id, {
      github_pr_url: null,
      github_pr_number: null,
      github_pr_state: null,
      github_pr_head_ref: null,
      github_pr_head_sha: null,
      github_checks_status: null,
      github_checks_summary: null,
      github_checks_updated_at: null,
    }) ?? task;
    return res.json({
      ...githubStatusPayload(updated),
      linked: false,
      refreshed: false,
      note: 'PR link cleared',
    });
  }

  const [ref] = extractGitHubPrRefs(rawPrUrl);
  if (!ref) {
    return res.status(400).json({ error: 'Expected a GitHub pull request URL like https://github.com/owner/repo/pull/123' });
  }

  const linked = updateTask(task.id, {
    github_pr_url: ref.url,
    github_pr_number: ref.number,
    github_checks_status: 'unknown',
    github_checks_summary: 'PR linked manually — sync pending',
    github_checks_updated_at: Date.now(),
  }) ?? task;

  try {
    const refreshed = await refreshTaskGitHubStatus(linked);
    return res.json({
      ...githubStatusPayload(refreshed ?? linked),
      linked: true,
      refreshed: Boolean(refreshed),
      note: refreshed ? undefined : 'PR linked; GitHub status refresh unavailable',
    });
  } catch {
    return res.json({
      ...githubStatusPayload(linked),
      linked: true,
      refreshed: false,
      note: 'PR linked; GitHub status refresh failed',
    });
  }
});

/**
 * POST /api/tasks/:id/github/merge
 */
githubStatusRouter.post('/:id/github/merge', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  try {
    const result = await mergeLinkedPullRequestForTask(task);
    if (result.status === 'blocked' || result.status === 'skipped_no_pr') {
      return res.status(409).json({
        error: result.message,
        ...result,
      });
    }
    res.json(result);
  } catch (err: unknown) {
    console.error('[github-status] Merge error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'GitHub merge failed',
      status: 'blocked',
      merged: false,
      autoMergeEnabled: false,
    });
  }
});
