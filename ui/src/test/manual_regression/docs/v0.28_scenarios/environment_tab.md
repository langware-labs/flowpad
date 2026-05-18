---
id: c21644a8-6efd-5e07-b95e-74834a7371a9
---

test 1: FlowPad API Key
- navigate to {APP_URL}/dock/environment
- validate environment tab visible
- click "generate FlowPad API key"
- validate API Key visible, click "copy to clipboard"
- validate clipboard holds the key
- refresh page
- validate FlowPad API key exists and is hidden
- in FlowPad API Key box click "Delete API key"
- validate FlowPad API Key box dissapeared

test 2: nonconf Variable
- navigate to {APP_URL}/dock/environment
- click "Add Variable"
- fill variable form:
    Name=TEST2
    Type=Non Confidential
    Value=53
- click save
- validate variable TEST2 is visible in Environment Variable table with value=53 visible
- in table, TEST2 row, click "edit"
- fill variable edit form:
    New Value=98
- click save
- validate variable TEST2 is visible in Environment Variable table with value=98 visible
- in table, TEST2 row, click "delete"
- validate TEST2 not in Variables table

test 2: conf Variable
- navigate to {APP_URL}/dock/environment
- fill variable form:
    Name=TEST2
    Type=API Key
    Value=123QWE
- click save
- validate variable TEST2 is visible in Environment Variable table with value=123QWE blocked out and invisible
- in table, TEST2 row, click "delete"
- validate TEST2 not in Variables table
