/**
 * A notification in the person's language: its "Open" button, and the project-invite sentence the
 * SENDER's backend wrote in English. Loaded from the real catalogs.
 */
import { i18n } from '@lingui/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('@src/notifications/notify', () => ({ notify: h.notify }));

import { localizedBody, renderDesktopNotification } from '@src/notifications/renderDesktopNotification';
import { messages as ar } from '../../src/locales/ar/messages.po';
import { messages as he } from '../../src/locales/he/messages.po';

const INVITE = 'I invited you to project "ai-course-2".';

beforeEach(() => {
  vi.clearAllMocks();
  i18n.load({ he: he as never, ar: ar as never, 'en-US': {} });
});
afterEach(() => i18n.activate('en-US'));

describe('a notification in Hebrew', () => {
  beforeEach(() => i18n.activate('he'));

  it('says "פתח" on its button, not "Open"', () => {
    renderDesktopNotification({
      title: 'Gadi Tunes',
      body: INVITE,
      click_target: { view_type: 'project', pointer: 'x' },
    });
    expect(h.notify.mock.calls[0][0].actions[0].label).toBe('פתח');
  });

  it('translates the invite sentence and keeps the project name', () => {
    const out = localizedBody(INVITE);
    expect(out).toContain('ai-course-2');
    expect(out).not.toContain('invited');
  });

  it('leaves the sharer′s own note exactly as written', () => {
    const out = localizedBody(`${INVITE}\n\nSee you there`);
    expect(out.endsWith('\n\nSee you there')).toBe(true);
  });

  it('shows any other body as it came', () => {
    expect(localizedBody('Build finished')).toBe('Build finished');
  });
});

describe('a notification in Arabic', () => {
  beforeEach(() => i18n.activate('ar'));

  it('translates the button and the invite sentence', () => {
    renderDesktopNotification({
      title: 'Gadi Tunes',
      body: INVITE,
      click_target: { view_type: 'project', pointer: 'x' },
    });
    const call = h.notify.mock.calls[0][0];
    expect(call.actions[0].label).toBe('فتح');
    expect(call.message).toContain('ai-course-2');
    expect(call.message).not.toContain('invited');
  });
});
