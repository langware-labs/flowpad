/**
 * Browser scenario — chartit charts in the chart editor (C4 + sequence), end to end.
 *
 *   1. A C4 chart written from the skill's own template renders: every box a chip of its kind with an
 *      icon, its boundary, the legend, and the Table view.
 *   2. Charts call charts across formats: a box's Open ↗ zooms in, an arrow's Open ↗ opens the
 *      call's sequence chart, and that sequence chart's participant Open ↗ comes back.
 *   3. Chips open what they name: a link chip opens the project file, a type chip its data_schema.
 *   4. Canvas: the wheel zooms, a drag pans (and picks nothing), Fit restores.
 *   5. Change this: pick an element → Add → the chart's Changes tab lists it with a numbered mark;
 *      Change chart adds a whole-chart request; a reload keeps both; Clear empties the list.
 *   6. Quick-create offers C4; a new C4 chart (CHART.md `format: c4`) opens empty.
 *   7. A chart in a format this build does not know says so instead of opening as a whiteboard.
 *   8. (CH_WORKER=1) Add & run: the chart's context worker edits c4.json; the chart shows the edit.
 *
 * The charts are written the way chartit's SKILL.md says — files in the chart folder, checked by the
 * skill's `check_c4.py` — and indexed the way the machine indexes a new asset folder. The project is
 * deleted afterwards.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const BE = `http://localhost:${process.env.CH_BE_PORT || '6001'}`;
const GRAPH = `${BE}/api/v1/graph`;
const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, '../../../../flow_sdk/system_projects/flowpad_assistant/.claude/skills/chartit');
const RUN_WORKER = process.env.CH_WORKER === '1';

let project = { id: '', root: '' };
const charts: Record<string, string> = {}; // name → chart TypeId
const pageErrors: string[] = [];

async function post(url: string, body?: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return r.json();
}

const chartDir = (name: string) => join(project.root, 'agentic-assets', 'chart', name);

/** A chart folder as the skill writes it: CHART.md (quoted description) + the format's source file. */
function writeChart(name: string, format: string, file: string, value: unknown, description: string): void {
  mkdirSync(chartDir(name), { recursive: true });
  writeFileSync(
    join(chartDir(name), 'CHART.md'),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nformat: ${format}\n---\n${description}\n`,
  );
  writeFileSync(join(chartDir(name), file), JSON.stringify(value, null, 2));
}

async function index(type: string, path: string): Promise<string> {
  const res = await post(`${GRAPH}/compute_node/@local/fs-records/index?${new URLSearchParams({ type, path })}`);
  return String(res?.data?.typeid ?? res?.typeid ?? '');
}

const chartUrl = (name: string) => `/dock/project/${project.id}/editor/chart/typeid/${charts[name]}`;

async function openChart(page: Page, name: string): Promise<void> {
  await page.goto(chartUrl(name));
  await expect(page.locator('[data-testid=chart-c4-element], [data-testid=chart-participant]').first()).toBeVisible({
    timeout: 60_000,
  });
}

test.beforeAll(async () => {
  const created = await post(`${GRAPH}/project`, { type: 'project', name: `chartit-e2e-${Date.now()}` });
  project.id = created?.data?.id;
  if (!project.id) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 200)}`);
  project.root = (await (await fetch(`${GRAPH}/project/${project.id}`)).json())?.data?.fs_storage_mount_path;
  if (!project.root) throw new Error(`project ${project.id} has no folder`);

  // 1. The skill's own example, as-is: a container chart whose API box zooms into "orders-code".
  mkdirSync(chartDir('food-delivery'), { recursive: true });
  copyFileSync(join(SKILL, 'templates/c4/example.c4.json'), join(chartDir('food-delivery'), 'c4.json'));
  const example = JSON.parse(readFileSync(join(chartDir('food-delivery'), 'c4.json'), 'utf8'));
  example.elements.find((e: { id: string }) => e.id === 'api').ref = 'orders-code';
  example.relations.find((r: { id: string }) => r.id === 'r2').ref = 'place-order-flow';
  writeChart('food-delivery', 'c4', 'c4.json', example, 'Container: the skill template example.');

  // 2. A code-level chart: typed inputs / returns (data_schema kinds), a link chip, new kinds.
  writeChart(
    'orders-code',
    'c4',
    'c4.json',
    {
      level: 'code',
      elements: [
        {
          id: 'engine', kind: 'code', label: 'PricingEngine', tech: 'class',
          inputs: [{ name: 'cart', kind: 'e2e.cart' }], returns: 'e2e.quote',
          links: [{ label: 'PricingEngine.kt', href: 'src/PricingEngine.kt:8' }],
        },
        { id: 'admin', kind: 'role', label: 'Pricing admin' },
        { id: 'apply', kind: 'action', label: 'Apply coupon' },
      ],
      boundaries: [],
      relations: [
        { id: 'r1', from: 'admin', to: 'apply', label: 'Runs' },
        { id: 'r2', from: 'apply', to: 'engine', label: 'Reprices', data: 'e2e.cart' },
      ],
    },
    'Code: typed inputs and a link to the source.',
  );
  mkdirSync(join(project.root, 'src'), { recursive: true });
  writeFileSync(join(project.root, 'src', 'PricingEngine.kt'), 'class PricingEngine\n');

  // 3. The sequence chart the API call opens; its participant opens the C4 chart again.
  writeChart(
    'place-order-flow',
    'sequence',
    'chart.json',
    {
      participants: [
        { id: 'spa', label: 'Web app', sublabel: 'React', icon: 'lucide.globe', ref: 'food-delivery' },
        { id: 'api', label: 'Order API', sublabel: 'FastAPI', icon: 'lucide.plug' },
      ],
      messages: [
        { id: 'm1', from: 'spa', to: 'api', label: 'POST /orders' },
        { id: 'm2', from: 'api', to: 'spa', label: '201 Created', style: 'dashed' },
      ],
    },
    'Sequence: the call behind one arrow.',
  );

  // 4. A chart in a format no build knows.
  writeChart('from-the-future', 'hologram', 'hologram.json', {}, 'A format this build does not know.');

  // The data schemas the type chips open.
  for (const kind of ['e2e.cart', 'e2e.quote']) {
    const dir = join(project.root, 'agentic-assets', 'data_schema', kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'data_schema.json'), JSON.stringify({ type: 'data_schema', fields: { id: { shape: 'string' } } }));
  }

  // The skill's check must pass on every C4 chart before it is shown.
  for (const name of ['food-delivery', 'orders-code']) {
    const out = execFileSync('python3', ['-I', join(SKILL, 'templates/c4/check_c4.py'), chartDir(name)], { encoding: 'utf8' });
    const result = JSON.parse(out.trim());
    expect(result.ok, `${name}: ${JSON.stringify(result.errors)}`).toBe(true);
    expect(result.warnings, name).toEqual([]);
  }

  for (const name of ['food-delivery', 'orders-code', 'place-order-flow', 'from-the-future']) {
    charts[name] = await index('chart', chartDir(name));
    expect(charts[name], name).toMatch(/^chart-[0-9a-f-]{36}$/);
  }
  for (const kind of ['e2e.cart', 'e2e.quote']) {
    expect(await index('data_schema', join(project.root, 'agentic-assets', 'data_schema', kind))).toMatch(/^data_schema-/);
  }
});

test.afterAll(async () => {
  try {
    if (project.id) await post(`${GRAPH}/project/${project.id}/delete-with-children`);
  } finally {
    if (project.root) rmSync(project.root, { recursive: true, force: true });
  }
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  page.on('pageerror', (e) => pageErrors.push(String(e)));
});

test('a C4 chart from the skill template renders as chips, boundary, legend and table', async ({ page }) => {
  await openChart(page, 'food-delivery');
  const cards = page.getByTestId('chart-c4-element');
  await expect(cards).toHaveCount(6);
  const kinds = await cards.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind));
  expect(new Set(kinds)).toEqual(new Set(['person', 'container', 'database', 'queue', 'system']));
  for (const card of await cards.all()) await expect(card.locator('foreignObject svg').first()).toBeAttached();
  await expect(page.getByTestId('chart-c4-boundary')).toHaveCount(1);
  await expect(page.getByTestId('chart-c4-level')).toHaveText('container');
  await expect(page.getByTestId('chart-c4-legend')).toContainText('Database');
  await page.getByTestId('chart-view-table').click();
  await expect(page.getByTestId('chart-table-row')).toHaveCount(6 + 5);
});

test('charts call charts: box zooms in, arrow opens its sequence chart, participant comes back', async ({ page }) => {
  await openChart(page, 'food-delivery');
  await page.getByTestId('chart-c4-element').filter({ hasText: 'Order API' }).getByTestId('chart-c4-open').click();
  await expect(page).toHaveURL(/orders-code|editor\/chart/);
  await expect(page.getByTestId('chart-c4-element').filter({ hasText: 'PricingEngine' })).toBeVisible();

  await openChart(page, 'food-delivery');
  await page.getByTestId('chart-c4-relation').filter({ hasText: 'Calls' }).getByTestId('chart-c4-open').click();
  await expect(page.getByTestId('chart-participant')).toHaveCount(2);
  await expect(page).toHaveURL(/place-order-flow/);

  await page.getByTestId('chart-participant-open').click();
  await expect(page.getByTestId('chart-c4-element').filter({ hasText: 'Order API' })).toBeVisible();
  await expect(page).toHaveURL(/food-delivery/);
});

test('a link chip opens the file, a type chip opens its data schema', async ({ page }) => {
  await openChart(page, 'orders-code');
  await expect(page.getByTestId('chart-c4-type')).toHaveCount(3); // cart, → quote, the arrow's cart
  await page.getByTestId('chart-c4-link').filter({ hasText: 'PricingEngine.kt' }).click();
  await expect(page).toHaveURL(/src\/PricingEngine\.kt/);

  await openChart(page, 'orders-code');
  await page.getByTestId('chart-c4-type').filter({ hasText: 'cart: e2e.cart' }).click();
  await expect(page).toHaveURL(/typeid\/data_schema-/);
});

test('canvas: a drag pans without picking, the wheel zooms, Fit restores', async ({ page }) => {
  await openChart(page, 'food-delivery');
  const svg = page.getByTestId('chart-c4-svg');
  const fit = await svg.getAttribute('viewBox');

  // A drag that starts on a box pans the canvas and opens no Change this.
  const card = (await page.getByTestId('chart-c4-element').first().boundingBox())!;
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 + 120, card.y + card.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(fit);
  await expect(page.getByTestId('chart-change-box')).toHaveCount(0);
  const panned = await svg.getAttribute('viewBox');

  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -240);
  await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(panned);

  await page.getByTestId('chart-zoom-fit').click();
  await expect.poll(() => svg.getAttribute('viewBox')).toBe(fit);
});

test('Change this queues requests in the Changes tab, with marks, kept across a reload', async ({ page }) => {
  await openChart(page, 'food-delivery');
  await page.locator('[data-testid=chart-c4-element][data-target=db]').click();
  await page.getByTestId('chart-change-text').fill('Rename this store to Order history.');
  await page.getByTestId('chart-change-add').click();
  await expect(page.getByTestId('chart-change-box')).toHaveCount(0);
  await expect(page.getByText('db · Orders')).toBeVisible();
  await expect(page.getByTestId('chart-change-mark')).toHaveCount(1);

  await page.getByTestId('chart-change-whole').click();
  await page.getByTestId('chart-change-text').fill('Add a courier app container.');
  await page.getByTestId('chart-change-add').click();
  await expect(page.getByText('Add a courier app container.')).toBeVisible();

  await page.reload();
  await expect(page.getByText('Rename this store to Order history.')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Add a courier app container.')).toBeVisible();
  await expect(page.getByTestId('chart-change-mark')).toHaveCount(1);

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('Rename this store to Order history.')).toHaveCount(0);
  await expect(page.getByTestId('chart-change-mark')).toHaveCount(0);
});

test('quick-create offers C4 and opens the new chart, empty', async ({ page }) => {
  await page.goto(`/dock/project/${project.id}`);
  // The project home's New opens the full quick-create (assets, not only sessions).
  await page.getByTestId('project-home-new').click();
  await page.getByRole('dialog', { name: 'New' }).getByRole('button', { name: 'Chart', exact: true }).click();
  await page.getByTestId('chart-create-name').fill('fresh-c4');
  await page.getByTestId('chart-format-c4').check();
  await page.getByTestId('chart-create-submit').click();
  await expect(page.getByTestId('chart-c4')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('chart-c4-summary')).toContainText('0 elements');
  // A new chart is its CHART.md (format: c4); the view reads a missing c4.json as an empty chart.
  expect(readFileSync(join(chartDir('fresh-c4'), 'CHART.md'), 'utf8')).toMatch(/^format: c4$/m);
});

test('a format this build does not know says so', async ({ page }) => {
  await page.goto(chartUrl('from-the-future'));
  await expect(page.getByTestId('chart-unknown-format')).toContainText('hologram');
  await expect(page.locator('.excalidraw')).toHaveCount(0);
});

test('Add & run: the context worker edits the chart and it redraws', async ({ page }) => {
  test.skip(!RUN_WORKER, 'set CH_WORKER=1 to spend a real worker turn');
  test.setTimeout(600_000);
  await openChart(page, 'orders-code');
  await page.getByTestId('chart-c4-element').filter({ hasText: 'Pricing admin' }).click();
  await page.getByTestId('chart-change-text').fill("Rename this box to 'Pricing owner'. Keep everything else.");
  await page.getByTestId('chart-change-run').click();
  const source = join(chartDir('orders-code'), 'c4.json');
  await expect.poll(() => readFileSync(source, 'utf8'), { timeout: 540_000, intervals: [5_000] }).toContain('Pricing owner');
  await openChart(page, 'orders-code');
  await expect(page.getByTestId('chart-c4-element').filter({ hasText: 'Pricing owner' })).toBeVisible();
});

test('no page errors anywhere in the run', () => {
  expect(pageErrors).toEqual([]);
});
