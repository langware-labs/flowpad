import {
  connectionManager,
  copyToClipboard,
  dataManager,
  OAuthEventType,
  type OAuthDeviceFlowPayload,
} from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { useToast } from '@src/hooks/use-toast';
import { Copy, ExternalLink, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface LlmConfigMsg {
  message_type?: string;
  is_configured?: boolean;
  auth_method?: string;
  oauth_request_id?: string;
  status?: string;
}

function openExternal(url: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const electronAPI = (window as any).electronAPI;
  if (electronAPI?.openExternal) {
    void electronAPI.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Single global mount in App.tsx. Listens for `OAuthEventType.DEVICE_FLOW_START`
 * (currently fired only for GitHub) and renders a modal showing the user_code +
 * a button to open `verification_uri`. Auto-copies the code and opens the URL
 * on first render. Self-closes on `on_llm_config_msg` SUCCESS for the matching
 * `oauth_request_id`, or when the user hits Cancel.
 */
export function GitHubDeviceFlowModal() {
  const { toast } = useToast();
  const [payload, setPayload] = useState<OAuthDeviceFlowPayload | null>(null);
  const [remaining, setRemaining] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const openedRef = useRef<boolean>(false);

  // Listen for device-flow start events.
  useEffect(() => {
    const onStart = (p: OAuthDeviceFlowPayload) => {
      setPayload(p);
      setError(null);
      setRemaining(p.expires_in);
      openedRef.current = false;
    };
    dataManager.on(OAuthEventType.DEVICE_FLOW_START, onStart);
    return () => {
      dataManager.off(OAuthEventType.DEVICE_FLOW_START, onStart);
    };
  }, []);

  // Auto-copy + auto-open on first render of a new payload.
  useEffect(() => {
    if (!payload || openedRef.current) return;
    openedRef.current = true;
    void copyToClipboard(payload.user_code);
    openExternal(payload.verification_uri);
  }, [payload]);

  // Countdown to expiry.
  useEffect(() => {
    if (!payload) return;
    const tick = setInterval(() => {
      setRemaining((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(tick);
  }, [payload]);

  // Listen for the backend's broadcast — close on SUCCESS, surface ERROR.
  useEffect(() => {
    if (!payload) return;
    const handler = (msg: LlmConfigMsg) => {
      if (msg.auth_method !== 'github') return;
      if (msg.oauth_request_id && msg.oauth_request_id !== payload.state) return;
      if (msg.status === 'success') {
        toast({ title: 'GitHub connected', duration: 3000 });
        setPayload(null);
      } else if (msg.status === 'error') {
        setError('Authorization failed or was denied. Click Retry to try again.');
      }
    };
    connectionManager.on('on_llm_config_msg', handler);
    return () => {
      connectionManager.off('on_llm_config_msg', handler);
    };
  }, [payload, toast]);

  const handleCopy = useCallback(async () => {
    if (!payload) return;
    await copyToClipboard(payload.user_code);
    toast({ title: 'Code copied', duration: 1500 });
  }, [payload, toast]);

  const handleOpen = useCallback(() => {
    if (!payload) return;
    openExternal(payload.verification_uri);
  }, [payload]);

  const handleClose = useCallback(() => {
    setPayload(null);
    setError(null);
  }, []);

  if (!payload) return null;

  const expired = remaining <= 0;
  const mm = Math.floor(remaining / 60);
  const ss = (remaining % 60).toString().padStart(2, '0');

  return (
    <Dialog open onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect GitHub</DialogTitle>
          <DialogDescription>
            Enter the code below at <span className="font-mono">github.com/login/device</span> to authorize.
            We opened the page for you in a new tab.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-center rounded-md border border-border bg-muted/40 px-4 py-3">
            <span className="select-all font-mono text-2xl tracking-widest">{payload.user_code}</span>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              Copy code
            </Button>
            <Button variant="outline" size="sm" onClick={handleOpen}>
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Open github.com/login/device
            </Button>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : expired ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
              Code expired. Close and click Connect again to get a fresh code.
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Waiting for authorization… (expires in {mm}:{ss})
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default GitHubDeviceFlowModal;
