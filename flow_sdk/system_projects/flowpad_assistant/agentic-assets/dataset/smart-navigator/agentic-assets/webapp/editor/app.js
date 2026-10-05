// The SmartNavigator dataset's own editor. Nesting it HERE makes it the dataset's child: the
// indexer discovers it, the dataset becomes its parent, and opening the dataset opens this --
// before any editor that only matches its kind. Replace this file for a bespoke editor.
import { mountDatasetEditor } from '/sdk/flowpad-sdk.js';

mountDatasetEditor();
