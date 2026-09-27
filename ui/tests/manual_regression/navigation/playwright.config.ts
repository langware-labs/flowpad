/**
 * Browser specs for the dock loading algorithm (docs/navigation/dock-loading.md).
 *
 * Assumes a DEDICATED backend + frontend with the mock worker (see ./_world.ts):
 *   PATH=$PWD/tests/fixtures/mock_worker_bin:$PATH SHELL=$PWD/tests/fixtures/mock_worker_shell \
 *     scripts/instance_ctl.sh launch dlm-7
 *   cd ui && VITE_PORT=5007 FLOW_INSTANCE=dlm-7 npx playwright test \
 *     --config tests/manual_regression/navigation/playwright.config.ts
 *
 * Budgets are the shared category budgets and must not be raised.
 */
export { default } from '../general/playwright.config';
