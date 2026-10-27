// End-to-end check of the editor with real pointer input in headless Edge/Chrome.
// Usage: npm run dev (port 5183), then `node e2e/interactions.mjs`. Screenshots land in e2e/shots/.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const URL = process.env.FAULTLINE_URL ?? 'http://localhost:5183/';
const SHOTS = path.join(import.meta.dirname, 'shots');
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
];
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({ executablePath: BROWSERS.find((b) => fs.existsSync(b)), headless: true });

async function freshPage(viewport, colorScheme = 'light') {
  const page = await browser.newPage({ viewport, colorScheme });
  page.on('pageerror', (e) => check('no page errors', false, e.message));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.react-flow__node');
  return page;
}

const nodeSel = (id) => `.react-flow__node[data-id="${id}"]`;
async function center(page, sel) {
  const b = await page.locator(sel).boundingBox();
  if (!b) throw new Error(`not visible: ${sel}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}
const moveNode = async (page, id, to) => drag(page, await center(page, `${nodeSel(id)} .cnode-title`), to);
const connect = async (page, a, b) => drag(page, await center(page, `${nodeSel(a)} .react-flow__handle.source`), await center(page, `${nodeSel(b)} .react-flow__handle.target`));
const edgeClass = (page, id) => page.locator(`.react-flow__edge[data-id="${id}"]`).getAttribute('class');
const nodeIds = (page) => page.$$eval('.react-flow__node', (ns) => ns.map((n) => n.dataset.id));

async function allNodesInView(page) {
  const canvas = await page.locator('.canvas').boundingBox();
  const boxes = await page.$$eval('.react-flow__node', (ns) => ns.map((n) => n.getBoundingClientRect().toJSON()));
  return boxes.every((b) => b.left >= canvas.x - 1 && b.right <= canvas.x + canvas.width + 1 && b.top >= canvas.y - 1 && b.bottom <= canvas.y + canvas.height + 1);
}

// ---------- Desktop: build a design by hand ----------
const page = await freshPage({ width: 1440, height: 900 });
check('practice starts with Users in view', (await nodeIds(page)).join() === 'users' && (await allNodesInView(page)));

// 1. HTML5 drag from the palette.
const canvasBox = await page.locator('.canvas').boundingBox();
await page.locator('.palette-item', { hasText: 'Load Balancer' }).dragTo(page.locator('.canvas'), {
  targetPosition: { x: canvasBox.width * 0.45, y: canvasBox.height * 0.4 },
});
check('drag from palette adds a node', (await nodeIds(page)).includes('loadbalancer-1'));

// 2. Click-to-add.
for (const label of ['Service', 'Queue', 'Worker']) await page.locator('.palette-item', { hasText: new RegExp(`^\\S+${label}$`) }).click();
const added = await nodeIds(page);
check('clicked nodes land in view without overlapping', await allNodesInView(page) && await page.$$eval('.react-flow__node', (ns) => { const r = ns.map((n) => n.getBoundingClientRect()); return r.every((a, i) => r.every((b, j) => i === j || a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)); }));
check('click in palette adds nodes', ['service-2', 'queue-3', 'worker-4'].every((id) => added.includes(id)), added.join());

// Lay them out so handles don't overlap.
const x0 = canvasBox.x, y0 = canvasBox.y;
await moveNode(page, 'users', { x: x0 + 140, y: y0 + 220 });
await moveNode(page, 'loadbalancer-1', { x: x0 + 380, y: y0 + 220 });
await moveNode(page, 'service-2', { x: x0 + 620, y: y0 + 220 });
await moveNode(page, 'queue-3', { x: x0 + 620, y: y0 + 420 });
await moveNode(page, 'worker-4', { x: x0 + 620, y: y0 + 600 });
await page.screenshot({ path: path.join(SHOTS, '0-layout.png') });
const svc = await center(page, nodeSel('service-2'));
check('dragging a node moves it', Math.abs(svc.y - (y0 + 220)) < 40, `service centre y=${Math.round(svc.y)}`);

// 3. Sync edges.
await connect(page, 'users', 'loadbalancer-1');
await connect(page, 'loadbalancer-1', 'service-2');
check('sync edge Users → LB', /edge-sync/.test((await edgeClass(page, 'users->loadbalancer-1')) ?? ''));
check('sync edge LB → Service', /edge-sync/.test((await edgeClass(page, 'loadbalancer-1->service-2')) ?? ''));

// 4. Async edges via the toolbar mode.
await page.getByRole('button', { name: 'Async edge', exact: true }).click();
await connect(page, 'service-2', 'queue-3');
await connect(page, 'queue-3', 'worker-4');
await page.getByRole('button', { name: 'Sync edge', exact: true }).click();
check('async edge Service → Queue', /edge-async/.test((await edgeClass(page, 'service-2->queue-3')) ?? ''));
check('async edge Queue → Worker', /edge-async/.test((await edgeClass(page, 'queue-3->worker-4')) ?? ''));
await connect(page, 'users', 'loadbalancer-1');
check('duplicate edge is ignored', (await page.locator('.react-flow__edge').count()) === 4);
await page.screenshot({ path: path.join(SHOTS, '1-built.png') });

// 5. Inspector edits on a node.
await page.locator(`${nodeSel('service-2')} .cnode-title`).click();
check('clicking a node opens the inspector', (await page.locator('.inspector h3').textContent()) === 'Service');
await page.locator('.inspector label', { hasText: 'Replicas' }).locator('input').fill('3');
await page.locator('.inspector label', { hasText: 'Name' }).locator('input').fill('Shortener API');
await page.locator('.inspector label', { hasText: 'Authentication' }).locator('input').check();
check('replicas edit shows on the node', /×3/.test(await page.locator(`${nodeSel('service-2')} .cnode-meta`).textContent()));
check('name edit shows on the node', (await page.locator(`${nodeSel('service-2')} .cnode-title`).textContent()) === 'Shortener API');
await page.locator(`${nodeSel('users')} .cnode-title`).click();
await page.locator('.inspector label', { hasText: 'Concurrent users' }).locator('input').fill('2500');
check('users edit shows on the node', /2,500 users/.test(await page.locator(`${nodeSel('users')} .cnode-meta`).textContent()));
await page.locator(`${nodeSel('service-2')} .cnode-title`).click();
check('toggle survives reselecting', await page.locator('.inspector label', { hasText: 'Authentication' }).locator('input').isChecked());

// 6. Inspector on an edge: flip type both ways.
const lbOut = await center(page, `${nodeSel('loadbalancer-1')} .react-flow__handle.source`);
const svcIn = await center(page, `${nodeSel('service-2')} .react-flow__handle.target`);
await page.mouse.click((lbOut.x + svcIn.x) / 2, (lbOut.y + svcIn.y) / 2);
check('clicking an edge opens the connection inspector', (await page.locator('.inspector h3').textContent()) === 'Connection');
await page.locator('.inspector').getByRole('button', { name: 'Async', exact: true }).click();
check('edge switched to async in inspector', /edge-async/.test(await edgeClass(page, 'loadbalancer-1->service-2')));
await page.locator('.inspector').getByRole('button', { name: 'Sync', exact: true }).click();
check('edge switched back to sync', /edge-sync/.test(await edgeClass(page, 'loadbalancer-1->service-2')));

// 7. Simulate the hand-built design.
await page.getByRole('button', { name: 'Simulate' }).click();
const stats = await page.locator('.stats').innerText();
check('simulation runs on the hand-built design', /2,500 rps/.test(stats), stats.replace(/\n/g, ' '));
check('worker gets async traffic', /rps/.test((await page.locator(`${nodeSel('worker-4')} .cnode-metrics`).textContent()) ?? ''));
await page.screenshot({ path: path.join(SHOTS, '2-simulated.png') });

// 8. Deleting: node with the keyboard (takes its edges), edge with the inspector button.
await page.locator(`${nodeSel('worker-4')} .cnode-title`).click();
await page.keyboard.press('Delete');
check('Delete key removes the node', !(await nodeIds(page)).includes('worker-4'));
check('and its edges', (await page.locator('.react-flow__edge[data-id="queue-3->worker-4"]').count()) === 0);
check('editing clears stale results', (await page.locator('.cnode-metrics').count()) === 0);
await page.mouse.click((lbOut.x + svcIn.x) / 2, (lbOut.y + svcIn.y) / 2);
await page.getByRole('button', { name: 'Delete connection' }).click();
check('Delete connection button removes the edge', (await page.locator('.react-flow__edge[data-id="loadbalancer-1->service-2"]').count()) === 0);
await page.locator(`${nodeSel('queue-3')} .cnode-title`).click();
await page.getByRole('button', { name: 'Delete component' }).click();
check('Delete component button removes the node', !(await nodeIds(page)).includes('queue-3'));
check('inspector resets after delete', await page.locator('.inspector.empty').isVisible());

// 9. Switching problem/mode frames the new design.
await page.locator('select[aria-label="Problem"]').selectOption('api-gateway');
await page.getByRole('banner').getByRole('button', { name: 'Learn', exact: true }).click();
await page.waitForTimeout(700);
check('learn design is framed after switching', await allNodesInView(page));
await page.getByRole('banner').getByRole('button', { name: 'Stress test' }).click();
await page.screenshot({ path: path.join(SHOTS, '3-learn-stress.png') });

// 10. Library tab lists every problem and opens one in Learn mode.
await page.getByRole('navigation').getByRole('button', { name: 'Library' }).click();
const listed = await page.locator('.library li').count();
const total = await page.evaluate(() => document.querySelectorAll('select[aria-label="Problem"] option').length);
check('library lists every problem in the picker', listed === total, `${listed} listed, ${total} in picker`);
const row = page.locator('.library li', { hasText: 'Pastebin' });
await row.getByRole('button', { name: 'Learn' }).click();
await page.waitForTimeout(600);
check('library opens a design in learn mode', (await nodeIds(page)).includes('bodies') && (await allNodesInView(page)));
// 11. Traffic weights: labels on fan-outs, editable share in the inspector, used by the simulation.
await page.locator('select[aria-label="Problem"]').selectOption('twitter');
await page.getByRole('banner').getByRole('button', { name: 'Learn', exact: true }).click();
await page.waitForTimeout(700);
const labelText = async (id) => (await page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-text`).textContent()) ?? '';
check('fan-out edges show their share', (await labelText('api->timelines')) === '80%' && (await labelText('api->fanout')) === '5%');
check('single edges show no share', (await page.locator('.react-flow__edge[data-id="users->cdn"] .react-flow__edge-text').count()) === 0);
await page.getByRole('banner').getByRole('button', { name: 'Simulate', exact: true }).click();
const rpsOf = async (id) => Number(((await page.locator(`${nodeSel(id)} .cnode-metrics span`).first().textContent()) ?? '').replace(/[^0-9]/g, ''));
const before = await rpsOf('search');
await page.locator('.react-flow__edge[data-id="api->timelines"] .react-flow__edge-text').click({ force: true });
check('clicking a weighted edge opens its share', (await page.locator('.share-row input[type=number]').inputValue()) === '80');
await page.locator('.share-row input[type=number]').fill('50');
check('editing share relabels the edge', (await labelText('api->timelines')) === '50%');
check('siblings keep their proportions', (await labelText('api->search')) === '38%' && (await labelText('api->fanout')) === '13%', `${await labelText('api->search')} / ${await labelText('api->fanout')}`);
await page.getByRole('banner').getByRole('button', { name: 'Simulate', exact: true }).click();
// search's only parent is api, so its load follows the api→search share exactly: 15% → 37.5%.
const after = await rpsOf('search');
check('simulation uses the new share', after > 0 && Math.abs(after / before - 37.5 / 15) < 0.02, `${before} → ${after} rps`);
await page.screenshot({ path: path.join(SHOTS, '8-weights.png') });

// 12. Fan-out mode: a call-all node labels its branches 'all', and switching to Split shares them out.
await page.locator('select[aria-label="Problem"]').selectOption('payment-processing');
await page.getByRole('banner').getByRole('button', { name: 'Learn', exact: true }).click();
await page.waitForTimeout(700);
check('call-all branches are labelled all', (await labelText('payments->card-network')) === 'all' && (await labelText('payments->idem-keys')) === 'all');
await page.getByRole('banner').getByRole('button', { name: 'Simulate', exact: true }).click();
const fullLoad = await rpsOf('card-network');
await page.locator('.react-flow__edge[data-id="payments->card-network"] .react-flow__edge-text').click({ force: true });
check('call-all branch explains itself instead of a share', (await page.locator('.inspector .share-note').count()) === 1 && (await page.locator('.share-row').count()) === 0);
await page.locator(`${nodeSel('payments')} .cnode-title`).click();
const fanout = page.getByRole('group', { name: 'Fan-out' });
check('fan-out toggle shows Call all on', (await fanout.getByRole('button', { name: 'Call all' }).getAttribute('class')) === 'on');
await fanout.getByRole('button', { name: 'Split' }).click();
check('split relabels branches with shares', (await labelText('payments->card-network')) === '33%');
await page.getByRole('banner').getByRole('button', { name: 'Simulate', exact: true }).click();
const splitLoad = await rpsOf('card-network');
check('split sends each branch a third of the load', Math.abs(splitLoad / fullLoad - 1 / 3) < 0.02, `${fullLoad} → ${splitLoad} rps`);
await fanout.getByRole('button', { name: 'Call all' }).click();
await page.screenshot({ path: path.join(SHOTS, '9-fanout.png') });

await page.getByRole('navigation').getByRole('button', { name: 'Library' }).click();
await page.screenshot({ path: path.join(SHOTS, '6-library.png') });
await page.locator('.library li', { hasText: 'Uber' }).getByRole('button', { name: 'Learn' }).click();
await page.waitForTimeout(700);
check('company architecture opens framed', (await nodeIds(page)).includes('disco') && (await allNodesInView(page)));
check('company architecture lists its sources', (await page.locator('.sources a').count()) >= 2);
await page.getByRole('banner').getByRole('button', { name: 'Simulate', exact: true }).click();
check('company architecture simulates healthy', (await page.locator('.status').textContent()).toLowerCase() === 'healthy');
await page.screenshot({ path: path.join(SHOTS, '7-uber.png') });
await page.close();

// ---------- Dark mode ----------
const dark = await freshPage({ width: 1440, height: 900 }, 'dark');
await dark.getByRole('banner').getByRole('button', { name: 'Learn', exact: true }).click();
await dark.waitForTimeout(500);
await dark.getByRole('button', { name: 'Simulate' }).click();
await dark.screenshot({ path: path.join(SHOTS, '4-dark.png') });
await dark.close();

// ---------- Phone width ----------
const phone = await freshPage({ width: 390, height: 844 });
check('phone: minimap hidden', !(await phone.locator('.react-flow__minimap').isVisible()));
check('phone: palette is a horizontal row', (await phone.$eval('.palette', (el) => getComputedStyle(el).overflowX)) === 'auto');
check('phone: no horizontal page scroll', await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await phone.locator('.palette-item', { hasText: /Service$/ }).click();
check('phone: tap adds a node', (await nodeIds(phone)).length === 2);
check('phone: tapped node lands in view', await allNodesInView(phone));
await phone.screenshot({ path: path.join(SHOTS, '5-phone.png'), fullPage: true });
await phone.close();

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
