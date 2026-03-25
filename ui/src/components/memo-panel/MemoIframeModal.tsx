import { useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { mcpUIManager, type MCPUIComponent } from '@sdk';
import { generateMemoPanelHTML } from './memo-panel-html';

interface MemoIframeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiUrl: string;
}

export function MemoIframeModal({ open, onOpenChange, apiUrl }: MemoIframeModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const componentRef = useRef<MCPUIComponent | null>(null);
  const uriRef = useRef(`ui://memo-panel/main-${Date.now()}`);

  useEffect(() => {
    if (!open) return;

    // Use a small timeout to ensure the Dialog DOM has rendered
    const id = setTimeout(() => {
      if (!containerRef.current) return;

      const uri = uriRef.current;
      const html = generateMemoPanelHTML(apiUrl);

      void mcpUIManager.loadWithHTML(uri, html, {
        hostContext: { theme: 'light', displayMode: 'modal' },
        sandboxPermissions: ['allow-scripts'],
        initTimeout: 20_000,
      }).then((component) => {
        componentRef.current = component;
        if (containerRef.current) {
          void component.show({ viewer: containerRef.current });
        }
      }).catch((err) => {
        console.error('[MemoIframeModal] Failed to load component:', err);
      });
    }, 50);

    return () => {
      clearTimeout(id);
      const uri = uriRef.current;
      void mcpUIManager.closeComponent(uri).catch(() => {});
      componentRef.current = null;
      // Generate a new URI for next open so we get a fresh iframe
      uriRef.current = `ui://memo-panel/main-${Date.now()}`;
    };
  }, [open, apiUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" style={{ height: 560 }}>
        <DialogHeader>
          <DialogTitle>Memo Panel</DialogTitle>
        </DialogHeader>
        <div
          ref={containerRef}
          className="flex-1 w-full overflow-hidden rounded"
          style={{ height: 460 }}
          data-testid="memo-iframe-container"
        />
      </DialogContent>
    </Dialog>
  );
}
