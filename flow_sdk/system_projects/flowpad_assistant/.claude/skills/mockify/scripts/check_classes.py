"""Which of these class names does the compiled CSS actually define?

Usage: python -I check_classes.py <app.css> "mt-0.5 size-4 bg-red-500/15 [&_svg]:size-4 dark:invert" [...]
Prints MISSING lines for classes no rule defines. A utility the app never used is not in its compiled
CSS and does nothing — check before using a class you copied from a component's source.
The CSS is minified (one line) and escapes . / : [ ] etc. in selectors, so a plain grep cannot answer this.
"""

import re
import sys

css = open(sys.argv[1], encoding="utf-8").read()
names = " ".join(sys.argv[2:]).split()


def escaped(name: str) -> str:
    return "." + re.sub(r"([^a-zA-Z0-9_-])", r"\\\1", name)


missing = 0
for n in names:
    found = escaped(n) in css
    missing += not found
    print(("ok      " if found else "MISSING ") + n)
sys.exit(1 if missing else 0)
