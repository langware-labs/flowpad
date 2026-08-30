// This definition's editor.
//
// The behaviour is the SDK's `mountSourceEditor` — nesting the app HERE is what
// makes it this definition's child: the indexer discovers it, the enclosing
// asset becomes its parent, and the address bar reads `Project / gdrive / editor`.
// Replace this file to give gdrive an editor of its own.
import { mountSourceEditor } from '/sdk/flowpad-sdk.js';

mountSourceEditor();
