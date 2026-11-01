/** One scenario's measurements, attached to the test result; `_report.ts` collects them. */
import type { TestInfo } from '@playwright/test';

export interface Metrics {
  app?: string;
  scenario?: string;
  timings?: Record<string, number | null>;
  transitions?: string[];
  backendCalls?: number;
  backendCallUrls?: string[];
  fixerRuns?: number;
  agentRuns?: number;
  notes?: string[];
  [k: string]: unknown;
}

export function record(info: TestInfo, m: Metrics): void {
  info.attachments.push({ name: 'wl-metrics', contentType: 'application/json', body: Buffer.from(JSON.stringify(m)) });
}
