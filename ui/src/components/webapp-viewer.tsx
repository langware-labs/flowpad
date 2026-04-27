import { ServiceStatusLed } from '@src/components/machine-overview/service-status-led';
import PersistentIframe, { PersistentIframeHandle } from '@src/components/persistent-iframe';
import { WebappTerminalPanel } from '@src/components/webapp-viewer/webapp-terminal-panel';
import { useAgentContext } from '@src/contexts/agent-context';
import { Button } from '@src/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { DockPointer, useDockNavigation } from '@src/navigation';
import { useCurrentArtifacts } from '@src/hooks/flow-hooks';
import { useProcessWebApp } from '@src/hooks/flow-hooks';
import { useViewerStore } from '@src/hooks/flow-hooks';
import { ArtifactType, MachineStatus, ViewType, WebappSubview } from '@sdk';
import { ExternalLink, RefreshCw, Terminal } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface WebappViewerProps {
  onWebappErrorRetry: (retryMessage: string) => void;
}

export const WebappViewer: React.FC<WebappViewerProps> = ({ onWebappErrorRetry }) => {
  const { flow } = useAgentContext();
  const { currentContext } = useViewerStore();
  const { navigation, currentDock } = useDockNavigation();
  const [webAppError, setWebAppError] = useState<string | undefined>();
  const [selectedWebappId, setSelectedWebappId] = useState<string>('');
  const [machineStatus, setMachineStatus] = useState<MachineStatus | null>(null);
  const iframeRef = useRef<PersistentIframeHandle>(null);

  // Derive panel visibility and active tab from URL pointer
  const subview = currentDock?.pointer as WebappSubview | undefined;
  const showPanel = subview === WebappSubview.SHELL || subview === WebappSubview.ARTIFACTS;
  const activeTab = subview || WebappSubview.SHELL;

  // Navigate to show shell panel (used by ServiceStatusLed on restart)
  const handleShowShell = useCallback(() => {
    navigation.openDock(new DockPointer(ViewType.WEB_APP, WebappSubview.SHELL));
  }, [navigation]);

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

  // Get all artifacts and filter to webapps only
  const { data: artifacts = [] } = useCurrentArtifacts();
  const webappArtifacts = useMemo(() => {
    return artifacts.filter((a) => a.artifact_type === ArtifactType.WEBAPP);
  }, [artifacts]);

  // Determine which port to use: selected webapp, context port, or latest webapp
  const webAppPort = useMemo(() => {
    // First priority: port from viewer context (e.g., clicked from chat)
    if (currentContext?.viewerOptions?.port) {
      return currentContext.viewerOptions.port;
    }

    // Second priority: selected webapp from dropdown
    if (selectedWebappId !== '') {
      const selectedWebapp = webappArtifacts.find((a) => a.id === selectedWebappId);
      const port = selectedWebapp?.metadata?.port as number | string | undefined;
      if (port !== undefined && port !== null) {
        return String(port);
      }
    }

    // Third priority: latest webapp artifact
    if (webappArtifacts.length > 0) {
      const latestWebapp = webappArtifacts[0]; // Already sorted by newest first
      const port = latestWebapp?.metadata?.port as number | string | undefined;
      if (port !== undefined && port !== null) {
        return String(port);
      }
    }

    return null;
  }, [currentContext, selectedWebappId, webappArtifacts]);

  // Auto-select the latest webapp when artifacts change and nothing is selected
  useEffect(() => {
    if (selectedWebappId === '' && webappArtifacts.length > 0 && webappArtifacts[0].id) {
      setSelectedWebappId(webappArtifacts[0].id);
    }
  }, [webappArtifacts, selectedWebappId]);

  const webAppConfig = useProcessWebApp(flow, webAppPort);

  const onWebAppError = useCallback((error: Error) => {
    setWebAppError(error.message);
  }, []);

  useEffect(() => {
    setWebAppError('');
  }, [webAppConfig.cacheKey]);

  const handleErrorRetry = useCallback(() => {
    const retryMessage =
      'The web app is not working, please try to fix it.' + (webAppError ? `\n\nError: ${webAppError}` : '');
    onWebappErrorRetry(retryMessage);
  }, [webAppError, onWebappErrorRetry]);

  const handleRefresh = useCallback(() => {
    iframeRef.current?.refresh();
  }, []);

  const handleOpenInNewTab = useCallback(() => {
    if (webAppConfig.host) {
      window.open(webAppConfig.host, '_blank');
    }
  }, [webAppConfig.host]);

  const hasWebApp = Boolean(webAppConfig.host);

  const handleWebappSelect = useCallback((value: string) => {
    setSelectedWebappId(value);
  }, []);

  return (
    <div className="relative h-full w-full">
      <div className="flex h-9 items-center justify-between gap-1 border-b bg-muted/30 px-2">
        {/* Left side: Webapp selector and status LED */}
        <div className="flex items-center gap-2">
          {webappArtifacts.length > 0 ? (
            <>
              <Select value={selectedWebappId} onValueChange={handleWebappSelect}>
                <SelectTrigger className="h-7 w-48 text-xs">
                  <SelectValue placeholder="Select webapp..." />
                </SelectTrigger>
                <SelectContent>
                  {webappArtifacts.map((webapp) => {
                    const port = webapp.metadata?.port as number | string | undefined;
                    const portStr = port !== undefined && port !== null ? String(port) : 'unknown';
                    return (
                      <SelectItem key={webapp.id} value={webapp.id || ''} className="text-xs">
                        {webapp.name ? `${webapp.name} (${portStr})` : `Port ${portStr}`}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <ServiceStatusLed onShowShell={handleShowShell} onRefreshWebapp={handleRefresh} onStatusChange={setMachineStatus} />
            </>
          ) : (
            <span className="text-xs text-muted-foreground">Webapp not found in artifacts</span>
          )}
        </div>

        {/* Right side: Action buttons */}
        <div className="flex items-center gap-1">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-7 w-7 ${showPanel ? 'bg-green-500/20 text-green-600 hover:bg-green-500/30 hover:text-green-600' : ''}`}
                  onClick={handleTogglePanel}
                >
                  <Terminal className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
                <p>{showPanel ? 'Hide panel' : 'Show panel'}</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleRefresh} disabled={!hasWebApp}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
                <p>Refresh</p>
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
                <p>Open in new tab</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      <div className="relative flex h-[calc(100%-36px)] w-full flex-col">
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
            <div className="flex h-full items-center justify-center text-muted-foreground">No web app available</div>
          )}
        </div>

        {/* Tabbed panel at bottom */}
        {showPanel && (
          <div className="h-[40%] w-full border-t bg-background">
            <WebappTerminalPanel
              flow={flow ?? null}
              artifacts={artifacts}
              machineStatus={machineStatus}
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
