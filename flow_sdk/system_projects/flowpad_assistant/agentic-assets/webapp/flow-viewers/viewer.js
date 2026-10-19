// Flowpad's own kinds (the Flow context, a decision request, a decision response), as an asset.
// The behaviour is the SDK's (`ts_sdk/src/viewers/flow.ts`): generic, so every decision and every
// context in Flowpad is shown the same way wherever it appears.
export { flowViewers as viewers, FLOW_VIEWER_STYLES as styles, VIEWER_CONTRACT as contract } from '/sdk/flowpad-sdk.js';
