#!/bin/bash
#
# Set the release version AND roll the open migration slot, in one step.
#
# Usage: ./scripts/bump_version.sh X.Y.Z
#
# Every version bump goes through this script — deploy_to_github.sh, the
# deploy-pypi skill, and a hand-made "bump version" PR alike. Writing
# _version.py on its own strands the open slot and turns
# tests/unit/test_migration_recipes_ship_with_their_version.py red (PR #682,
# PR #688).
#
# `run_if_needed` resolves a recipe under the RUNNING version's own directory,
# so a migration is only ever reached by installs of the version it ships in.
# That makes the directory named after the NEXT version the only reachable
# place to write one — and a release consumes it:
#
#   1. The pending slot (the one above the current version) moves onto the new
#      version. On a patch bump it is already named that; on a minor/major bump
#      it names a version that will never ship.
#   2. The new version's slot is DELETED if nothing was written into it. An
#      empty slot that ships reads as a recipe its own wheel never carried.
#   3. The next slot is opened, so the next migration has somewhere to live.
#
# Only the working tree is changed; the caller stages and commits.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"

VERSION_FILE="flow_sdk/_version.py"
MIGRATIONS_DIR="flow_sdk/system_projects/flowpad_assistant/migrations"

NEW="$1"
if [[ ! "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Usage: $0 X.Y.Z" >&2
    exit 1
fi

OLD=$(grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' "$VERSION_FILE" | tr -d '"')
if [[ "$NEW" == "$OLD" || "$(printf '%s\n' "$OLD" "$NEW" | sort -V | tail -1)" != "$NEW" ]]; then
    echo "Error: $NEW is not above the current version $OLD" >&2
    exit 1
fi

IFS='.' read -r major minor patch <<< "$NEW"
NEXT="${major}.${minor}.$((patch + 1))"

echo "__version__ = \"${NEW}\"" > "$VERSION_FILE"

# 1. Move the pending slot onto $NEW.
for d in $(ls "$MIGRATIONS_DIR"); do
    [[ "$d" != "$OLD" && "$(printf '%s\n' "$OLD" "$d" | sort -V | tail -1)" == "$d" ]] || continue
    [[ "$d" == "$NEW" ]] && continue
    if [[ -e "${MIGRATIONS_DIR}/${NEW}" ]]; then
        echo "Error: two pending migration slots ($d, $NEW) — merge them by hand" >&2
        exit 1
    fi
    mv "${MIGRATIONS_DIR}/${d}" "${MIGRATIONS_DIR}/${NEW}"
done

# 2. Retire $NEW's slot if nothing was written into it.
released_dir="${MIGRATIONS_DIR}/${NEW}"
if [[ -d "$released_dir" ]] \
   && [[ ! -f "${released_dir}/scripts/migrate.py" ]] \
   && [[ ! -f "${released_dir}/skill/SKILL.md" ]]; then
    echo "Retiring empty migration slot ${NEW} (nothing was written into it)"
    rm -rf "$released_dir"
fi

# 3. Open $NEXT.
next_dir="${MIGRATIONS_DIR}/${NEXT}"
if [[ -d "$next_dir" ]]; then
    exit 0
fi

echo "Opening migration slot ${NEXT}"
mkdir -p "$next_dir"
cat > "${next_dir}/README.md" <<EOF
# ${NEXT} — the open slot

This directory is the next UNRELEASED recipe version: the only place a new
migration can be added and still be reached. It is created by
scripts/bump_version.sh when ${NEW} is cut; do not hand-author it.

\`run_if_needed\` resolves a recipe under the RUNNING version's own directory,
so a recipe committed after its version was built is never found by any install
— that version is gone, and every later release looks under its own directory.
A migration written here ships in the ${NEXT} wheel and runs on upgrade to it.

Add one as \`scripts/migrate.py\` with a \`run()\` entry point, or as
\`skill/SKILL.md\` for an agent-driven recipe. Until then \`_resolve_recipe\`
returns None for this version — "nothing to do" — which is correct.

If this slot is still empty when ${NEXT} is released, scripts/bump_version.sh
deletes it rather than shipping a directory with no recipe in it.
EOF
