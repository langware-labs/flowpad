import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { LogIn } from 'lucide-react';
import { useState } from 'react';

interface JoinExistingSessionDialogProps {
  open: boolean;
  onClose: () => void;
}

export function JoinExistingSessionDialog({ open, onClose }: JoinExistingSessionDialogProps) {
  const [code, setCode] = useState('');

  const handleJoin = () => {
    if (!code.trim()) return;
    // TODO: navigate to session by code
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LogIn className="h-5 w-5 text-green-600" />
            Join a session
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <Input
            placeholder="Enter session code (e.g. XKCD-J3F2)"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') handleJoin(); }}
            className="font-mono tracking-widest text-center text-lg"
            autoFocus
          />
          <Button
            className="w-full bg-green-600 text-white hover:bg-green-700 transition-colors"
            onClick={handleJoin}
            disabled={!code.trim()}
          >
            Join session
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
