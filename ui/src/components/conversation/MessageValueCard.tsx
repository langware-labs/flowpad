import { useEffect, useState, type ReactNode } from 'react';
import { FSRef } from '@sdk';
import { KindValue } from '@src/components/value-viewer/KindValue';
import { readValue } from '@src/components/value-viewer/ValueViewer';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';

type Shown = { kind: string; value: unknown };

// A message's card file is written once: read each path once (as `useValueKind` keeps a kind).
const cards = new Map<string, Promise<Shown | null>>();

function cardAt(path: string): Promise<Shown | null> {
  let card = cards.get(path);
  if (!card) {
    card = new FSRef(path, LOCAL_COMPUTE_NODE)
      .read()
      .then((text) => readValue(text))
      .catch(() => null);
    cards.set(path, card);
  }
  return card;
}

/**
 * A message drawn by the value it carries: its `card.value.json` (`CARD_FILE`), shown in place by that
 * kind's viewer (the generic one else). `fallback` — the message's text — shows while the file is read
 * and when it cannot be.
 */
export function MessageValueCard({ localPath, fallback }: { localPath: string; fallback?: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    let current = true;
    setShown(null);
    void cardAt(localPath).then((card) => current && setShown(card));
    return () => {
      current = false;
    };
  }, [localPath]);
  if (!shown) return <>{fallback}</>;
  return <KindValue kind={shown.kind} value={shown.value} testId="message-value-card" />;
}
