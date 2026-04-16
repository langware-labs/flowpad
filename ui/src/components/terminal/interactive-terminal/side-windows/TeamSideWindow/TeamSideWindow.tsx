import {
  AgenticProcess,
  TeamSession,
  dataManager,
  getOrCreateLocalMemberId,
  type TeamSessionMember,
} from '@sdk';
import { TypeId } from '@sdk';
import { useToast } from '@src/hooks/use-toast';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InviteByName } from './InviteByName';
import { JoinLinkSection } from './JoinLinkSection';
import { MembersList } from './MembersList';
import { StartCollaborationView } from './StartCollaborationView';

interface TeamSideWindowProps {
  agenticProcessId: string;
  defaultHostName?: string | null;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const REFRESH_INTERVAL_MS = 10_000;

export function TeamSideWindow({ agenticProcessId, defaultHostName }: TeamSideWindowProps) {
  const { toast } = useToast();
  const [teamSession, setTeamSession] = useState<TeamSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const localMemberId = getOrCreateLocalMemberId();
  const processRef = useRef<AgenticProcess | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const process = await dataManager.getByTypeId<AgenticProcess>(
        new TypeId('agentic_process', agenticProcessId),
      );
      if (cancelled) return;
      processRef.current = process ?? null;

      const match = await TeamSession.findByProcessId(agenticProcessId);
      if (cancelled) return;
      setTeamSession(match);
      setLoading(false);
    })().catch((err) => {
      if (!cancelled) {
        console.error('[TeamSideWindow] failed to load session', err);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [agenticProcessId]);

  // Heartbeat + refresh loop
  useEffect(() => {
    if (!teamSession) return;
    let stopped = false;

    const doHeartbeat = async () => {
      if (stopped || !teamSession) return;
      try {
        await teamSession.heartbeat(localMemberId);
        if (!stopped) setTick((t) => t + 1);
      } catch {
        // ignore transient failures
      }
    };

    void doHeartbeat();
    const hb = setInterval(() => void doHeartbeat(), HEARTBEAT_INTERVAL_MS);
    const refresh = setInterval(() => setTick((t) => t + 1), REFRESH_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(hb);
      clearInterval(refresh);
    };
  }, [teamSession, localMemberId]);

  const handleStart = useCallback(
    async (hostName: string) => {
      const process = processRef.current;
      if (!process) {
        toast({ title: 'Could not start', description: 'Process not available.' });
        return;
      }
      try {
        const ts = await process.createTeamSession(hostName, localMemberId);
        setTeamSession(ts);
        toast({ title: 'Collaboration started', description: `Share code ${ts.session_code} with participants.` });
      } catch (e) {
        console.error('[TeamSideWindow] createTeamSession failed', e);
        toast({ title: 'Could not start', description: String((e as Error).message ?? e) });
      }
    },
    [localMemberId, toast],
  );

  const handleInvite = useCallback(
    async (name: string) => {
      if (!teamSession) return;
      try {
        // Placeholder member — gets a fresh stub id; link sharing is the real flow.
        const placeholderId = `pending-${crypto.randomUUID()}`;
        await teamSession.join(placeholderId, name);
        setTick((t) => t + 1);
      } catch (e) {
        console.error('[TeamSideWindow] invite failed', e);
      }
    },
    [teamSession],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!teamSession) {
    return <StartCollaborationView defaultHostName={defaultHostName ?? null} onStart={handleStart} />;
  }

  const members: TeamSessionMember[] = teamSession.members ?? [];
  void tick; // ensure re-render on heartbeat/refresh tick

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <JoinLinkSection sessionCode={teamSession.session_code} joinUrl={teamSession.joinUrl} />
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-[11px] text-muted-foreground">Participants</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <MembersList
        members={members}
        hostMemberId={teamSession.host_member_id}
        currentMemberId={localMemberId}
      />
      <InviteByName onInvite={handleInvite} />
    </div>
  );
}
