import { User } from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Chip } from '../label-chip';

interface UserInfoProps {
  user: User;
}

export function UserInfo({ user }: UserInfoProps) {
  const [copied, setCopied] = useState(false);
  const { version } = useContext();

  const handleCopyUserId = async () => {
    try {
      await navigator.clipboard.writeText(user.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-semibold text-muted-foreground">Name:</label>
        <div className="text-base">{user.displayName}</div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-semibold text-muted-foreground">Email:</label>
        <div className="text-base">{user.email || 'N/A'}</div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-semibold text-muted-foreground">User ID:</label>
        <div className="flex items-center gap-2">
          <div className="font-mono text-sm text-muted-foreground">{user.id}</div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => {
              void handleCopyUserId();
            }}
          >
            {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
          </Button>
        </div>
      </div>

      {user.picture && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">Profile Picture:</label>
          <img src={user.picture} alt="Profile" className="h-16 w-16 rounded-full border-2 object-cover" />
        </div>
      )}

      {user.last_login && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">Last Login:</label>
          <div className="text-base">{new Date(user.last_login).toLocaleString()}</div>
        </div>
      )}

      {version && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">Version:</label>
          <div className="font-mono text-sm text-muted-foreground">v{version}</div>
        </div>
      )}

      {user.labels && user.labels.length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">Labels:</label>
          <div className="flex flex-wrap gap-2">
            {user.labels.map((label) => (
              <Chip key={label} label={label} selected={false} onClick={() => {}} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
