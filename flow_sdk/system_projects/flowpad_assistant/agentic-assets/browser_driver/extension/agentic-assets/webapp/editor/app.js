// This browser driver's editor.
//
// The behaviour is the SDK's `mountBrowserEditor` — nesting the app HERE is what makes it this
// browser driver's child: the indexer discovers it and the enclosing asset becomes its parent.
// Replace this file to give extension an editor of its own.
import { mountBrowserEditor } from '/sdk/flowpad-sdk.js';

mountBrowserEditor();
