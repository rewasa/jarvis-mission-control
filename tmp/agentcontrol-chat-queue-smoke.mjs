import { chromium } from 'playwright';

const taskId = process.env.TASK_ID || '134c575b-134d-425d-a8d1-0235377e09ad';
const url = `http://127.0.0.1:7460/tasks/${taskId}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(error.message));
await page.route('**/api/tasks/*/messages', async (route, request) => {
  if (request.method() !== 'POST') return route.continue();
  await new Promise((resolve) => setTimeout(resolve, 5000));
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  });
});
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
const textbox = page.locator('textarea').first();
await textbox.waitFor({ timeout: 15000 });
const steerButton = page.getByRole('button', { name: 'Add /steer command' });
await steerButton.click();
const steerValue = await textbox.inputValue();
if (steerValue !== '/steer ') {
  throw new Error(`Expected steer button to prefix textbox, got ${JSON.stringify(steerValue)}`);
}
await textbox.fill('first queued smoke');
await textbox.press('Enter');
await textbox.fill('second queued smoke');
await textbox.press('Enter');
await page.waitForSelector('text=Queue ×2', { timeout: 10000 });
const queuedText = await page.locator('text=Queue ×2').count();
const firstQueued = await page.locator('text=first queued smoke').count();
const secondQueued = await page.locator('text=second queued smoke').count();
const bodyText = await page.locator('body').innerText();
await page.screenshot({ path: '/tmp/agentcontrol-chat-queue-smoke.png', fullPage: false });
await browser.close();
if (consoleErrors.length) {
  console.error(consoleErrors.join('\n'));
  process.exit(1);
}
if (!queuedText || !firstQueued || !secondQueued || bodyText.includes('Commands:')) {
  console.error(JSON.stringify({ queuedText, firstQueued, secondQueued, hasCommandsCopy: bodyText.includes('Commands:') }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ queuedText, firstQueued, secondQueued, hasCommandsCopy: bodyText.includes('Commands:') }, null, 2));
