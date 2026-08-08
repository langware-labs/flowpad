import base from '../general/playwright.config';

/**
 * Browser proof for the navigation collapse. Shares the general config's
 * budgets — a navigation that cannot settle inside them IS the finding.
 *
 * `outputDir` deliberately leaves the repo. The backend watches this tree, and
 * traces/screenshots written during a run register as file changes: the suite
 * was making the very indexing load that then slowed its own navigations, which
 * showed up as failures wandering between tests run to run.
 */
export default {
  ...base,
  outputDir: process.env.PW_OUTPUT_DIR || '/tmp/flowpad-nav-collapse-results',
};
