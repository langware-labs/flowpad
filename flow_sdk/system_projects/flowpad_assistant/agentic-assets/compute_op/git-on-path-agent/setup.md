Install Git with the platform's own package manager so that `git --version` answers from a fresh shell.

On a slim image the package index ships empty, so an install fails with "unable to locate package" until it has been refreshed.
