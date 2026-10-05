// The generic dataset editor: `edits: ["dataset"]` offers it for EVERY dataset that ships no
// editor of its own, opened with `?subject=dataset-<id>`. The behaviour is the SDK's
// `mountDatasetEditor`, which builds its forms from the dataset's declared kinds.
import { mountDatasetEditor } from '/sdk/flowpad-sdk.js';

mountDatasetEditor();
