import { Agent, TypeId } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useState } from 'react';
import { Inbox, Plus } from 'lucide-react';

import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { isMessageDriverSpec } from '@src/components/data-sources/use-source-specs';
import { useSourceDelete } from '@src/components/data-sources/use-source-delete';
import { ChannelList, useAttachedChannels } from '@src/components/inbox-view/AttachedChannelsBar';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * Every message source this agent is connected to — email, Slack, … — with its
 * on/off switch and delete. The same rows as the inbox's channel marks, owned by
 * the agent; "Add channel" attaches a new one to it.
 */
export function AgentPlaceChannels({ agent }: { agent: Agent }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const owner = useMemo(() => new TypeId(Agent.type, agent.id), [agent.id]);
  const { rows, specFor } = useAttachedChannels(owner);
  const [addOpen, setAddOpen] = useState(false);
  const { deleting, setDeleting, remove, confirm } = useSourceDelete();

  return (
    <div className="flex flex-col gap-2" data-testid="agent-place-channels">
      <ChannelList title={t`Channels`} sources={rows} specFor={specFor} onDelete={setDeleting} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)} data-testid="agent-place-add-channel">
          <Plus className="me-1.5 h-3.5 w-3.5" />
          <Trans>Add channel</Trans>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => navigation.openDock(DockPointer.forAgentInbox(agent.id))}
          data-testid="agent-place-open-inbox"
        >
          <Inbox className="me-1.5 h-3.5 w-3.5" />
          <Trans>Inbox</Trans>
        </Button>
      </div>
      {addOpen && <DataSourceDialog open onOpenChange={setAddOpen} owner={owner} only={isMessageDriverSpec} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(next) => !next && setDeleting(null)}
        variant="destructive"
        {...confirm}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </div>
  );
}
