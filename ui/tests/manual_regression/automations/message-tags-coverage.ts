import { expect, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
export const approvedMock = JSON.parse(readFileSync(new URL('./message-tags-manifest.json', import.meta.url), 'utf8')) as {
  mock: string; screens: Array<{ id: string; actions: Array<{ id: string; to: string }> }>;
};
const manifest = approvedMock;

/** Evidence is recorded only AFTER a browser assertion/action succeeds. */
export class MessageTagsCoverage {
  private screens = new Set<string>();
  private actions = new Set<string>();

  async screen(id: string, page: Page, info: TestInfo) {
    expect(manifest.screens.some((screen) => screen.id === id), `unknown mock screen ${id}`).toBe(true);
    // URL completion precedes route data. Never count a loading shell as visual evidence.
    if (id.startsWith('automation')) await expect(page.getByTestId('message-rule-page')).toBeVisible();
    if (id.startsWith('tag-view')) {
      await expect(page.getByTestId('tag-view-messages')).toBeVisible();
      const graph = page.locator('.graph-view-root');
      await expect(graph).toHaveAttribute('data-node-count', /^[1-9]\d*$/);
      const labels = graph.locator('canvas.sigma-labels');
      await expect(labels).toHaveCount(1);
      // Sigma hides labels while its initial camera fit is moving. A painted
      // local-root label proves the canvas is ready, without an arbitrary delay.
      await expect.poll(() => labels.evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha] > 0) return true;
        return false;
      })).toBe(true);
    }
    if (id === 'history') await expect(page.getByTestId('run-detail')).toBeVisible();
    const path = info.outputPath(`mock-${id}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(`mock-${id}`, { path, contentType: 'image/png' });
    this.screens.add(id);
  }

  async action(screen: string, action: string, execute: () => Promise<void>) {
    const declared = manifest.screens.find((item) => item.id === screen);
    expect(declared?.actions.some((item) => item.id === action), `unknown mock action ${screen}/${action}`).toBe(true);
    await execute();
    this.actions.add(`${screen}/${action}`);
  }

  report() {
    return {
      mock: manifest.mock,
      screens: [...this.screens],
      actions: [...this.actions],
      missingScreens: manifest.screens.map((screen) => screen.id).filter((id) => !this.screens.has(id)),
      missingActions: manifest.screens.flatMap((screen) => screen.actions.map((action) => `${screen.id}/${action.id}`))
        .filter((id) => !this.actions.has(id)),
    };
  }

  async assertComplete(info: TestInfo) {
    const report = this.report();
    const path = info.outputPath('message-tags-mock-coverage.json');
    await writeFile(path, JSON.stringify(report, null, 2));
    await info.attach('message-tags-mock-coverage', { path, contentType: 'application/json' });
    expect(report.missingScreens, 'approved mock screens not validated').toEqual([]);
    expect(report.missingActions, 'approved mock actions not validated').toEqual([]);
  }
}
