import base from '../general/playwright.config';

/**
 * The journey sweep. Shares the general config's budgets — a step that cannot
 * settle inside them IS the finding. `outputDir` leaves the repo because the
 * backend indexes this tree, and traces written mid-run become indexing load
 * that slows the very navigations under test.
 */
export default {
  ...base,
  outputDir: process.env.PW_OUTPUT_DIR || '/tmp/flowpad-journey-sweep-results',
};
