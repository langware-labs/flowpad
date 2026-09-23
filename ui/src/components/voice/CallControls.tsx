/**
 * Start a call on an owner's channels that take calls — one control per source, drawn from what
 * its driver declares (`DataDriver.calls`) and nothing else, so a new voice driver lights up here
 * without a frontend change:
 *
 * - `webrtc` — talk from this browser: microphone in, the agent's voice out (`useBrowserCall`);
 * - `clip`   — hand in a recorded sound file; the spoken answer comes back as a clip;
 * - `dial`   — a number the agent calls, with what the call is for.
 *
 * Whatever the control, the call lands in the owner's stream inbox as a conversation, live — the
 * control only starts it. Every start goes through the source's call route, never a provider URL.
 */
import { type ChangeEvent, useState } from 'react';
import { type CallStart, type DataDriver, type DataSource } from '@sdk';
import apiClient from '@sdk/client';
import { FileAudio, Mic, PhoneOff, PhoneOutgoing } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { cn } from '@src/lib/utils';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { useBrowserCall } from './use-browser-call';

type SpecFor = (provider: string) => DataDriver | undefined;

/** The glyph of the ACT of calling — how the call starts, not what kind of entity the source is. */
const START_ICON: Record<CallStart, typeof Mic> = { webrtc: Mic, clip: FileAudio, dial: PhoneOutgoing };

export function callableSources(rows: DataSource[], specFor: SpecFor): Array<{ source: DataSource; calls: CallStart }> {
  return rows.flatMap((source) => {
    const calls = specFor(source.provider)?.calls;
    return calls ? [{ source, calls }] : [];
  });
}

export function CallControls({ rows, specFor, className }: { rows: DataSource[]; specFor: SpecFor; className?: string }) {
  const callable = callableSources(rows, specFor);
  if (callable.length === 0) return null;
  return (
    <div className={cn('flex items-center gap-1', className)} data-testid="voice-call-controls">
      {callable.map(({ source, calls }) => (
        <CallControl key={source.id} source={source} calls={calls} />
      ))}
    </div>
  );
}

function CallControl({ source, calls }: { source: DataSource; calls: CallStart }) {
  const { t } = useLingui();
  const Icon = START_ICON[calls];
  const name = source.name || source.provider;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-full text-muted-foreground"
          aria-label={t`Call on ${name}`}
          data-testid="voice-call-button"
          data-calls={calls}
          data-source-id={source.id}
        >
          <Icon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" onFocusOutside={(e) => e.preventDefault()} data-testid="voice-call-panel">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{name}</div>
        {calls === 'webrtc' && <BrowserCallPanel source={source} />}
        {calls === 'clip' && <ClipPanel source={source} />}
        {calls === 'dial' && <DialPanel source={source} />}
      </PopoverContent>
    </Popover>
  );
}

function BrowserCallPanel({ source }: { source: DataSource }) {
  const { t } = useLingui();
  const { localUser } = useLocalUser();
  const caller = { id: localUser?.name || localUser?.id || 'you', name: localUser?.name };
  const call = useBrowserCall(source.id, caller);
  const inCall = call.state === 'mic' || call.state === 'connecting' || call.state === 'live';
  const label = {
    idle: t`Talk to the agent from this browser.`,
    mic: t`Asking for the microphone…`,
    connecting: t`Connecting…`,
    live: t`Live — speak now`,
    ended: t`Call ended.`,
    error: call.error ?? t`The call failed.`,
  }[call.state];
  return (
    <div className="space-y-2">
      <div className={cn('text-xs', call.state === 'error' ? 'text-destructive' : 'text-muted-foreground')} data-testid="voice-call-state" data-state={call.state}>
        {label}
      </div>
      {inCall ? (
        <Button variant="destructive" size="sm" onClick={call.end} data-testid="voice-call-end">
          <PhoneOff className="me-1 size-4" /> {t`End call`}
        </Button>
      ) : (
        <Button size="sm" onClick={() => void call.start()} data-testid="voice-call-start">
          <Mic className="me-1 size-4" /> {t`Start call`}
        </Button>
      )}
    </div>
  );
}

function useStartCall(source: DataSource) {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async (offer: Record<string, unknown>, done: (answer: Record<string, string>) => string) => {
    setBusy(true);
    setStatus(null);
    try {
      const answer = (await apiClient.post(`/api/v1/data_source/${source.id}/call`, { offer })) as unknown as Record<string, string>;
      setStatus({ ok: true, text: done(answer) });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return { status, busy, start };
}

function Status({ status }: { status: { ok: boolean; text: string } | null }) {
  if (!status) return null;
  return (
    <div className={cn('text-xs', status.ok ? 'text-muted-foreground' : 'text-destructive')} data-testid="voice-call-status" data-ok={status.ok}>
      {status.text}
    </div>
  );
}

function ClipPanel({ source }: { source: DataSource }) {
  const { t } = useLingui();
  const { localUser } = useLocalUser();
  const { status, busy, start } = useStartCall(source);
  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const audio_b64 = await toBase64(file);
    await start({ audio_b64, name: file.name, caller: localUser?.name || 'sound-file' }, () => t`Sent — the spoken answer lands in the conversation.`);
    event.target.value = '';
  };
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">{t`Hand the agent a recording; it answers with a spoken clip.`}</div>
      <Input type="file" accept="audio/*" disabled={busy} onChange={(e) => void onFile(e)} data-testid="voice-clip-input" />
      <Status status={status} />
    </div>
  );
}

function DialPanel({ source }: { source: DataSource }) {
  const { t } = useLingui();
  const [to, setTo] = useState('');
  const [brief, setBrief] = useState('');
  const { status, busy, start } = useStartCall(source);
  const dial = () => start({ to: to.trim(), brief: brief.trim() }, (answer) => t`Calling ${answer.to || to} — ${answer.status || 'queued'}`);
  return (
    <div className="space-y-2">
      <Input type="tel" placeholder="+972…" value={to} onChange={(e) => setTo(e.target.value)} data-testid="voice-dial-to" />
      <Textarea rows={2} placeholder={t`What is the call for? (optional)`} value={brief} onChange={(e) => setBrief(e.target.value)} data-testid="voice-dial-brief" />
      <Button size="sm" disabled={busy || !to.trim().startsWith('+')} onClick={() => void dial()} data-testid="voice-dial-call">
        <PhoneOutgoing className="me-1 size-4" /> {t`Call`}
      </Button>
      <Status status={status} />
    </div>
  );
}

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(file);
  });
}
