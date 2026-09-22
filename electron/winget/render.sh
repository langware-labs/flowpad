#!/usr/bin/env bash
# Render the winget manifests for one release into <outdir>/manifests/l/Langware/Flowpad/<version>/.
# usage: render.sh <version> <tag> <installer-file-name> <sha256> <yyyy-mm-dd> <outdir>
set -euo pipefail
VERSION="$1"; TAG="$2"; INSTALLER="$3"; SHA256="$4"; DATE="$5"; OUT="$6"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version: $VERSION" >&2; exit 1; }
[[ "$SHA256" =~ ^[0-9A-Fa-f]{64}$ ]] || { echo "bad sha256: $SHA256" >&2; exit 1; }
[[ "$INSTALLER" =~ ^[A-Za-z0-9._-]+\.exe$ ]] || { echo "bad installer name: $INSTALLER" >&2; exit 1; }
DIR="$OUT/manifests/l/Langware/Flowpad/$VERSION"
mkdir -p "$DIR"
for f in "$(dirname "$0")"/template/*.yaml; do
  sed -e "s|__VERSION__|$VERSION|g" -e "s|__TAG__|$TAG|g" -e "s|__INSTALLER__|$INSTALLER|g" \
      -e "s|__SHA256__|$(echo "$SHA256" | tr 'a-f' 'A-F')|g" -e "s|__DATE__|$DATE|g" "$f" > "$DIR/$(basename "$f")"
done
if grep -rq "__[A-Z0-9]*__" "$DIR"; then echo "unrendered placeholder in $DIR" >&2; grep -rn "__[A-Z0-9]*__" "$DIR" >&2; exit 1; fi
echo "$DIR"
