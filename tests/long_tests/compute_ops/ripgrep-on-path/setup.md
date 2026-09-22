Install ripgrep with the system package manager.

The cheap attempt is written WITHOUT `apt-get update` on purpose. A freshly pulled image ships with an empty package index, so it fails with "unable to locate package" for a package that is perfectly available — the most common way a first install fails, and the reason a rung that can read the error is worth having.
