/**
 * A received transcript's chip must go solid the moment it installs — with no
 * page reload.
 *
 * The chip reads `chipStateFor(!!data, ma, forceShow)`, where `data` comes from
 * `useEntity(claude_session-<id>)`. While the attachment is staged the backend
 * answers 404 on purpose (`ClaudeSession._arrived_as_attachment` refuses to
 * hand back the SENDER's transcript for one that isn't installed); installing
 * flips the same GET to a real entity.
 *
 * The client, though, marks that first 404 TERMINAL — `dataManager`
 * short-circuits every later ask for the life of the page (measured on the live
 * app: 36ms for the first ask, 0ms after). Nothing clears it on install:
 * `useEntity`'s fetch effect keys on the typeId, which doesn't change, and a
 * disk-recovered session has no DB row so no `data_op` is ever emitted either.
 * The chip therefore rendered the stale miss until a reload rebuilt the store.
 *
 * Drives the REAL `MessageEntityChip` against a REAL backend with a REAL
 * MessageAttachment row and a REAL transcript on disk — the staged→installed
 * prop change is exactly what `AttachmentLiveSubscriber` delivers when the
 * install lands. Nothing is mocked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { config, MessageAttachment } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { MessageEntityChip } from '@src/components/conversation/FlowMessageBubble';
import { TypeId } from '@sdk';
import '@src/i18n-init';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const SESSION_TYPE = 'claude_session';

function writeSenderTranscript(sessionId: string, cwd: string): string {
  const claudeHome = process.env.FLOWPAD_CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const dir = path.join(claudeHome, 'projects', cwd.replace(/\//g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    JSON.stringify({ sessionId, cwd, type: 'user', timestamp: new Date(0).toISOString() }) + '\n',
    'utf-8',
  );
  return file;
}

async function postAttachment(body: { type: string } & Record<string, unknown>): Promise<void> {
  const r = await fetch(`${config.SERVER_URL}/graph/${body.type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST failed: ${r.status} ${await r.text()}`);
}

function renderChip(typeId: TypeId, attachment: MessageAttachment) {
  return render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <TooltipProvider>
          <MessageEntityChip
            typeId={typeId}
            conversationId="conv-under-test"
            projectId={null}
            forceShow
            attachment={attachment}
          />
        </TooltipProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const chipIsDashed = () => {
  const btn = screen.getByRole('button');
  return btn.className.includes('border-dashed');
};

describe('react: received transcript chip installs without a reload', () => {
  const signupInfo = getTestSignupInfo();
  const created: string[] = [];

  beforeEach(async (context: { task: { name: string } }) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  afterAll(() => {
    for (const f of created) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it('goes from dashed to solid when the attachment installs', async () => {
    const sessionId = crypto.randomUUID();
    const cwd = path.join(os.tmpdir(), `chip-sender-${sessionId.slice(0, 8)}`);
    created.push(writeSenderTranscript(sessionId, cwd));

    const maId = crypto.randomUUID();
    const base = {
      id: maId,
      type: MessageAttachment.type,
      asset_type: SESSION_TYPE,
      asset_id: sessionId,
      flow_message_id: crypto.randomUUID(),
      conversation_id: 'conv-under-test',
      name: 'shared transcript',
    };
    await postAttachment({ ...base, scope: null });

    const typeId = new TypeId(SESSION_TYPE, sessionId);
    const staged = new MessageAttachment({ ...base, scope: null } as never);
    const { rerender } = renderChip(typeId, staged);

    // Staged: the backend 404s and the chip is correctly dashed.
    await waitFor(() => expect(chipIsDashed()).toBe(true));

    // The install — the same row change AttachmentLiveSubscriber pushes down.
    await postAttachment({ ...base, scope: 'project', installed_root: cwd });
    const installed = new MessageAttachment({ ...base, scope: 'project', installed_root: cwd } as never);

    rerender(
      <I18nProvider i18n={i18n}>
        <MemoryRouter>
          <TooltipProvider>
            <MessageEntityChip
              typeId={typeId}
              conversationId="conv-under-test"
              projectId={null}
              forceShow
              attachment={installed}
            />
          </TooltipProvider>
        </MemoryRouter>
      </I18nProvider>,
    );

    // No remount, no reload: the chip must re-ask and resolve.
    await waitFor(() => expect(chipIsDashed()).toBe(false), { timeout: 5000 });
  }, 30_000);
});
