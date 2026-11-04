import base from '../general/playwright.config';

/** The first-agent wizard on the hub page: a real agent, a real address, a real sandbox — minutes, not seconds. */
export default {
  ...base,
  timeout: 6 * 60_000,
  outputDir: process.env.PW_OUTPUT_DIR || '/tmp/flowpad-hub-home-results',
};
