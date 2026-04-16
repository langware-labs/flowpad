import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Users } from 'lucide-react';
import { useState } from 'react';

interface StartCollaborationViewProps {
  defaultHostName?: string | null;
  onStart: (hostName: string) => Promise<void> | void;
}

export function StartCollaborationView({ defaultHostName, onStart }: StartCollaborationViewProps) {
  const [hostName, setHostName] = useState(defaultHostName ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = hostName.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await onStart(trimmed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10 text-green-600">
        <Users className="h-6 w-6" />
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold text-foreground">Start a collaborative session</h3>
        <p className="text-sm text-muted-foreground max-w-xs">
          Share this process with participants. Once started, anyone with the link or code can join.
        </p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2 text-left">
        <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Your display name</label>
        <Input
          placeholder="e.g. Alex"
          value={hostName}
          onChange={(e) => setHostName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
      </div>
      <Button
        className="gap-2 bg-green-600 text-white hover:bg-green-700 disabled:opacity-60"
        onClick={() => void submit()}
        disabled={!hostName.trim() || busy}
      >
        <Users className="h-4 w-4" />
        {busy ? 'Starting…' : 'Start collaboration'}
      </Button>
    </div>
  );
}
