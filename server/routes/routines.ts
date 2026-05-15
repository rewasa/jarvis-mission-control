import { Router, type Response } from 'express';
import { errorCode, isRecord, toErrorMessage } from '../errors.js';
import type { Routine, RoutineInput } from '../../shared/types.js';
import type { HermesWorkerAdapter } from '../adapters/hermes-worker.js';
import { listRoutineRuns, getRoutineRunContent } from '../routines/runs.js';

const ROUTINE_INPUT_FIELDS = [
  'name',
  'prompt',
  'schedule',
  'deliver',
  'skills',
  'model',
  'provider',
  'baseUrl',
  'workdir',
  'repeat',
  'contextFrom',
] as const;

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function routineInputFromBody(body: unknown): Partial<RoutineInput> {
  if (!isRecord(body)) return {};

  const input: Partial<RoutineInput> = {};
  for (const field of ROUTINE_INPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      Object.assign(input, { [field]: body[field] });
    }
  }
  return input;
}

function workerStatus(error: unknown): number {
  const code = errorCode(error);
  if (code === 'bad_request') return 400;
  if (code === 'not_found') return 404;
  return 503;
}

function workerErrorFallback(error: unknown): string {
  return workerStatus(error) === 400 ? 'Invalid routine' : 'Hermes routines worker unavailable';
}

export function createRoutinesRouter(adapter: HermesWorkerAdapter): Router {
  const router = Router();

  router.get('/jobs', async (req, res) => {
    try {
      const includeDisabled = req.query.includeDisabled === 'true';
      const jobs = await adapter.listRoutines(includeDisabled);
      res.json({ jobs });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes routines worker unavailable') });
    }
  });

  router.get('/jobs/:jobId', async (req, res) => {
    try {
      const job = await adapter.getRoutine(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Routine not found' });
      res.json({ job });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes routines worker unavailable') });
    }
  });

  router.post('/jobs', async (req, res) => {
    const input = routineInputFromBody(req.body);
    if (!hasText(input.prompt)) return res.status(400).json({ error: 'prompt is required' });
    if (!hasText(input.schedule)) return res.status(400).json({ error: 'schedule is required' });

    try {
      const job = await adapter.createRoutine(input as RoutineInput);
      res.json({ job });
    } catch (error) {
      const status = workerStatus(error);
      res.status(status).json({ error: toErrorMessage(error, workerErrorFallback(error)) });
    }
  });

  router.patch('/jobs/:jobId', async (req, res) => {
    const updates = routineInputFromBody(req.body);
    if ('prompt' in updates && !hasText(updates.prompt)) {
      return res.status(400).json({ error: 'prompt cannot be empty' });
    }
    if ('schedule' in updates && !hasText(updates.schedule)) {
      return res.status(400).json({ error: 'schedule cannot be empty' });
    }

    try {
      const job = await adapter.updateRoutine(req.params.jobId, updates);
      if (!job) return res.status(404).json({ error: 'Routine not found' });
      res.json({ job });
    } catch (error) {
      const status = workerStatus(error);
      res.status(status).json({ error: toErrorMessage(error, workerErrorFallback(error)) });
    }
  });

  router.get('/jobs/:jobId/runs', async (req, res) => {
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const limit = rawLimit ? Number.parseInt(String(rawLimit), 10) : 20;
    const runs = await listRoutineRuns(req.params.jobId, Number.isFinite(limit) ? limit : 20);
    res.json({ runs });
  });

  router.get('/jobs/:jobId/runs/:runId/content', async (req, res) => {
    const content = await getRoutineRunContent(req.params.jobId, req.params.runId);
    if (!content) return res.status(404).json({ error: 'Routine run output not found' });
    res.json({ content });
  });

  async function jobActionHandler(
    res: Response,
    jobId: string,
    action: (jobId: string) => Promise<Routine | null>,
  ) {
    try {
      const job = await action(jobId);
      if (!job) return res.status(404).json({ error: 'Routine not found' });
      res.json({ job });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes routines worker unavailable') });
    }
  }

  router.post('/jobs/:jobId/pause', (req, res) => {
    const rawReason = req.body?.reason;
    const reason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : undefined;
    jobActionHandler(res, req.params.jobId, (jobId) => adapter.pauseRoutine(jobId, reason));
  });

  router.post('/jobs/:jobId/resume', (req, res) => {
    jobActionHandler(res, req.params.jobId, (jobId) => adapter.resumeRoutine(jobId));
  });

  router.post('/jobs/:jobId/run', (req, res) => {
    jobActionHandler(res, req.params.jobId, (jobId) => adapter.runRoutine(jobId));
  });

  router.delete('/jobs/:jobId', async (req, res) => {
    try {
      const removed = await adapter.removeRoutine(req.params.jobId);
      if (!removed) return res.status(404).json({ error: 'Routine not found' });
      res.json({ ok: true });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes routines worker unavailable') });
    }
  });

  return router;
}
