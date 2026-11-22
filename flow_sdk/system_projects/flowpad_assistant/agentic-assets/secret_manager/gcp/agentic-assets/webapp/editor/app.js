// This secret manager's editor.
//
// The behaviour is the SDK's `mountVaultEditor` — nesting the app HERE is what makes it this
// secret manager's child: the indexer discovers it and the enclosing asset becomes its parent.
// Replace this file to give gcp an editor of its own.
import { mountVaultEditor } from '/sdk/flowpad-sdk.js';

mountVaultEditor();
