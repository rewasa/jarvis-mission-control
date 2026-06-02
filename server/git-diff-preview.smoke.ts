import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { collectGitDiffSummary } from './git-diff-preview.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentcontrol-diff-preview-'));
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'agentcontrol@example.com']);
  await git(dir, ['config', 'user.name', 'AgentControl Test']);
  await writeFile(join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

async function testDocsOnlyDiffIsHidden(): Promise<void> {
  const repo = await createRepo();
  try {
    await writeFile(join(repo, 'README.md'), '# fixture\n\nOnly prose changed.\n');
    assert.equal(await collectGitDiffSummary(repo), null);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function testUntrackedSvgOnlyDiffIsHidden(): Promise<void> {
  const repo = await createRepo();
  try {
    await mkdir(join(repo, 'public'));
    await writeFile(join(repo, 'public', 'logo.svg'), '<svg viewBox="0 0 1 1" />\n');
    assert.equal(await collectGitDiffSummary(repo), null);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function testRelevantCodeDiffIsShown(): Promise<void> {
  const repo = await createRepo();
  try {
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'feature.ts'), 'export const value = 1;\n');
    const diff = await collectGitDiffSummary(repo);
    assert.ok(diff);
    assert.equal(diff.fileCount, 1);
    assert.deepEqual(diff.files, [{ status: 'A', path: 'src/feature.ts' }]);
    assert.match(diff.patch, /diff --git a\/src\/feature\.ts b\/src\/feature\.ts/);
    assert.match(diff.patch, /\+export const value = 1;/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

await testDocsOnlyDiffIsHidden();
await testUntrackedSvgOnlyDiffIsHidden();
await testRelevantCodeDiffIsShown();
console.log('git-diff-preview smoke tests passed');
