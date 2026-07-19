import { ServiceStatusLed } from '@src/components/machine-overview/service-status-led';
import PersistentIframe, { PersistentIframeHandle } from '@src/components/persistent-iframe';
import { WebappTerminalPanel } from '@src/components/webapp-viewer/webapp-terminal-panel';
import { useAgentContext } from '@src/contexts/agent-context';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { DockPointer, useDockNavigation } from '@src/navigation';
import { useProcessWebApp } from '@src/hooks/flow-hooks';
import { useViewerStore } from '@src/hooks/flow-hooks';
import { ViewType, WebappSubview } from '@sdk';
import { useContext as useSdkContext } from '@sdk/react/hooks';
import { hasElectronDisplayCapture } from '@src/components/display-toolbar/capture-region';
import { ExternalLink, ImagePlus, RefreshCw, Terminal } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';

interface WebappViewerProps {
  onWebappErrorRetry: (retryMessage: string) => void;
  onAnnotate?: (target: HTMLElement) => void;
}

export const WebappViewer: React.FC<WebappViewerProps> = ({ onWebappErrorRetry, onAnnotate }) => {
  const { t } = useLingui();
  const { flow } = useAgentContext();
  const { isDesktop } = useSdkContext();
  const { currentContext } = useViewerStore();
  const { navigation, currentDock } = useDockNavigation();
  const [webAppError, setWebAppError] = useState<string | undefined>();
  const iframeRef = useRef<PersistentIframeHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Derive panel visibility and active tab from URL pointer
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

  // A web preview is a concrete running-process concern. The port arrives in
  // the URL-derived viewer context; logical Artifacts no longer carry it.
  const webAppPort = currentContext?.viewerOptions?.port ?? null;

  const webAppConfig = useProcessWebApp(flow, webAppPort);

  const onWebAppError = useCallback((error: Error) => {
    setWebAppError(error.message);
  }, []);

  useEffect(() => {
    setWebAppError('');
  }, [webAppConfig.cacheKey]);

  const handleErrorRetry = useCallback(() => {
    const retryMessage =
      t`The web app is not working, please try to fix it.` + (webAppError ? `\n\nError: ${webAppError}` : '');
    onWebappErrorRetry(retryMessage);
  }, [t, webAppError, onWebappErrorRetry]);

  const handleRefresh = useCallback(() => {
    iframeRef.current?.refresh();
  }, []);

  const handleOpenInNewTab = useCallback(() => {
    if (webAppConfig.host) {
      window.open(webAppConfig.host, '_blank');
    }
  }, [webAppConfig.host]);

  const hasWebApp = Boolean(webAppConfig.host);
  const showAnnotate = !!onAnnotate && isDesktop && hasElectronDisplayCapture();

  return (
    <div className="relative h-full w-full">
      <div className="flex h-9 items-center justify-between gap-1 border-b bg-muted/30 px-2">
        {/* Left side: Webapp selector and status LED */}
        <div className="flex items-center gap-2">
          {webAppPort ? (
            <>
              <span className="font-mono text-xs text-muted-foreground">localhost:{webAppPort}</span>
              <ServiceStatusLed />
            </>
          ) : (
            <span className="text-xs text-muted-foreground"><Trans>No runtime port in this view</Trans></span>
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
            <Tooltip>
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
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
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
                  onClick={handleOpenInNewTab}
                  disabled={!hasWebApp}
                >
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
                <p><Trans>Open in new tab</Trans></p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      <div ref={contentRef} className="relative flex h-[calc(100%-36px)] w-full flex-col">
        {/* Main content area - iframe or placeholder */}
        <div className={`relative w-full ${showPanel ? 'h-[60%]' : 'h-full'}`}>
          {hasWebApp ? (
            <PersistentIframe
              ref={iframeRef}
              src={webAppConfig.host}
              cacheKey={webAppConfig.cacheKey}
              onErrorRetry={handleErrorRetry}
              onError={onWebAppError}
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
