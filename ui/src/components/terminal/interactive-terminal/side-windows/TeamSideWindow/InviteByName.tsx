import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';

interface InviteByNameProps {
  onInvite: (name: string) => Promise<void> | void;
}

export function InviteByName({ onInvite }: InviteByNameProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await onInvite(trimmed);
      setName('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Add participant</label>
      <div className="flex gap-2">
        <Input
          placeholder="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          className="flex-1"
        />
        <Button
          className="shrink-0 gap-1.5"
          onClick={() => void submit()}
          disabled={!name.trim() || busy}
        >
          <UserPlus className="h-4 w-4" />
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Placeholder entry — the invited member becomes real when they open the join link.
      </p>
    </div>
  );
}
