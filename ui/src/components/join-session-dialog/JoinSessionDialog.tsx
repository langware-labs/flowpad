import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { useToast } from '@src/hooks/use-toast';
import { Check, Copy, Link, Mail, Users } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

interface JoinSessionDialogProps {
  open: boolean;
  onClose: () => void;
  hostName?: string;
}

function generateSessionCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase() +
    '-' +
    Math.random().toString(36).slice(2, 6).toUpperCase();
}

export function JoinSessionDialog({ open, onClose, hostName }: JoinSessionDialogProps) {
  const { toast } = useToast();
  const sessionCode = useMemo(generateSessionCode, [open]);
  const sessionLink = `${window.location.origin}/join/${sessionCode.replace('-', '').toLowerCase()}`;

  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);

  const handleCopyLink = useCallback(() => {
    void navigator.clipboard.writeText(sessionLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: 'Link copied', description: 'Share it with anyone you want to collaborate with.' });
  }, [sessionLink, toast]);

  const handleInvite = useCallback(async () => {
    if (!email.trim()) return;
    setSending(true);
    await new Promise((r) => setTimeout(r, 800)); // placeholder
    toast({ title: 'Invite sent', description: `Invitation sent to ${email}` });
    setEmail('');
    setSending(false);
  }, [email, toast]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-green-600" />
            Collaborative session
          </DialogTitle>
        </DialogHeader>

        {/* Session code badge */}
        <div className="flex flex-col items-center gap-1 rounded-xl bg-muted/50 py-6">
          <p className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Session code</p>
          <span className="font-mono text-3xl font-bold tracking-widest text-foreground">{sessionCode}</span>
          {hostName && (
            <p className="mt-2 text-xs text-muted-foreground">Hosted by <span className="font-medium text-foreground">{hostName}</span></p>
          )}
        </div>

        {/* Copy link */}
        <div className="flex gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground truncate">
            <Link className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{sessionLink}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={handleCopyLink}
          >
            {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied!' : 'Copy'}
          </Button>
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">or invite by email</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        {/* Email invite */}
        <div className="flex gap-2">
          <Input
            type="email"
            placeholder="colleague@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleInvite(); }}
            className="flex-1"
          />
          <Button
            className="shrink-0 gap-1.5 bg-green-600 text-white hover:bg-green-700"
            onClick={() => void handleInvite()}
            disabled={!email.trim() || sending}
          >
            <Mail className="h-4 w-4" />
            {sending ? 'Sending…' : 'Invite'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
