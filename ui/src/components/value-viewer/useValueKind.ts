import { FSRef } from '@sdk';
import { Braces, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AssetEditor, LOCAL_COMPUTE_NODE, editorForPath } from '@src/navigation/asset-doc-types';
import { humanizeType } from '@src/utils/humanize';
import { readValue } from './ValueViewer';

/** How a chip shows one value of a kind: the value glyph and the kind as words. */
export function valueKindMeta(kind: string): { Icon: LucideIcon; label: string } {
  return { Icon: Braces, label: humanizeType(kind.replace(/\./g, ' ')) };
}

// A value file's kind never changes under the same path: read each once, keep only the kind.
const kinds = new Map<string, Promise<string | null>>();

function kindOf(path: string): Promise<string | null> {
  let kind = kinds.get(path);
  if (!kind) {
    kind = new FSRef(path, LOCAL_COMPUTE_NODE)
      .read()
      .then((text) => readValue(text).kind)
      .catch(() => null);
    kinds.set(path, kind);
  }
  return kind;
}

/** The kind a local value file (`*.value.json`) carries in its `spec_kind`; null while it is read,
 *  and for any other file, which is never read. */
export function useValueKind(localPath: string | null | undefined): string | null {
  const [kind, setKind] = useState<string | null>(null);
  useEffect(() => {
    setKind(null);
    if (!localPath || editorForPath(localPath) !== AssetEditor.VALUE) return;
    let current = true;
    void kindOf(localPath).then((k) => current && setKind(k));
    return () => {
      current = false;
    };
  }, [localPath]);
  return kind;
}
