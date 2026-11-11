import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { FlowMessage, TypeId, isItKind, type Conversation } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';

/** A send with no operation name is an operation of its own, keyed by a random id: nothing to show for it. */
const UNNAMED = /^[0-9a-f]{32}$/;

/**
 * Beside an IT conversation's title: its operation id. Every request and every machine's answer carries it, so the
 * conversation's latest message names it. Nothing for any other conversation, or an IT one from before operations.
 */
export function ItOperationChip({ conv }: { conv: Conversation | null }) {
  const { t } = useLingui();
  const latestId = isItKind(conv?.kind) ? conv?.latestMessagePointer?.id : null;
  const latestTypeId = useMemo(() => (latestId ? new TypeId(FlowMessage.type, latestId) : null), [latestId]);
  const { data: latest } = useEntity<FlowMessage>(latestTypeId);
  const opId = latest?.it_request?.op_id ?? latest?.it_reply?.op_id ?? null;
  if (!opId || UNNAMED.test(opId)) return null;
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center rounded-full border border-border bg-muted/50 px-2 font-mono text-[10px] leading-none text-muted-foreground"
      title={t`The IT operation: every send under this name lands in this conversation.`}
      data-testid="it-operation-id"
    >
      {opId}
    </span>
  );
}
