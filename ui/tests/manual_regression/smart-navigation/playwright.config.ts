/**
 * Smart navigation end to end (./smart_navigation_e2e.md). Needs an instance from this checkout,
 * cloud-logged-in to a hub that offers a decision API:
 *   scripts/instance_ctl.sh launch nav-7
 *   cd ui && VITE_PORT=5021 FLOW_INSTANCE=nav-7 npx playwright test \
 *     --config tests/manual_regression/smart-navigation/playwright.config.ts
 */
export { default } from '../general/playwright.config';
