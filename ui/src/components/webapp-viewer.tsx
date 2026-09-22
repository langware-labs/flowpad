import { openExternal } from '@src/lib/open-external';
import type { PersistentIframeHandle } from '@src/components/persistent-iframe';
import { WebUrlDisplay } from '@src/components/web-url-display/WebUrlDisplay';
import { WebappTerminalPanel } from '@src/components/webapp-viewer/webapp-terminal-panel';
import { useAgentContext } from '@src/contexts/agent-context';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { DockPointer, useDockNavigation } from '@src/navigation';
import { requestTabClose } from '@src/tabs/tab-close-request';
import { ViewType, WebappSubview } from '@sdk';
import { useContext as useSdkContext } from '@sdk/react/hooks';
import { hasElectronDisplayCapture } from '@src/components/display-toolbar/capture-region';
import { Check, Copy, ExternalLink, ImagePlus, RefreshCw, Terminal } from 'lucide-react';
import { useCopied } from '@src/components/ui/copy-button';
import React, { useCallback, useRef } from 'react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';

interface WebappViewerProps {
  onAnnotate?: (target: HTMLElement) => void;
}

/**
 * A web page by its URL (`/dock/web-app?url=…`) — an external site, or anything
 * else addressed only by where it lives. A running app is NOT shown here: it is
 * addressed by what serves it and rendered by the app dock (`AppDisplayViewer`).
 */
export const WebappViewer: React.FC<WebappViewerProps> = ({ onAnnotate }) => {
  const { t } = useLingui();
  const { flow } = useAgentContext();
  const { isDesktop } = useSdkContext();
  const { navigation, currentDock } = useDockNavigation();
  const iframeRef = useRef<PersistentIframeHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Derive panel visibility and active tab from URL pointer
  const webUrl = currentDock?.webUrl ?? null;
  const subview = currentDock?.pointer as WebappSubview | undefined;
  const showPanel = subview === WebappSubview.SHELL || subview === WebappSubview.ARTIFACTS;
  const activeTab = subview || WebappSubview.SHELL;

  // Toggle panel visibility via navigation
  const handleTogglePanel = useCallback(() => {
    if (showPanel) {
      // Close panel - navigate to web-app without pointer
      navigation.openDock(DockPointer.forTab(ViewType.WEB_APP));
    } else {
      // Open panel - navigate to web-app with shell subview
      navigation.openDock(new DockPointer(ViewType.WEB_APP, WebappSubview.SHELL));
    }
  }, [navigation, showPanel]);

  // Handle tab change via navigation
  const handleTabChange = useCallback(
    (tab: WebappSubview) => {
      navigation.openDock(new DockPointer(ViewType.WEB_APP, tab));
    },
    [navigation],
  );

  const src = webUrl;

  const handleRefresh = useCallback(() => {
    iframeRef.current?.refresh();
  }, []);

  const handleOpenInNewTab = useCallback(() => {
    if (src) openExternal(src);
  }, [src]);

  // The warning's "Open in browser" leaves nothing to look at here: close this tab.
  const tabHash = currentDock?.tabHash;
  const handleOpenedInBrowser = useCallback(() => void requestTabClose(tabHash), [tabHash]);

  const { copied, copy } = useCopied();
  const handleCopyUrl = useCallback(() => {
    if (src) void copy(src);
  }, [copy, src]);

  const hasWebApp = Boolean(src);
  const showAnnotate = !!onAnnotate && isDesktop && hasElectronDisplayCapture();

  return (
    <div className="relative h-full w-full">
      <div className="flex h-9 items-center justify-between gap-1 border-b bg-muted/30 px-2">
        {/* Left side: Webapp selector and status LED */}
        <div className="flex items-center gap-2">
          {webUrl ? (
            <span className="truncate font-mono text-xs text-muted-foreground" title={webUrl}>{webUrl}</span>
          ) : (
            <span className="text-xs text-muted-foreground"><Trans>No web page in this view</Trans></span>
          )}
        </div>

        {/* Right side: Action buttons */}
        <div className="flex items-center gap-1">
          <TooltipProvider delayDuration={300}>
            {showAnnotate && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    data-testid="webapp-viewer-annotate-view"
                    aria-label={t`Annotate view`}
                    title={t`Annotate view`}
                    onClick={() => {
                      if (contentRef.current) onAnnotate(contentRef.current);
                    }}
                  >
                    <ImagePlus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
                  <p><Trans>Annotate view</Trans></p>
                </TooltipContent>
              </Tooltip>
            )}
            {!webUrl && <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-7 w-7 ${
                    showPanel ? 'bg-green-500/20 text-green-600 hover:bg-green-500/30 hover:text-green-600' : ''
                  }`}
                  onClick={handleTogglePanel}
                >
                  <Terminal className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
                <p>{showPanel ? <Trans>Hide panel</Trans> : <Trans>Show panel</Trans>}</p>
              </TooltipContent>
            </Tooltip>}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t`Copy URL`}
                  data-testid="webapp-viewer-copy-url"
                  onClick={handleCopyUrl}
                  disabled={!hasWebApp}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
                <p>{copied ? <Trans>Copied</Trans> : <Trans>Copy URL</Trans>}</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t`Refresh`}
                  onClick={handleRefresh}
                  disabled={!hasWebApp}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
                <p><Trans>Refresh</Trans></p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t`Open in browser`}
                  onClick={handleOpenInNewTab}
                  disabled={!hasWebApp}
                >
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
                <p><Trans>Open in browser</Trans></p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      <div ref={contentRef} className="relative flex h-[calc(100%-36px)] w-full flex-col">
        {/* Main content area - iframe or placeholder */}
        <div className={`relative w-full ${showPanel ? 'h-[60%]' : 'h-full'}`}>
          {webUrl ? (
            <WebUrlDisplay
              ref={iframeRef}
              url={webUrl}
              testId="web-url-frame"
              onOpenedInBrowser={handleOpenedInBrowser}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground"><Trans>No web app available</Trans></div>
          )}
        </div>

        {/* Tabbed panel at bottom */}
        {showPanel && (
          <div className="h-[40%] w-full border-t bg-background">
            <WebappTerminalPanel
              flow={flow ?? null}
              isActive={showPanel}
              activeTab={activeTab}
              onTabChange={handleTabChange}
            />
          </div>
        )}
      </div>
    </div>
  );
};
