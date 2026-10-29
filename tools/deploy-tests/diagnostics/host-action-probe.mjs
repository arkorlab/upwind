import { readFile } from 'node:fs/promises';

// Diagnostic only: reads the dedicated test project's kept deployments and exercises its fixture.
// Never log a credential, project/deployment identifier, hostname, or API response body.
const token = (await readFile(process.env.ARKOR_API_TOKEN_FILE, 'utf8')).trim();
const base = process.env.ARKOR_API_URL.replace(/\/$/, '');
const project = process.env.ADAPTER_TEST_PROJECT_ID;
const response = await fetch(base + '/v1/projects/' + encodeURIComponent(project) + '/deployments', {
  headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error('Could not read test deployment list: HTTP ' + response.status);
const listed = await response.json();
let target;
for (const deployment of listed.deployments.slice(0, 12)) {
  if (!deployment.url || deployment.status === 'retired') continue;
  const url = new URL(deployment.url);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.arkor.app')) continue;
  try {
    const check = await fetch(new URL('/revalidate', url), { signal: AbortSignal.timeout(15000) });
    const html = await check.text();
    if (check.status === 200 && html.includes('id="justputit"') && html.includes('redirect-revalidate-client')) {
      target = url.origin; break;
    }
  } catch { /* Another kept fixture may no longer be served. */ }
}
if (!target) throw new Error('No kept action test deployment was available');
console.log('Found the kept action fixture; identifiers remain private');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ headless: true });
const observations = [];
async function probe(label) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const record = { label, network: [], snapshots: [] };
  observations.push(record);
  let start = null;
  const pending = new Set();
  page.on('response', (res) => {
    if (start === null || !res.url().startsWith(target)) return;
    const request = res.request();
    if (request.resourceType() !== 'fetch' && request.method() !== 'POST') return;
    const task = (async () => {
      const item = { method: request.method(), path: new URL(res.url()).pathname, status: res.status(), headersMs: performance.now() - start,
        revalidated: await res.headerValue('x-action-revalidated'), cache: await res.headerValue('x-nextjs-cache') };
      record.network.push(item);
      try { const text = await res.text(); item.bytes = text.length; item.completeMs = performance.now() - start; } catch { item.closedBeforeEnd = true; }
    })();
    pending.add(task); task.finally(() => pending.delete(task));
  });
  const snapshot = async (label) => {
    const url = new URL(page.url());
    const value = await page.locator('#justputit').textContent();
    record.snapshots.push({ label, ms: performance.now() - start, path: url.pathname + url.search, value });
  };
  try {
    await page.goto(target + '/revalidate', { waitUntil: 'networkidle' });
    record.initial = await page.locator('#justputit').textContent();
    start = performance.now();
    await page.locator('#redirect-revalidate-client').click();
    for (const ms of [500,1500,2500,3500,5500,10000]) {
      await page.waitForTimeout(Math.max(0, ms - (performance.now() - start)));
      await snapshot(String(ms));
    }
    await page.reload({ waitUntil: 'networkidle' });
    await snapshot('reload');
    record.changedAt2500 = record.snapshots.find(s => s.label === '2500')?.value !== record.initial;
    record.changedAt10000 = record.snapshots.find(s => s.label === '10000')?.value !== record.initial;
  } catch {
    // Playwright error text can include the private hostname, so keep a bounded generic outcome.
    record.error = 'A browser operation failed or timed out';
  } finally {
    await context.close();
    await Promise.allSettled([...pending]);
    console.log('ACTION_PROBE ' + JSON.stringify(record));
  }
}
try {
  await probe('serial-1');
  await probe('serial-2');
  await Promise.all(Array.from({ length: 4 }, (_, i) => probe('parallel-' + i)));
} finally {
  await browser.close();
}
if (observations.some(o => o.error)) process.exitCode = 1;
