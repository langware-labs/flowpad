import { ScrollArea } from '@src/components/ui/scroll-area';
import { Artifact, ArtifactType, MachineStatus } from '@sdk';
import { Server } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { WebappArtifactDetail } from './webapp-artifact-detail';

type ArtifactStatus = 'running' | 'stopped' | 'error';

interface WebappArtifactsTabProps {
  artifacts: Artifact[];
  machineStatus: MachineStatus | null;
}

// Get status color class based on artifact status
const getStatusColor = (status: ArtifactStatus): string => {
  switch (status) {
    case 'running':
      return 'bg-green-500';
    case 'error':
      return 'bg-red-500';
    case 'stopped':
      return 'bg-blue-500';
  }
};

export const WebappArtifactsTab: React.FC<WebappArtifactsTabProps> = ({ artifacts, machineStatus }) => {
  // Filter to webapp and app_service artifacts
  const serviceArtifacts = useMemo(() => {
    return artifacts.filter(
      (a) => a.artifact_type === ArtifactType.WEBAPP || a.artifact_type === ArtifactType.APP_SERVICE,
    );
  }, [artifacts]);

  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);

  // Auto-select first artifact when artifacts load
  useEffect(() => {
    if (!selectedArtifactId && serviceArtifacts.length > 0) {
      setSelectedArtifactId(serviceArtifacts[0].id || null);
    }
  }, [serviceArtifacts, selectedArtifactId]);

  const selectedArtifact = useMemo(() => {
    return serviceArtifacts.find((a) => a.id === selectedArtifactId) || null;
  }, [serviceArtifacts, selectedArtifactId]);

  // Get artifact status: running, stopped, or error
  const getArtifactStatus = (artifact: Artifact): ArtifactStatus => {
    if (!machineStatus || !artifact.port) {
      return 'stopped';
    }

    const port = parseInt(artifact.port, 10);
    const matchingConn = machineStatus.network.find((conn) => conn.port === port);
    const isRunning = !!matchingConn;

    if (isRunning) {
      // Check if health indicates error
      const health = artifact.health?.toLowerCase();
      if (health === 'error' || health === 'unhealthy' || health === 'failed') {
        return 'error';
      }
      return 'running';
    }

    // Not running - check if there's an error indicator
    const health = artifact.health?.toLowerCase();
    if (health === 'error' || health === 'unhealthy' || health === 'failed') {
      return 'error';
    }

    return 'stopped';
  };

  if (serviceArtifacts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Server className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p>No webapp or service artifacts found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Detail View (left - takes most space) */}
      <div className="flex-1 overflow-hidden border-r">
        {selectedArtifact ? (
          <WebappArtifactDetail artifact={selectedArtifact} machineStatus={machineStatus} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Select an artifact to view details
          </div>
        )}
      </div>

      {/* Artifact List (right) */}
      <div className="w-48 flex-shrink-0">
        <ScrollArea className="h-full">
          <div className="p-2">
            <h3 className="mb-2 px-2 text-xs font-medium text-muted-foreground">Artifacts</h3>
            {serviceArtifacts.map((artifact) => {
              const status = getArtifactStatus(artifact);
              const isSelected = artifact.id === selectedArtifactId;

              return (
                <button
                  key={artifact.id}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                    isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                  }`}
                  onClick={() => setSelectedArtifactId(artifact.id || null)}
                >
                  <div className={`h-2 w-2 rounded-full ${getStatusColor(status)}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{artifact.name || `Port ${artifact.port}`}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {artifact.artifact_type} • {artifact.port}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
};
