import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { getAllTasks, getTask, insertTask, updateTask, deleteTask, markTaskViewed, getSubtasks, getSubtaskCount } from '../db/queries.js';
import { broadcast } from '../events.js';
import { adapter } from '../app.js';
import { startTaskChatRun } from './chat.js';
import { createKanbanTask, ensureKanbanRootTaskForAgentControlTask, extractKanbanTaskIdsFromText, findBoardForKanbanTask, getBoardTaskTranscriptPath, getKanbanComments, getKanbanTaskInfo, getKanbanLogs, getKanbanRuns, syncKanbanChildrenForTask, syncTaskStatusFromKanban, updateKanbanTaskStatusFromAgentControl } from '../services/kanban-bridge.js';
import { refreshTaskGitHubStatus, extractGitHubPrRefs } from '../services/github-status.js';
import { mergeLinkedPullRequestForTask } from '../services/github-merge.js';
import type { TaskMessage } from '../../shared/types.js';
import { TASK_STATUSES, DELEGATION_STATUSES } from '../../shared/types.js';
import type { TaskStatus, DelegationStatus } from '../../shared/types.js';

export const tasksRouter = Router();

const LOW_INFORMATION_TITLES = new Set(['?', 'hi', 'hello', 'hey', 'yo']);

type TaskUpdateFields = Parameters<typeof updateTask>[1];

function completeSubtaskTree(parentId: string): number {
  let completed = 0;
  const subtasks = getSubtasks(parentId);

  for (const subtask of subtasks) {
    completed += completeSubtaskTree(subtask.id);
    const fields: TaskUpdateFields = { status: 'done' };
    if (subtask.delegation_status) fields.delegation_status = 'done';
    const updated = updateTask(subtask.id, fields);
    if (updated) {
      completed += 1;
      broadcast({ type: 'task_updated', task: updated });
    }
  }

  return completed;
}

function updateTaskStatus(taskId: string, status: TaskStatus): { task: ReturnType<typeof getTask>; subtasksCompleted: number } {
  const current = getTask(taskId);
  if (!current) return { task: undefined, subtasksCompleted: 0 };

  const subtasksCompleted = status === 'done' ? completeSubtaskTree(taskId) : 0;
  if (current.hermes_kanban_task_id) {
    updateKanbanTaskStatusFromAgentControl(current.hermes_kanban_task_id, status);
  }
  const updated = updateTask(taskId, { status });
  if (updated) broadcast({ type: 'task_updated', task: updated });

  return { task: updated, subtasksCompleted };
}

async function completeTaskWithLinkedPrMerge(taskId: string): Promise<{
  task: ReturnType<typeof getTask>;
  subtasksCompleted: number;
  githubMerge: Awaited<ReturnType<typeof mergeLinkedPullRequestForTask>> | null;
}> {
  const current = getTask(taskId);
  if (!current) return { task: undefined, subtasksCompleted: 0, githubMerge: null };

  const githubMerge = await mergeLinkedPullRequestForTask(current);
  if (githubMerge.status === 'blocked' || githubMerge.status === 'auto_merge_enabled') {
    return { task: getTask(taskId) ?? current, subtasksCompleted: 0, githubMerge };
  }

  const result = updateTaskStatus(taskId, 'done');
  return { ...result, githubMerge };
}

tasksRouter.get('/', (req, res) => {
  const status = req.query.status as TaskStatus | undefined;
  const tasks = getAllTasks()
    .map(task => (task.hermes_kanban_task_id ? syncTaskStatusFromKanban(task).task : task))
    .filter(task => !status || task.status === status);
  res.json({ tasks });
});

function recentTaskMessageTexts(messages: TaskMessage[], limit = 80): string[] {
  return messages
    .slice(-limit)
    .map((message) => [message.content, message.thinking].filter(Boolean).join('\n'))
    .filter(Boolean);
}

tasksRouter.get('/:id', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const synced = task.hermes_kanban_task_id
    ? syncTaskStatusFromKanban(task).task
    : task;

  let messageTexts: string[] = [];
  if (synced.hermes_kanban_task_id || synced.last_agent_response_at !== null) {
    try {
      messageTexts = recentTaskMessageTexts(await adapter.getMessages(synced.id, synced.id));
    } catch {
      // Best-effort: Kanban evidence still gets scanned below.
    }
  }

  const enriched = synced.hermes_kanban_task_id || messageTexts.length > 0
    ? await refreshTaskGitHubStatus(synced, { extraTexts: messageTexts }).catch(() => null)
    : null;
  const finalTask = enriched?.hermes_kanban_task_id
    ? syncTaskStatusFromKanban(enriched).task
    : enriched ?? synced;
  res.json({ task: finalTask });
});

function generateTitle(text: string): string {
  const firstLine = text.split(/\n/)[0].trim();
  const normalizedFirstLine = firstLine.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/g, '').trim();
  if (!normalizedFirstLine || LOW_INFORMATION_TITLES.has(normalizedFirstLine)) return 'Untitled task';

  const firstSentence = firstLine.split(/[.!?]/)[0].trim();
  if (!firstSentence) return text.slice(0, 60).trim() || 'Untitled task';
  if (firstSentence.length <= 60) return firstSentence;
  return firstSentence.slice(0, 57) + '...';
}

async function enrichTaskTitle(taskId: string, fallbackTitle: string, description: string): Promise<void> {
  try {
    const { title } = await adapter.generateTitle(description);
    const cleaned = title.trim();
    if (!cleaned || cleaned === fallbackTitle) return;

    const current = getTask(taskId);
    if (!current || current.title !== fallbackTitle) return;

    const updated = updateTask(taskId, { title: cleaned });
    if (updated) broadcast({ type: 'task_updated', task: updated });
  } catch {
    // Best-effort: leave the fallback title in place if the LLM call fails.
  }
}

tasksRouter.post('/', (req, res) => {
  const { description, title, kanban, delegation_profile, github_pr_url, branch } = req.body;
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description is required' });
  }

  const userTitle = typeof title === 'string' ? title.trim() : '';
  const resolvedTitle = userTitle || generateTitle(description);
  const wantsKanban = kanban !== false;
  const resolvedProfile = typeof delegation_profile === 'string' && delegation_profile.trim()
    ? delegation_profile.trim()
    : 'orchestrator';
  const resolvedPrUrl = typeof github_pr_url === 'string' && github_pr_url.trim()
    ? extractGitHubPrRefs(github_pr_url.trim())[0]?.url ?? github_pr_url.trim()
    : extractGitHubPrRefs(description)[0]?.url ?? null;
  const resolvedBranch = typeof branch === 'string' && branch.trim()
    ? branch.trim()
    : null;
  let task = insertTask({
    title: resolvedTitle,
    description,
    status: 'todo',
    delegation_profile: wantsKanban ? resolvedProfile : undefined,
    assignee: wantsKanban ? resolvedProfile : undefined,
    external_source: wantsKanban ? 'agentcontrol-kanban-root' : undefined,
  });

  if (resolvedPrUrl) {
    const updated = updateTask(task.id, { github_pr_url: resolvedPrUrl });
    if (updated) task = updated;
  }

  if (wantsKanban) {
    try {
      task = ensureKanbanRootTaskForAgentControlTask(task, {
        defaultAssignee: resolvedProfile,
        prUrl: resolvedPrUrl,
        branch: resolvedBranch,
      });
    } catch (e) {
      console.error(`[kanban-bridge] Failed to create Kanban root task for AgentControl task ${task.id}:`, e instanceof Error ? e.message : e);
    }
  }

  broadcast({ type: 'task_created', task });
  res.status(201).json({ task });

  if (!userTitle) {
    void enrichTaskTitle(task.id, resolvedTitle, description);
  }
});

tasksRouter.patch('/:id', async (req, res) => {
  const allowed = ['title', 'description', 'status', 'priority', 'labels_json', 'assignee', 'delegation_status', 'parent_task_id', 'agent_model', 'reasoning_effort', 'hermes_kanban_task_id', 'delegation_profile', 'external_source', 'github_pr_url', 'github_pr_number', 'github_pr_state', 'github_pr_head_ref', 'github_pr_head_sha', 'github_checks_status', 'github_checks_summary', 'github_checks_updated_at'] as const;
  const fields: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) fields[key] = req.body[key];
  }

  if (fields.status && !TASK_STATUSES.includes(fields.status as TaskStatus)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  if (fields.delegation_status && !DELEGATION_STATUSES.includes(fields.delegation_status as DelegationStatus)) {
    return res.status(400).json({ error: `delegation_status must be one of: ${DELEGATION_STATUSES.join(', ')}` });
  }

  if (fields.status) {
    const requestedStatus = fields.status as TaskStatus;
    const result = requestedStatus === 'done'
      ? await completeTaskWithLinkedPrMerge(req.params.id)
      : { ...updateTaskStatus(req.params.id, requestedStatus), githubMerge: null };
    if (!result.task) return res.status(404).json({ error: 'Task not found' });
    if (result.githubMerge?.status === 'blocked' || result.githubMerge?.status === 'auto_merge_enabled') {
      return res.status(409).json({
        error: result.githubMerge.message,
        task: result.task,
        subtasksCompleted: result.subtasksCompleted,
        githubMerge: result.githubMerge,
      });
    }
    const remainingFields = { ...fields };
    delete remainingFields.status;
    const updated = Object.keys(remainingFields).length > 0
      ? updateTask(req.params.id, remainingFields)
      : result.task;
    if (!updated) return res.status(404).json({ error: 'Task not found' });
    if (updated !== result.task) broadcast({ type: 'task_updated', task: updated });
    return res.json({ task: updated, subtasksCompleted: result.subtasksCompleted, githubMerge: result.githubMerge });
  }

  const updated = updateTask(req.params.id, fields);
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_updated', task: updated });
  res.json({ task: updated });
});

tasksRouter.post('/:id/viewed', (req, res) => {
  const { task, changed } = markTaskViewed(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (changed) broadcast({ type: 'task_updated', task });
  res.json({ task });
});

tasksRouter.delete('/:id', (req, res) => {
  const deleted = deleteTask(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_deleted', taskId: req.params.id });
  res.json({ ok: true });
});

// Subtask routes — each subtask is a real Task with parent_task_id
tasksRouter.get('/:id/subtasks', async (req, res) => {
  const parent = getTask(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Task not found' });

  if (parent.hermes_kanban_task_id) {
    try {
      await syncKanbanChildrenForTask(parent);
    } catch (err) {
      console.warn('[kanban-bridge] Automatic child sync skipped:', err instanceof Error ? err.message : err);
    }
  }

  const subtasks = getSubtasks(req.params.id);
  res.json({ parent, subtasks });
});

tasksRouter.post('/:id/subtasks', (req, res) => {
  const parent = getTask(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Task not found' });

  const { title, description, delegate, agent_model, reasoning_effort, priority, labels, assignee, github_pr_url } = req.body;
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title is required' });
  }

  // If delegation requested and description not provided, use title as description
  const resolvedDescription = typeof description === 'string' ? description : title;
  const explicitSubtaskPrUrl = typeof github_pr_url === 'string' && github_pr_url.trim()
    ? extractGitHubPrRefs(github_pr_url.trim())[0]?.url ?? github_pr_url.trim()
    : extractGitHubPrRefs(`${title}\n${resolvedDescription}`)[0]?.url ?? null;
  const resolvedSubtaskPrUrl = explicitSubtaskPrUrl ?? parent.github_pr_url ?? null;
  const resolvedLabelsJson = Array.isArray(labels) ? JSON.stringify(labels) : null;

  const shouldCreateKanban = delegate || !!parent.hermes_kanban_task_id;

  let parentTask = parent;
  if (shouldCreateKanban) {
    try {
      parentTask = ensureKanbanRootTaskForAgentControlTask(parentTask, {
        defaultAssignee: parentTask.delegation_profile ?? parentTask.assignee ?? 'orchestrator',
        prUrl: parentTask.github_pr_url,
        branch: parentTask.github_pr_head_ref,
      });
    } catch (e) {
      console.error(`[kanban-bridge] Failed to ensure parent Kanban task for ${parentTask.id}:`, e instanceof Error ? e.message : e);
    }
  }

  const createdSubtask = insertTask({
    title,
    description: resolvedDescription,
    status: 'in_progress',
    parent_task_id: req.params.id,
    agent_model: agent_model ?? undefined,
    reasoning_effort: reasoning_effort ?? undefined,
    priority: typeof priority === 'number' ? priority : undefined,
    labels_json: resolvedLabelsJson,
    assignee: assignee ?? undefined,
    delegation_status: delegate ? 'queued' : undefined,
    github_pr_url: resolvedSubtaskPrUrl,
    github_pr_number: explicitSubtaskPrUrl ? extractGitHubPrRefs(explicitSubtaskPrUrl)[0]?.number : parent.github_pr_number,
    github_pr_state: explicitSubtaskPrUrl ? undefined : parent.github_pr_state,
    github_pr_head_ref: explicitSubtaskPrUrl ? undefined : parent.github_pr_head_ref,
    github_pr_head_sha: explicitSubtaskPrUrl ? undefined : parent.github_pr_head_sha,
    github_checks_status: explicitSubtaskPrUrl ? 'unknown' : parent.github_checks_status,
    github_checks_summary: explicitSubtaskPrUrl ? 'PR linked from subtask content — sync pending' : parent.github_checks_summary,
    github_checks_updated_at: resolvedSubtaskPrUrl ? Date.now() : undefined,
  });

  let subtask = createdSubtask;
  // Embed parent context in description for delegated subtasks
  if (shouldCreateKanban && subtask) {
    const ctxSuffix = `\n\n---\n*Created from parent task: ${parent.title} (${parent.id})*`;
    const updatedSubtask = updateTask(subtask.id, { description: (subtask.description ?? '') + ctxSuffix });
    if (updatedSubtask) subtask = updatedSubtask;

    // Create a real Hermes Kanban task for the delegated subtask
    const kanbanAssignProfile = assignee || 'default';
    try {
      const kanbanBody = [
        resolvedDescription,
        '',
        '---',
        `AgentControl parent task: ${parentTask.title} (${parentTask.id})`,
        `AgentControl subtask id: ${subtask.id}`,
        explicitSubtaskPrUrl
          ? `GitHub PR: ${explicitSubtaskPrUrl}`
          : parentTask.github_pr_url ? `GitHub PR: ${parentTask.github_pr_url}` : null,
        parentTask.github_pr_head_ref ? `Shared branch: ${parentTask.github_pr_head_ref}` : null,
        'Commit final work to the shared PR/worktree associated with the parent AgentControl task.',
      ].filter(Boolean).join('\n');
      const kanbanId = createKanbanTask(title, kanbanAssignProfile, kanbanBody, {
        parentKanbanId: parentTask.hermes_kanban_task_id,
        workspace: 'worktree',
        branch: parentTask.github_pr_head_ref || undefined,
        idempotencyKey: `agentcontrol-subtask:${subtask.id}`,
      });
      // Persist the mapping in AgentControl DB
      const updatedWithKanban = updateTask(subtask.id, {
        hermes_kanban_task_id: kanbanId,
        delegation_profile: kanbanAssignProfile,
        github_pr_url: resolvedSubtaskPrUrl,
        github_pr_number: explicitSubtaskPrUrl ? extractGitHubPrRefs(explicitSubtaskPrUrl)[0]?.number : parentTask.github_pr_number,
        github_pr_state: explicitSubtaskPrUrl ? undefined : parentTask.github_pr_state,
        github_pr_head_ref: explicitSubtaskPrUrl ? undefined : parentTask.github_pr_head_ref,
        github_pr_head_sha: explicitSubtaskPrUrl ? undefined : parentTask.github_pr_head_sha,
        github_checks_status: explicitSubtaskPrUrl ? 'unknown' : parentTask.github_checks_status,
        github_checks_summary: explicitSubtaskPrUrl ? 'PR linked from subtask content — sync pending' : parentTask.github_checks_summary,
        github_checks_updated_at: resolvedSubtaskPrUrl ? Date.now() : parentTask.github_checks_updated_at,
      });
      if (updatedWithKanban) subtask = updatedWithKanban;
    } catch (e) {
      // Log but don't fail — the subtask still works without it
      console.error(`[kanban-bridge] Failed to create Kanban task for subtask ${subtask.id}:`, e instanceof Error ? e.message : e);
    }
  }

  broadcast({ type: 'task_created', task: subtask });

  let runId: string | null = null;
  if (delegate) {
    try {
      runId = startTaskChatRun(subtask, subtask.description ?? subtask.title).runId;
    } catch (error) {
      const blocked = updateTask(subtask.id, { delegation_status: 'blocked' });
      if (blocked) {
        subtask = blocked;
        broadcast({ type: 'task_updated', task: blocked });
      }
      return res.status(409).json({ error: error instanceof Error ? error.message : 'Could not start delegated subtask' });
    }
  }

  // Refresh parent broadcast with updated subtask count
  const updatedParent = getTask(req.params.id);
  if (updatedParent) broadcast({ type: 'task_updated', task: updatedParent });

  res.status(201).json({ parent: updatedParent ?? parent, subtasks: getSubtasks(req.params.id), runId });
});

tasksRouter.post('/:id/kanban/sync', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  try {
    const extraChildIds = Array.isArray(req.body?.extraChildIds)
      ? req.body.extraChildIds.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    const result = await syncKanbanChildrenForTask(task, { extraChildIds });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Sync failed' });
  }
});

tasksRouter.post('/:id/kanban/sync-from-chat', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.hermes_kanban_task_id) return res.status(400).json({ error: 'Task has no kanban mapping' });

  try {
    const messages = await adapter.getMessages(task.id, task.id);
    const extraChildIds = extractKanbanTaskIdsFromText(messages.map((message) => message.content).join('\n'))
      .filter((id) => id !== task.hermes_kanban_task_id);
    const refreshed = await refreshTaskGitHubStatus(task, {
      extraTexts: recentTaskMessageTexts(messages),
    }).catch(() => null);
    const result = await syncKanbanChildrenForTask(refreshed ?? task, {
      extraChildIds,
    });
    res.json({ ...result, referencedKanbanIds: extraChildIds });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Chat sync failed' });
  }
});

function parseLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

tasksRouter.get('/:id/kanban', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.hermes_kanban_task_id) return res.status(404).json({ error: 'Task has no kanban mapping' });

  const info = getKanbanTaskInfo(task.hermes_kanban_task_id);
  if (!info) return res.status(404).json({ error: 'Kanban task not found' });

  const synced = syncTaskStatusFromKanban(task).task;
  res.json({
    kanban_id: synced.hermes_kanban_task_id,
    delegation_profile: synced.delegation_profile,
    task: synced,
    kanban: info,
  });
});

tasksRouter.get('/:id/kanban/logs', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.hermes_kanban_task_id) return res.status(404).json({ error: 'Task has no kanban mapping' });

  const limit = parseLimit(req.query.limit, 50);
  const runs = getKanbanRuns(task.hermes_kanban_task_id, limit);
  const logs = getKanbanLogs(task.hermes_kanban_task_id, limit);
  const comments = getKanbanComments(task.hermes_kanban_task_id, limit);
  const synced = syncTaskStatusFromKanban(task).task;
  res.json({
    kanban_id: synced.hermes_kanban_task_id,
    task: synced,
    logs,
    events: logs,
    runs,
    comments,
  });
});

tasksRouter.get('/:id/kanban/transcript', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).type('text/plain').send('Task not found');
  if (!task.hermes_kanban_task_id) return res.status(404).type('text/plain').send('Task has no kanban mapping');

  const board = findBoardForKanbanTask(task.hermes_kanban_task_id);
  if (!board) return res.status(404).type('text/plain').send('Kanban task not found');

  const path = getBoardTaskTranscriptPath(board, task.hermes_kanban_task_id);
  if (!path) {
    return res
      .status(200)
      .type('text/plain')
      .send('Worker transcript not found yet. It appears after the Hermes worker starts.');
  }

  const content = readFileSync(path, 'utf-8');
  const trimmed = content.length > 200_000
    ? `...(truncated to last 200KB; full size ${content.length} bytes)\n${content.slice(content.length - 200_000)}`
    : content;

  res.type('text/plain').send(trimmed);
});

tasksRouter.post('/:id/move', async (req, res) => {
  const { status } = req.body;
  if (!TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  const current = getTask(req.params.id);
  if (!current) return res.status(404).json({ error: 'Task not found' });

  const result = status === 'done'
    ? await completeTaskWithLinkedPrMerge(req.params.id)
    : { ...updateTaskStatus(req.params.id, status), githubMerge: null };
  if (!result.task) return res.status(404).json({ error: 'Task not found' });
  if (result.githubMerge?.status === 'blocked' || result.githubMerge?.status === 'auto_merge_enabled') {
    return res.status(409).json({
      error: result.githubMerge.message,
      task: result.task,
      subtasksCompleted: result.subtasksCompleted,
      githubMerge: result.githubMerge,
    });
  }
  res.json({ task: result.task, subtasksCompleted: result.subtasksCompleted, githubMerge: result.githubMerge });
});
