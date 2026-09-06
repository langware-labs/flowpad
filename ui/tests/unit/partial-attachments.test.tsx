import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FlowMessage, TypeId } from '@sdk';
import { AttachmentType, BodyStatus, isAttachmentMissing } from '@sdk/entities/flow-message';
import { AttachmentDownloadWarning } from '@src/components/conversation/AttachmentDownloadWarning';
import { buildSharedEntities } from '@src/components/conversation/conversation-context-aggregation';

const missing = {
  attachment_type: AttachmentType.TYPE_ID,
  data: 'flowpad_diagnosis-ed397b4d-3c92-44ee-9874-c88cc787bbc7',
};
const available = {
  attachment_type: AttachmentType.TYPE_ID,
  data: 'skill-22222222-2222-4222-8222-222222222222',
};

/** Mirrors the popover's own absolute-clock format. */
const TIME_PARTS = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
} as const;

afterEach(cleanup);

describe('partial attachment downloads', () => {
  it('keeps available assets usable and reports only missing assets after download', () => {
    const fm = new FlowMessage({
      id: '11111111-1111-4111-8111-111111111111',
      attachment: [missing, available],
      body_downloaded: true,
      body_missing_attachments: [missing],
    });
    expect(isAttachmentMissing(fm, missing)).toBe(true);
    expect(isAttachmentMissing(fm, available)).toBe(false);
    const entries = buildSharedEntities([fm], new Set());
    expect(entries.find((e) => e.typeId.equals(new TypeId(missing.data)))).toMatchObject({
      downloaded: true,
      missing: true,
    });
    expect(entries.find((e) => e.typeId.equals(new TypeId(available.data)))).toMatchObject({
      downloaded: true,
      missing: false,
    });
    fm.body_downloaded = false;
    expect(isAttachmentMissing(fm, missing)).toBe(false);
  });

  it.each([false, true])('an available copy takes precedence over a partial origin (reverse=%s)', (reverse) => {
    const partial = new FlowMessage({
      id: '11111111-1111-4111-8111-111111111111',
      attachment: [missing],
      body_downloaded: true,
      body_missing_attachments: [missing],
    });
    const complete = new FlowMessage({
      id: '22222222-2222-4222-8222-222222222222',
      attachment: [missing],
      body_downloaded: true,
      body_missing_attachments: [],
    });
    const entries = buildSharedEntities(reverse ? [complete, partial] : [partial, complete], new Set());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ downloaded: true, missing: false });
  });

  it('exposes the exact missing type/ID in a keyboard-accessible tooltip', async () => {
    render(<AttachmentDownloadWarning attachments={[missing]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Missing attachments' }));
    expect((await screen.findByRole('dialog')).textContent).toContain(missing.data);
  });

  it('retries only on an explicit click and disables retry while downloading', async () => {
    let downloads = 0;
    const onDownload = () => {
      downloads += 1;
    };
    const { rerender } = render(<AttachmentDownloadWarning attachments={[missing]} onDownload={onDownload} />);
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Missing attachments' }));
    const button = await screen.findByRole('button', { name: 'Download again' });
    expect(downloads).toBe(0);
    fireEvent.click(button);
    expect(downloads).toBe(1);
    rerender(<AttachmentDownloadWarning attachments={[missing]} onDownload={onDownload} downloading />);
    const busy = screen.getByRole('button', { name: 'Downloading…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(downloads).toBe(1);
  });

  it('offers retry for a download error even without a missing-asset list', async () => {
    let downloads = 0;
    render(
      <AttachmentDownloadWarning
        attachments={[]}
        error="Body download failed"
        onDownload={() => {
          downloads += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Could not download' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('Body download failed');
    fireEvent.click(screen.getByRole('button', { name: 'Download again' }));
    expect(downloads).toBe(1);
  });

  it('reports the timings and the failed request behind a short download', async () => {
    const sentAt = new Date('2026-09-06T10:00:00Z');
    render(
      <AttachmentDownloadWarning
        attachments={[missing]}
        error={{
          method: 'GET',
          path: '/flow_message/11111111-1111-4111-8111-111111111111/download_body',
          statusCode: 404,
          message: 'Not found',
          ts: new Date('2026-09-06T10:05:00Z').getTime(),
        }}
        info={{
          messageTime: sentAt,
          lastAttemptAt: new Date('2026-09-06T10:04:00Z').getTime(),
          attemptCount: 2,
          bodyStatus: BodyStatus.READY,
          downloaded: true,
          messageId: '11111111-1111-4111-8111-111111111111',
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Could not download' }));
    const text = (await screen.findByRole('dialog')).textContent ?? '';
    // The failure's own clock wins over the attempt clock (10:05, not 10:04).
    expect(text).toContain(sentAt.toLocaleString(undefined, TIME_PARTS));
    expect(text).toContain(new Date('2026-09-06T10:05:00Z').toLocaleString(undefined, TIME_PARTS));
    expect(text).not.toContain(new Date('2026-09-06T10:04:00Z').toLocaleString(undefined, TIME_PARTS));
    expect(text).toContain('404');
    expect(text).toContain('GET /flow_message/11111111-1111-4111-8111-111111111111/download_body');
    expect(text).toContain('2 this session');
    expect(text).toContain('pulled, but arrived short');
  });
});
