// The generic data viewer, as an asset: `views: [{kind: "*"}]` makes it the last resort for every
// kind. The behaviour is the SDK's own (`ts_sdk/src/viewers/generic.ts`); shipping it as an asset
// means a project can override how ANY kind is shown by shipping a more specific viewer.
export { genericViewers as viewers, GENERIC_VIEWER_STYLES as styles, VIEWER_CONTRACT as contract } from '/sdk/flowpad-sdk.js';
