/**
 * Playwright config for the dock sweep — every agent-addressable screen, in
 * each shipped view mode, driven through the real control plane.
 *
 * Assumes a DEDICATED backend + frontend are already running (never the user's
 * dev instance):
 *   scripts/instance_ctl.sh launch dock7
 *   VITE_PORT=5007 FLOW_INSTANCE=dock7 npx playwright test \
 *     --config tests/manual_regression/dock-sweep/playwright.config.ts
 *
 * Budgets are the shared category budgets and must not be raised: a dock that
 * cannot open inside them IS the finding.
 */
export { default } from '../general/playwright.config';
