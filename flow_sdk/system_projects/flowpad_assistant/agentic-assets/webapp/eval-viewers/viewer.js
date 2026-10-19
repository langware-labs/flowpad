// The eval contract's viewers (`eval.run`, `eval.row`), as an asset. The behaviour is the SDK's
// (`ts_sdk/src/viewers/eval.ts`): generic over datasets, an example nests its dataset's own viewer.
export { evalViewers as viewers, EVAL_VIEWER_STYLES as styles, VIEWER_CONTRACT as contract } from '/sdk/flowpad-sdk.js';
