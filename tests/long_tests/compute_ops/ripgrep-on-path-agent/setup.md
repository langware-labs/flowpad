---
id: 308eb9eb-397f-4372-902b-b8f718fb0654
---
Install ripgrep with the system package manager.

The cli op is written WITHOUT `apt-get update` on purpose. A freshly pulled image ships with an empty package index, so it fails with "unable to locate package" for a package that is perfectly available — the most common way a first install fails, and the reason an agent op that can read the error is worth running next.
