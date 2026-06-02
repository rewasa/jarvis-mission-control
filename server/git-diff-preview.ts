import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { resolveAgentControlWorkspaceDir } from './paths.js';
import type { CodeDiffSummary } from '../shared/types.js';

const execFileAsync = promisify(execFile);

const MAX_DIFF_BYTES = 16_000;
const MAX_STAT_BYTES = 4_000;
const MAX_FILES = 12;
const MAX_UNTRACKED_FILE_BYTES = 12_000;

const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.cts', '.cxx', '.go', '.h', '.hpp',
  '.html', '.java', '.js', '.jsx', '.kt', '.mjs', '.mts', '.php', '.py',
  '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte', '.swift', '.tsx', '.ts',
  '.vue',
]);

const CODE_CONFIG_FILES = new Set([
  'Dockerfile', 'Makefile', 'eslint.config.js', 'eslint.config.mjs',
  'package.json', 'pnpm-workspace.yaml', 'postcss.config.js',
  'tailwind.config.js', 'tailwind.config.ts', 'tsconfig.json', 'turbo.json',
  'vite.config.js', 'vite.config.ts',
]);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 512 * 1024,
    timeout: 5_000,
  });
  return stdout.toString();
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) return { value, truncated: false };

  const clipped = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
  return {
    value: `${clipped.replace(/\s+$/, '')}\n… diff preview truncated (${Math.round(bytes / 1024)} KB total)`,
    truncated: true,
  };
}

function relevantCodePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  if (CODE_CONFIG_FILES.has(basename)) return true;
  const extension = basename.includes('.') ? `.${basename.split('.').pop()}` : '';
  return CODE_EXTENSIONS.has(extension);
}

function nameStatusPath(line: string): { status: string; path: string } | null {
  const parts = line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/);
  const status = parts[0] || 'M';
  const path = parts[parts.length - 1];
  return path ? { status, path } : null;
}

function parseChangedFiles(nameStatus: string): CodeDiffSummary['files'] {
  return nameStatus
    .split('\n')
    .map((line) => nameStatusPath(line.trim()))
    .filter((file): file is { status: string; path: string } => Boolean(file))
    .filter((file) => relevantCodePath(file.path));
}

function parseUntrackedFiles(output: string): CodeDiffSummary['files'] {
  return output
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean)
    .filter(relevantCodePath)
    .map((path) => ({ status: 'A', path }));
}

async function untrackedPatch(path: string, cwd: string): Promise<string> {
  try {
    const content = await readFile(join(cwd, path), 'utf8');
    const clipped = trimOutput(content, MAX_UNTRACKED_FILE_BYTES);
    const lines = clipped.value.split('\n');
    return [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n');
  } catch {
    return '';
  }
}

async function isGitWorkTree(cwd: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

async function resolveDiffCwd(preferredCwd?: string): Promise<string | null> {
  const candidates = [preferredCwd, resolveAgentControlWorkspaceDir(), process.cwd()]
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await isGitWorkTree(candidate)) return candidate;
  }
  return null;
}

export async function collectGitDiffSummary(cwd?: string): Promise<CodeDiffSummary | null> {
  const diffCwd = await resolveDiffCwd(cwd);
  if (!diffCwd) return null;

  const [diffNameStatus, untrackedRaw] = await Promise.all([
    git(['diff', '--name-status', 'HEAD'], diffCwd),
    git(['ls-files', '--others', '--exclude-standard'], diffCwd),
  ]);

  const trackedChangedFiles = parseChangedFiles(diffNameStatus);
  const untrackedChangedFiles = parseUntrackedFiles(untrackedRaw);
  const changedFiles = [...trackedChangedFiles, ...untrackedChangedFiles];
  if (changedFiles.length === 0) return null;

  const trackedPaths = trackedChangedFiles.map((file) => file.path);
  const untrackedPaths = untrackedChangedFiles.map((file) => file.path);
  const [statRaw, trackedDiffRaw, ...untrackedDiffs] = await Promise.all([
    trackedPaths.length > 0
      ? git(['diff', '--stat', 'HEAD', '--', ...trackedPaths], diffCwd)
      : Promise.resolve(''),
    trackedPaths.length > 0
      ? git(['diff', '--no-ext-diff', '--minimal', 'HEAD', '--', ...trackedPaths], diffCwd)
      : Promise.resolve(''),
    ...untrackedPaths.map((path) => untrackedPatch(path, diffCwd)),
  ]);

  const combinedDiff = [trackedDiffRaw, ...untrackedDiffs].filter(Boolean).join('\n');
  if (!combinedDiff.trim()) return null;

  const stat = trimOutput(statRaw.trim(), MAX_STAT_BYTES);
  const diff = trimOutput(combinedDiff.trim(), MAX_DIFF_BYTES);

  return {
    files: changedFiles.slice(0, MAX_FILES),
    fileCount: changedFiles.length,
    stat: stat.value,
    patch: diff.value,
    truncated: changedFiles.length > MAX_FILES || stat.truncated || diff.truncated,
    capturedAt: Date.now(),
  };
}
