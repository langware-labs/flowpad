// This definition's editor.
//
// The behaviour is the SDK's `mountSourceEditor` — nesting the app HERE is what
// makes it this definition's child: the indexer discovers it, the enclosing
// asset becomes its parent, and the address bar reads `Project / slack / editor`.
// Replace this file to give slack an editor of its own.
import { mountSourceEditor } from '/sdk/flowpad-sdk.js';

mountSourceEditor();
