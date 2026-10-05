/**
 * Stress HARNESS (records, does not assert): "Ask someone for help" with images, through the
 * real dialog on a real hub-logged-in backend. Every ask is recorded (title, task id, error,
 * ms) to STRESS_OUT so the recipient side can be checked against it. Skipped unless both env
 * vars are set.
 *
 * Run: FLOW_INSTANCE=<sender> ASK_TO=<recipient email> [ASK_SELF=<sender email>]
 *      STRESS_OUT=<file> vitest --project api <this>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { Project } from '@sdk';
import { afterAll, afterEach, beforeEach, describe, it } from 'vitest';
import { type AskOutcome, askForHelp, hubLoggedInSetup, png } from '../utils/ask-for-help';
import { getTestSignupInfo } from '../utils/test-utils';

const TO = process.env.ASK_TO ?? '';
const SELF = process.env.ASK_SELF ?? '';
const OUT = process.env.STRESS_OUT ?? '';

type Ask = { title: string; files: File[] };
type Outcome = AskOutcome & { scenario: string; title: string; to: string; files: { name: string; size: number }[] };
const outcomes: Outcome[] = [];
const stamp = Date.now();

/** Each scenario: how many asks, at once or one after another, and what each one sends. */
const SCENARIOS: [name: string, asks: number, concurrent: boolean, ask: (i: number) => Ask][] = [
  ['S1 one image', 1, false, () => ({ title: `S1 one image ${stamp}`, files: [png('shot-1.png', 165_000)] })],
  [
    'S2 three images',
    1,
    false,
    () => ({
      title: `S2 three images ${stamp}`,
      files: [png('a.png', 50_000), png('b.png', 120_000), png('c.png', 300_000)],
    }),
  ],
  ['S3 large image 8MB', 1, false, () => ({ title: `S3 large ${stamp}`, files: [png('large.png', 8_000_000)] })],
  [
    'S4 unicode + spaces filename',
    1,
    false,
    () => ({ title: `S4 unicode ${stamp}`, files: [png('צילום מסך 2026-10-05 ב-10.38.png', 90_000)] }),
  ],
  [
    'S5 two files, same name',
    1,
    false,
    () => ({ title: `S5 same name ${stamp}`, files: [png('dup.png', 10_000), png('dup.png', 20_000)] }),
  ],
  ['S6 no image', 1, false, () => ({ title: `S6 no image ${stamp}`, files: [] })],
  [
    'S7 same title x5, sequential',
    5,
    false,
    (i) => ({ title: `S7 same title ${stamp}`, files: [png(`s7-${i}.png`, 40_000)] }),
  ],
  [
    'S8 same title x4, concurrent',
    4,
    true,
    (i) => ({ title: `S8 concurrent ${stamp}`, files: [png(`s8-${i}.png`, 40_000)] }),
  ],
];

describe.skipIf(!TO || !OUT)('Ask someone for help — stress', () => {
  const signupInfo = getTestSignupInfo();
  const projectDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'askstress'));
  let projectId = '';

  beforeEach(async (ctx: { task: { name: string } }) => {
    await hubLoggedInSetup(signupInfo, ctx.task.name);
    if (!projectId) projectId = (await new Project({ name: projectDir }).save([])).id;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ projectId, outcomes }, null, 2));
  });

  async function record(scenario: string, to: string, ask: Ask): Promise<void> {
    const outcome = await askForHelp({ projectId, to, ...ask });
    const files = ask.files.map((f) => ({ name: f.name, size: f.size }));
    outcomes.push({ scenario: scenario.split(' ')[0], to, title: ask.title, files, ...outcome });
  }

  it.each(SCENARIOS)('%s', async (scenario, asks, concurrent, ask) => {
    const run = (i: number) => record(scenario, TO, ask(i));
    if (concurrent) await Promise.all(Array.from({ length: asks }, (_, i) => run(i)));
    else for (let i = 0; i < asks; i++) await run(i);
  });

  it.skipIf(!SELF)('S9 ask yourself, with image', async () => {
    await record('S9', SELF, { title: `S9 self ${stamp}`, files: [png('self.png', 30_000)] });
  });
});
