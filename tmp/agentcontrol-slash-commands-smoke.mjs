import { chromium } from 'playwright';

const taskId = process.env.TASK_ID ?? 'dd0345ce-ef5e-4656-b64e-9f873f4f6469';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
try {
  await page.goto(`http://localhost:7460/tasks/${taskId}`, { waitUntil: 'domcontentloaded' });
  const chatInput = page.locator('textarea[placeholder*="Message"], textarea[placeholder*="goal"]').last();
  await chatInput.fill('/');
  await page.getByText('Hermes commands').waitFor({ timeout: 5000 });
  const steerVisible = await page.getByText('/steer').first().isVisible();
  const queueVisible = await page.getByText('/queue').first().isVisible();
  const modelVisible = await page.getByText('/model').first().isVisible();
  const descriptionVisible = await page.getByText('Inject guidance into a running AgentControl').first().isVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  const inserted = await chatInput.inputValue();
  await chatInput.fill('/mo');
  await page.getByText('/model').first().waitFor({ timeout: 5000 });
  const filtered = await page.getByText('/model').first().isVisible();
  console.log(JSON.stringify({
    steerVisible,
    queueVisible,
    modelVisible,
    descriptionVisible,
    inserted,
    filtered,
  }, null, 2));
} finally {
  await browser.close();
}
