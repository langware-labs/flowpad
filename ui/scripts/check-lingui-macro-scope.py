#!/usr/bin/env python3
"""Every file that USES a lingui macro must have that symbol in scope.

Checks the whole tree, not just changed files: `t`/`msg`/`Trans`/`Plural` used
without an import (or, for `t`, without a `useLingui()` destructure) is a
ReferenceError at runtime that neither ESLint nor the tests catch.
"""
import re, pathlib, sys
SRC = pathlib.Path(__file__).resolve().parent.parent / 'src'
bad = []
for f in sorted(SRC.rglob('*.ts*')):
    if f.suffix not in ('.ts', '.tsx') or 'locales/' in str(f): continue
    raw = f.read_text(encoding='utf-8')
    # Comments mention `t\`` and `<Trans>` constantly in this codebase's docs
    # blocks; strip them or every explanatory comment reads as a usage.
    s = re.sub(r'/\*.*?\*/', '', raw, flags=re.S)
    s = re.sub(r'^\s*//.*$', '', s, flags=re.M)
    # strip comments + strings-that-aren't-macros cheaply
    imported = set()
    for m in re.finditer(r"import\s+\{([^}]*)\}\s+from\s+'@lingui/(?:core|react)/macro';", raw):
        imported |= {x.strip().split(' as ')[0] for x in m.group(1).split(',') if x.strip()}
    has_hook_t = re.search(r'const\s*\{[^}]*\bt\b[^}]*\}\s*=\s*useLingui\(\)', s) is not None
    for sym, pat in (('t', r'(?<![\w$.])t`'), ('msg', r'(?<![\w$.])msg`')):
        if re.search(pat, s):
            ok = sym in imported or (sym == 't' and has_hook_t)
            if not ok:
                bad.append((str(f.relative_to(SRC)), sym, len(re.findall(pat, s))))
    for comp in ('Trans', 'Plural'):
        if re.search(rf'<{comp}[\s/>]', s) and comp not in imported:
            if not re.search(rf"import\s+\{{[^}}]*\b{comp}\b[^}}]*\}}\s+from\s+'@lingui/react'", raw):
                bad.append((str(f.relative_to(SRC)), comp, len(re.findall(rf'<{comp}[\s/>]', s))))
for b in bad: print(f'  MISSING {b[1]:5} x{b[2]:<3} {b[0]}')
print(f'\n{len(bad)} files with a macro used but not in scope')
sys.exit(1 if bad else 0)
