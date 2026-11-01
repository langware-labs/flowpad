import { homedir } from 'node:os';
import { join } from 'node:path';

/** The report folder — never inside the repo. Fixed once per run (config sets the env for workers). */
export function reportDir(): string {
  if (!process.env.WL_REPORT_DIR) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    process.env.WL_REPORT_DIR = join(homedir(), 'Downloads', 'webapp-lifecycle', stamp);
  }
  return process.env.WL_REPORT_DIR;
}
