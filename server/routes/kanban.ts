import { Router, type Response } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  listKanbanBoards,
  getBoardTasks,
  getBoardTaskInfo,
  getBoardKanbanLogs,
  getBoardKanbanRuns,
  getBoardKanbanComments,
  getBoardKanbanChildren,
  getBoardTaskTranscriptPath,
  getBoardTaskBlockers,
  addKanbanComment,
  broadcastKanbanChanged,
} from '../services/kanban-bridge.js';

export const kanbanBoardsRouter = Router();

kanbanBoardsRouter.get('/boards', (_req, res) => {
  try {
    const boards = listKanbanBoards();
    res.json({ boards });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list boards', details: String(error) });
  }
});

kanbanBoardsRouter.get('/boards/:board/tasks', (req, res) => {
  try {
    const { board } = req.params;
    const tasks = getBoardTasks(board);
    res.json({ board, tasks });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tasks', details: String(error) });
  }
});

kanbanBoardsRouter.get('/boards/:board/tasks/:taskId', (req, res) => {
  try {
    const { board, taskId } = req.params;
    const task = getBoardTaskInfo(board, taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ board, task });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch task', details: String(error) });
  }
});

kanbanBoardsRouter.get('/boards/:board/tasks/:taskId/children', (req, res) => {
  try {
    const { board, taskId } = req.params;
    const children = getBoardKanbanChildren(board, taskId);
    res.json({ board, taskId, children });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch children', details: String(error) });
  }
});

kanbanBoardsRouter.get('/boards/:board/tasks/:taskId/logs', (req, res) => {
  try {
    const { board, taskId } = req.params;
    const limit = Number(req.query.limit) || 50;
    const logs = getBoardKanbanLogs(board, taskId, limit);
    const runs = getBoardKanbanRuns(board, taskId);
    const comments = getBoardKanbanComments(board, taskId);
    res.json({ board, taskId, logs, runs, comments });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch logs', details: String(error) });
  }
});

function serveTranscript(board: string, taskId: string, raw: boolean, res: Response) {
  const path = getBoardTaskTranscriptPath(board, taskId);
  if (!path) {
    if (raw) return res.status(404).type('text/plain').send('Transcript not found');
    return res.status(404).json({ error: 'Transcript not found' });
  }
  const content = readFileSync(path, 'utf-8');
  if (raw) {
    res.type('text/plain');
    return content.length > 200_000
      ? res.send('...(truncated)\n' + content.slice(content.length - 200_000))
      : res.send(content);
  }
  const trimmed = content.length > 20_000
    ? '...(truncated)\n' + content.slice(content.length - 20_000)
    : content;
  res.json({ board, taskId, transcript: trimmed, fullSize: content.length });
}

kanbanBoardsRouter.get('/boards/:board/tasks/:taskId/transcript', (req, res) => {
  try {
    const { board, taskId } = req.params;
    serveTranscript(board, taskId, req.query.format === 'raw', res);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read transcript', details: String(error) });
  }
});

kanbanBoardsRouter.get('/boards/:board/tasks/:taskId/blockers', (req, res) => {
  try {
    const { board, taskId } = req.params;
    const blockers = getBoardTaskBlockers(board, taskId);
    res.json({ board, taskId, blockers });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch blockers', details: String(error) });
  }
});

kanbanBoardsRouter.post('/boards/:board/tasks/:taskId/comment', (req, res) => {
  try {
    const { board, taskId } = req.params;
    const { body } = req.body;
    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      return res.status(400).json({ error: 'Comment body is required' });
    }
    const trimmed = body.trim().slice(0, 2000);
    // Sanitize taskId (must be t_<hex>)
    if (!/^t_[a-f0-9]{8}$/.test(taskId)) {
      return res.status(400).json({ error: 'Invalid task ID format' });
    }
    const author = process.env.USER || process.env.USERNAME || 'unknown';
    const result = addKanbanComment(board, taskId, author, trimmed);
    if (!result) {
      return res.status(500).json({ error: 'Comment failed', details: 'Board not found or DB write error' });
    }
    const comments = getBoardKanbanComments(board, taskId);
    res.json({ board, taskId, comments, ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add comment', details: String(error) });
  }
});

kanbanBoardsRouter.delete('/boards/:board', (req, res) => {
  try {
    const { board } = req.params;
    if (board === 'default') {
      return res.status(400).json({ error: 'Cannot delete the default board' });
    }
    // Validate board name to prevent injection
    if (!/^[a-zA-Z0-9_-]+$/.test(board)) {
      return res.status(400).json({ error: 'Invalid board name' });
    }
    execFileSync('hermes', ['kanban', 'boards', 'rm', '--delete', board], { stdio: 'pipe', timeout: 15_000 });
    const boards = listKanbanBoards();
    res.json({ boards, ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete board', details: String(error) });
  }
});

kanbanBoardsRouter.post('/boards/:board/tasks/:taskId/claim', (req, res) => {
  try {
    const { board, taskId } = req.params;
    // Validate board name to prevent injection
    if (!/^[a-zA-Z0-9_-]+$/.test(board)) {
      return res.status(400).json({ error: 'Invalid board name' });
    }
    if (!/^t_[a-f0-9]{8}$/.test(taskId)) {
      return res.status(400).json({ error: 'Invalid task ID format' });
    }
    const boards = listKanbanBoards();
    const task = getBoardTaskInfo(board, taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status === 'running') {
      // Already claimed — just refresh
      const tasks = getBoardTasks(board);
      return res.json({ board, taskId, task, tasks, ok: true, alreadyClaimed: true });
    }
    execFileSync('hermes', ['kanban', '--board', board, 'claim', taskId], { stdio: 'pipe', timeout: 15_000 });
    const updated = getBoardTaskInfo(board, taskId);
    const tasks = getBoardTasks(board);
    // Broadcast so all tabs see the status change instantly
    if (updated) {
      broadcastKanbanChanged(board, taskId, updated.status, updated.title);
    }
    res.json({ board, taskId, task: updated, tasks, ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to claim task', details: String(error) });
  }
});
