/**
 * Record screen from the top bar — see record_screen.md.
 *
 * The real MediaRecorder path in Chromium, the real upload into the recordings temp folder,
 * the real share dialog, and the real move into the project — each proven on disk, through
 * the backend's own actions, never by a guessed path. Only the OS picker is stood in for:
 * `getDisplayMedia` answers with a canvas stream (see the init script), since a headless
 * box has no screen to capture.
 */
import fs from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import { apiContext } from '../_shared/api';

const FILE_NAME = /^screen-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.webm$/;

test('record, share, save to project', async ({ page }) => {
  // The picker's answer: a drawn canvas as the "screen" — a real MediaStream for MediaRecorder.
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d')!;
      let hue = 0;
      setInterval(() => {
        ctx.fillStyle = `hsl(${(hue += 7) % 360} 60% 40%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }, 100);
      return Promise.resolve(canvas.captureStream(15));
    };
  });

  const api = await apiContext();
  const folderRes = await api.get('/api/v1/graph/recording-folder');
  expect(folderRes.ok(), 'the backend names the recordings folder').toBeTruthy();
  const folder = (await folderRes.json()).data as { abs_path: string; compute_node_id: string };
  expect(folder.abs_path.endsWith(path.join('recordings'))).toBeTruthy();
  const before = new Set(fs.existsSync(folder.abs_path) ? fs.readdirSync(folder.abs_path) : []);

  await page.goto('/dock/home');
  const record = page.getByTestId('top-nav-record-screen');
  await expect(record).toBeVisible();

  // 1. Left of Share, in document order.
  const share = page.getByTestId('entity-actions-share').first();
  if (await share.count()) {
    const order = await record.evaluate((a, b) => a.compareDocumentPosition(b as Element), await share.elementHandle());
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING, 'Record sits before Share').toBeTruthy();
  }

  // 2. Recording state.
  await record.click();
  await expect(record).toHaveAttribute('data-recording', 'true');
  await expect(record).toHaveAttribute('aria-label', 'Stop recording');
  await page.waitForTimeout(2000);
  await expect(record).toContainText(/00:0[1-9]/);

  // 3. Stop → the dialog, and the file on disk in the folder the backend named.
  await record.click();
  const dialog = page.getByTestId('recording-ready-dialog');
  await expect(dialog).toBeVisible();
  const fileName = (await page.getByTestId('recording-file-name').textContent())?.trim() ?? '';
  expect(fileName).toMatch(FILE_NAME);
  const tempFile = path.join(folder.abs_path, fileName);
  await expect.poll(() => fs.existsSync(tempFile) && fs.statSync(tempFile).size > 0, { message: 'the WebM landed in the recordings temp folder' }).toBe(true);
  expect(before.has(fileName)).toBe(false);

  // 4. Save to project → moved under <project>/recordings/, Save gone, Share stays.
  const save = page.getByTestId('recording-save-to-project');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toHaveCount(0);
  await expect(page.getByTestId('recording-share')).toBeVisible();
  await expect(dialog).toContainText('recordings/');
  await expect.poll(() => fs.existsSync(tempFile), { message: 'gone from the temp folder' }).toBe(false);
  await expect(page.getByText('Saved to project')).toBeVisible();
  await expect(page.getByText(`recordings/${fileName}`).first()).toBeVisible();

  // 5. Share → the standard dialog, the recording (now in the project) as its file; closing it ends the flow.
  await page.getByTestId('recording-share').click();
  const shareDialog = page.getByTestId('share-to-conversation-dialog');
  await expect(shareDialog).toBeVisible();
  // A project file's first share offers to link the project to the cloud; a plain share skips it.
  const skipLink = shareDialog.getByTestId('share-skip-link');
  const chips = shareDialog.getByTestId('share-asset-chips');
  // The dialog picks its first step after an async check: the cloud-link step (Skip) or the chips. Wait for
  // whichever comes; an instant isVisible() raced it and never skipped a link step shown a moment later.
  await expect(skipLink.or(chips)).toBeVisible();
  if (await skipLink.isVisible()) await skipLink.click();
  await expect(chips).toContainText(fileName);
  await shareDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(shareDialog).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await expect(record.getAttribute('aria-label')).resolves.toBe('Record screen');
});
