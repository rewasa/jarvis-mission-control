import { chromium } from 'playwright';

const taskId = process.env.TASK_ID || '134c575b-134d-425d-a8d1-0235377e09ad';
const url = `http://127.0.0.1:7460/tasks/${taskId}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(error.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForSelector('text=GitHub PR', { timeout: 15000 });
const layout = await page.evaluate(() => {
  const textEl = (label) => Array.from(document.querySelectorAll('div,span,p,section,aside')).find((el) => el.textContent?.trim() === label);
  const leftPane = document.querySelector('section')?.getBoundingClientRect();
  const github = textEl('GitHub PR')?.getBoundingClientRect();
  const bodyText = document.body.innerText;
  const hasHeaderCopy = bodyText.includes('Conversation and steering stay on the left.')
    || bodyText.includes('Real Hermes status, logs, PR and delegated subtasks in one rail.');
  const hasGitHub = bodyText.includes('GitHub PR');
  const hasKanbanEvidence = bodyText.includes('Kanban live')
    || bodyText.includes('Hermes Kanban task')
    || bodyText.includes('No Kanban metadata yet.');
  const hasSteerButton = Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === '/steer');
  return {
    leftPaneX: leftPane?.x ?? null,
    githubX: github?.x ?? null,
    split: leftPane && github ? leftPane.x < github.x : false,
    hasHeaderCopy,
    hasGitHub,
    hasKanbanEvidence,
    hasSteerButton,
  };
});
await page.screenshot({ path: '/tmp/agentcontrol-split-smoke.png', fullPage: false });
await browser.close();
if (consoleErrors.length) {
  console.error(consoleErrors.join('\n'));
  process.exit(1);
}
if (!layout.split || layout.hasHeaderCopy || !layout.hasGitHub || !layout.hasKanbanEvidence || !layout.hasSteerButton) {
  console.error(JSON.stringify(layout, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(layout, null, 2));
