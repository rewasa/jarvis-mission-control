import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
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

kanbanBoardsRouter.get('/boards/:board/tasks/:taskId/transcript', (req, res) => {
  try {
    const { board, taskId } = req.params;
    const path = getBoardTaskTranscriptPath(board, taskId);
    if (!path) return res.status(404).json({ error: 'Transcript not found' });
    const content = readFileSync(path, 'utf-8');
    // Return last 20KB to keep responses small
    const trimmed = content.length > 20_000
      ? '...(truncated)\n' + content.slice(content.length - 20_000)
      : content;
    res.json({ board, taskId, transcript: trimmed, fullSize: content.length });
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
