// The generic eval browser: `edits: ["dataset"]` offers it for EVERY dataset, opened with
// `?subject=dataset-<id>`. The behaviour is the SDK's `mountEvalBrowser`, which reads only the
// eval contract (EvalRun / ExampleEval) through the dataset's own actions.
import { mountEvalBrowser } from '/sdk/flowpad-sdk.js';

mountEvalBrowser();
