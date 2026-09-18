"""A ``BROWSER`` for unattended OAuth end-to-end runs: follow the consent URL like a person who clicks Allow.

Python's ``webbrowser`` honors ``BROWSER``, runs ``<cmd> <url>`` and waits for it to exit, so this
forks: the parent returns at once (the CLI / SDK process that "opened a browser" carries on waiting
for the flow), and the child follows the redirects — provider authorize → callback → landing.

Usage: ``BROWSER="<python> tests/utils/follow_auth_url.py %s"``.
"""

from __future__ import annotations

import os
import sys


def main(url: str) -> None:
    if os.fork():
        return
    import httpx

    try:
        httpx.get(url, follow_redirects=True)
    finally:
        os._exit(0)


if __name__ == "__main__":
    main(sys.argv[1])
