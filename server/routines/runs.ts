import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expandHomePrefix } from '../paths.js';
import type { RoutineRun, RoutineRunContent } from '../../shared/types.js';

function resolveOutputDir(): string {
  const hermesHome = process.env.HERMES_HOME?.trim();
  const base = hermesHome ? expandHomePrefix(hermesHome) : expandHomePrefix('~/.hermes');
  return join(base, 'cron', 'output');
}

function isValidSegment(value: string): boolean {
  return value.length > 0 && !value.includes('/') && !value.includes('\\') && !value.includes('..');
}

function parseTimestamp(stem: string): string | null {
  const match = stem.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

function detectStatus(head: string): RoutineRun['status'] {
  const firstLine = head.split('\n').find((l) => l.trim())?.trim() ?? '';
  if (firstLine.startsWith('# Cron Job:') && firstLine.includes('(FAILED)')) return 'error';
  if (firstLine.startsWith('# Cron Job:')) return 'ok';
  return 'unknown';
}

function extractBody(content: string): string {
  const lines = content.split('\n');
  for (const marker of ['## Response', '## Error']) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === marker) return lines.slice(i + 1).join('\n').trim();
    }
  }
  return content.trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function buildPreview(head: string): string {
  const body = extractBody(head);
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4);
  return truncate(lines.join('\n'), 240);
}

export async function listRoutineRuns(jobId: string, limit = 20): Promise<RoutineRun[]> {
  if (!isValidSegment(jobId)) return [];
  const dir = join(resolveOutputDir(), jobId);
  const safeLimit = Math.max(1, Math.min(limit, 100));

  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
  } catch {
    return [];
  }

  const timed = await Promise.all(
    names.map(async (name) => {
      try {
        const st = await stat(join(dir, name));
        return { mtime: st.mtimeMs, name };
      } catch {
        return null;
      }
    }),
  );
  const valid = timed.filter((e): e is { mtime: number; name: string } => e !== null);
  valid.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));

  return Promise.all(
    valid.slice(0, safeLimit).map(async (entry) => {
      const stem = entry.name.replace(/\.md$/, '');
      const path = join(dir, entry.name);
      let head = '';
      try {
        const buf = await readFile(path, 'utf8');
        head = buf.slice(0, 8192);
      } catch { /* unreadable file */ }
      return { id: stem, jobId, ranAt: parseTimestamp(stem), path, status: detectStatus(head), preview: buildPreview(head) };
    }),
  );
}

export async function getRoutineRunContent(jobId: string, runId: string): Promise<RoutineRunContent | null> {
  if (!isValidSegment(jobId) || !isValidSegment(runId)) return null;
  const path = join(resolveOutputDir(), jobId, `${runId}.md`);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  return { body: extractBody(content), status: detectStatus(content) };
}
