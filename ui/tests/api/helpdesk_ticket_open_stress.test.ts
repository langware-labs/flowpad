/**
 * Stress: opening support tickets, through the call the Help desk dialog makes
 * (`startHelpdeskTicket(text, project.id)`), on a real hub-logged-in backend. Every open is
 * recorded (text, project, returned conversation + desk, error, ms) to STRESS_OUT so the
 * requester's local rows and the desk's queue can be checked against it.
 *
 * Run: FLOW_INSTANCE=<requester> TICKET_PROJECT=<project adopting a desk> STRESS_OUT=<file>
 *      vitest --project api <this>
 */
import fs from 'node:fs';
import { dataContext, startHelpdeskTicket } from '@sdk';
import { cloudManager } from '@sdk/services/cloud_login';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { errorMessage } from '@src/lib/error-message';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const PROJECT = process.env.TICKET_PROJECT ?? '';
const OUT = process.env.STRESS_OUT ?? '';

type Outcome = {
  scenario: string;
  text: string;
  projectId: string | null;
  conversationId?: string;
  deskId?: string;
  error?: string;
  ms: number;
};
const outcomes: Outcome[] = [];

async function open(scenario: string, text: string, projectId: string | null = PROJECT): Promise<Outcome> {
  const started = performance.now();
  const outcome: Outcome = { scenario, text, projectId, ms: 0 };
  try {
    const res = await startHelpdeskTicket(text, projectId);
    outcome.conversationId = res.conversation_id;
    outcome.deskId = res.project_id;
  } catch (e) {
    outcome.error = errorMessage(e, String(e));
  }
  outcome.ms = Math.round(performance.now() - started);
  outcomes.push(outcome);
  return outcome;
}

describe.skipIf(!PROJECT || !OUT)('Support tickets — opening, stress', () => {
  const signupInfo = getTestSignupInfo();
  const stamp = Date.now();

  beforeEach(async (ctx: { task: { name: string } }) => {
    await apiTestSetup(signupInfo, ctx.task.name);
    await cloudManager.refreshStatus();
    expect(dataContext.cloudLoginAvailable, 'needs a hub-logged-in backend').toBe(true);
  });
  afterAll(() => {
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ outcomes }, null, 2));
  });

  it('O1 short', async () => {
    await open('O1', `My build fails ${stamp}`);
  });
  it('O2 long (5000 chars)', async () => {
    await open('O2', `Long ${stamp} ` + 'the agent loops on npm install and never finishes. '.repeat(100));
  });
  it('O3 unicode, RTL, emoji', async () => {
    await open('O3', `הסוכן נתקע ${stamp} 🚀 — 日本語 — Ünïcödé`);
  });
  it('O4 markdown, code, HTML', async () => {
    await open('O4', `Error ${stamp}:\n\n\`\`\`ts\nconst x = <T,>(a: T) => a;\n\`\`\`\n<script>alert(1)</script> **bold** & "quotes"`);
  });
  it('O5 whitespace only is refused', async () => {
    await open('O5', '   \n\t ');
  });
  it('O6 same text x3, sequential', async () => {
    for (let i = 0; i < 3; i++) await open('O6', `Same question ${stamp}`);
  });
  it('O7 five different, concurrent', async () => {
    await Promise.all([0, 1, 2, 3, 4].map((i) => open('O7', `Concurrent ${i} ${stamp}`)));
  });
  it('O8 five identical, concurrent', async () => {
    await Promise.all([0, 1, 2, 3, 4].map(() => open('O8', `Identical burst ${stamp}`)));
  });
  it('O9 no project: the hub default desk', async () => {
    await open('O9', `No project ${stamp}`, null);
  });
  it('O10 title boundary: 60 and 61 chars', async () => {
    const base = `B${stamp} `;
    await open('O10', base + 'x'.repeat(60 - base.length));
    await open('O10', base + 'y'.repeat(61 - base.length));
  });
  it('O11 ten at once', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => open('O11', `Burst ${i} ${stamp}`)));
  });
});
