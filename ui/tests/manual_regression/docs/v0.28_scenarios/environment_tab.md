---
id: c21644a8-6efd-5e07-b95e-74834a7371a9
---

test 1: FlowPad API Key
- navigate to {APP_URL}/dock/credentials/api-keys
- validate the Credentials view is visible with the API Keys tab active
- click "generate FlowPad API key"
- validate API Key visible, click "copy to clipboard"
- validate clipboard holds the key
- refresh page
- validate FlowPad API key exists and is hidden
- in FlowPad API Key box click "Delete API key"
- validate FlowPad API Key box dissapeared

test 2: project environment variable lifecycle
- navigate to {APP_URL}/dock/credentials/environment
- validate the Credentials view is visible with the Project Environment tab active
- click "Declare"
- declare TEST2 with a description and initial value=53
- validate TEST2 is Met and its stored value is masked rather than present in the DOM
- click "Replace", provide value=98, and validate TEST2 remains Met with the replacement masked
- remove the declaration and confirm "Stop declaring"
- validate TEST2 is no longer declared in the project table; the global encrypted value is preserved for reuse
