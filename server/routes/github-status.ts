/**
 * GitHub PR + check status API endpoints for tasks.
 *
 * GET  /api/tasks/:id/github  — read current stored GitHub status
 * POST /api/tasks/:id/github/refresh — fetch fresh status from GitHub
 */

import { Router } from 'express';
import { getTask } from '../db/queries.js';
import { refreshTaskGitHubStatus } from '../services/github-status.js';
import type { Task } from '../../shared/types.js';

export const githubStatusRouter = Router({ mergeParams: true });

/**
 * GET /api/tasks/:id/github
 *
 * Returns the current GitHub PR + checks status for a task.
 */
githubStatusRouter.get('/:id/github', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  res.json({
    taskId: task.id,
    github_pr_url: task.github_pr_url,
    github_pr_number: task.github_pr_number,
    github_pr_state: task.github_pr_state,
    github_pr_head_ref: task.github_pr_head_ref,
    github_pr_head_sha: task.github_pr_head_sha,
    github_checks_status: task.github_checks_status,
    github_checks_summary: task.github_checks_summary,
    github_checks_updated_at: task.github_checks_updated_at,
  });
});

/**
 * POST /api/tasks/:id/github/refresh
 *
 * Scans task content (description, title, linked kanban task) for
 * GitHub PR URLs, fetches current PR state + Actions/check status
 * via `gh` CLI, persists to DB, and broadcasts a task_updated event.
 *
 * Returns the fresh GitHub status.
 *
 * Graceful degradation: if `gh` CLI is not authenticated, returns
 * `{ github_checks_status: 'unknown', note: 'gh CLI not authenticated' }`.
 */
githubStatusRouter.post('/:id/github/refresh', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  try {
    const updated = await refreshTaskGitHubStatus(task);

    if (!updated) {
      // PR found but fetch failed (auth issue, network, etc.)
      return res.json({
        taskId: task.id,
        note: 'GitHub PR URL found but status fetch failed. Check if `gh` CLI is authenticated.',
        github_pr_url: task.github_pr_url,
        github_pr_number: task.github_pr_number,
        github_pr_state: task.github_pr_state,
        github_pr_head_ref: task.github_pr_head_ref,
        github_pr_head_sha: task.github_pr_head_sha,
        github_checks_status: task.github_checks_status || 'unknown',
        github_checks_summary: task.github_checks_summary || 'Fetch failed',
        github_checks_updated_at: task.github_checks_updated_at,
      });
    }

    res.json({
      taskId: updated.id,
      github_pr_url: updated.github_pr_url,
      github_pr_number: updated.github_pr_number,
      github_pr_state: updated.github_pr_state,
      github_pr_head_ref: updated.github_pr_head_ref,
      github_pr_head_sha: updated.github_pr_head_sha,
      github_checks_status: updated.github_checks_status,
      github_checks_summary: updated.github_checks_summary,
      github_checks_updated_at: updated.github_checks_updated_at,
    });
  } catch (err) {
    console.error('[github-status] Refresh error:', err);
    res.status(500).json({
      error: 'Failed to refresh GitHub status',
      github_checks_status: 'unknown',
    });
  }
});
