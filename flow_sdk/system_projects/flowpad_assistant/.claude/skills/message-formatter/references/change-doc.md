# Changes to someone else's document

When the receiver owns the document (a policy, a spec, a contract) and applies your changes
themselves, never send your edited copy or a diff of your repo. Send:

1. **A change doc** (`--file <name>.md`), one block per change:
   ```
   ## Change N — <short name>
   Add after: <section number + title, and its last sentence>   (or Replace: <exact old text>)
   Section: <new section number + title>
   Content:
   <the exact text to add, as it should read>
   ```
   End with "Must stay true" (the required items, who requires them, and any limit on what is
   collected or used, such as "only the access needed", stated explicitly) and "Open" (what they decide).
2. **A prompt** for their agent: apply each block to their copy, show a before → after list, then
   check every "Must stay true" item made it into their PR and report anything missing.
3. **The text**: one line on what to apply and why.
