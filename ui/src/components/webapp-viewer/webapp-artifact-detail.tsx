import { Badge } from '@src/components/ui/badge';
import { Artifact, MachineStatus, ProcessInfo } from '@sdk';
import React, { useMemo } from 'react';

type ArtifactStatus = 'running' | 'stopped' | 'error';

interface WebappArtifactDetailProps {
  artifact: Artifact;
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

export const WebappArtifactDetail: React.FC<WebappArtifactDetailProps> = ({ artifact, machineStatus }) => {
  // Check if port is listening in network connections
  const networkConnection = useMemo(() => {
    if (!machineStatus || !artifact.port) return null;
    const port = parseInt(artifact.port, 10);
    return machineStatus.network.find((conn) => conn.port === port) || null;
  }, [machineStatus, artifact.port]);

  // Try to find process info (may not exist if not in top 50 by CPU)
  const processInfo: ProcessInfo | null = useMemo(() => {
    if (!networkConnection) return null;
    return machineStatus?.processes.find((proc) => proc.pid === networkConnection.pid) || null;
  }, [machineStatus, networkConnection]);

  // Service is running if we have process info for the network connection
  const isRunning = processInfo !== null;

  // Get artifact status: running, stopped, or error
  const status: ArtifactStatus = useMemo(() => {
    if (isRunning) {
      const health = artifact.health?.toLowerCase();
      if (health === 'error' || health === 'unhealthy' || health === 'failed') {
        return 'error';
      }
      return 'running';
    }
    const health = artifact.health?.toLowerCase();
    if (health === 'error' || health === 'unhealthy' || health === 'failed') {
      return 'error';
    }
    return 'stopped';
  }, [isRunning, artifact.health]);
  const metadata = artifact.metadata || {};
  // Check both start_cmd and start-cmd (hyphenated) keys
  const startCmd = artifact.start_cmd || (metadata.start_cmd as string) || (metadata['start-cmd'] as string) || '';

  return (
    <div className="flex h-full flex-col overflow-auto p-2">
      {/* Header */}
      <div className="mb-2 flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${getStatusColor(status)}`} />
        <span className="text-sm font-medium">{artifact.name || 'Unnamed'}</span>
        <Badge
          variant={status === 'running' ? 'default' : status === 'error' ? 'destructive' : 'secondary'}
          className="h-5 text-[10px]"
        >
          {status === 'running' ? 'Running' : status === 'error' ? 'Error' : 'Stopped'}
        </Badge>
        <span className="text-xs text-muted-foreground">• {artifact.artifact_type}</span>
      </div>

      {/* Compact Info Table */}
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <Row label="Port" value={artifact.port || '-'} />
        <Row label="Path" value={artifact.path || '-'} mono />
        {startCmd && <Row label="Start" value={startCmd} mono />}
        {artifact.health && <Row label="Health" value={artifact.health} />}

        {/* Runtime info when running */}
        {isRunning && processInfo && (
          <>
            <div className="col-span-2 my-1 border-t" />
            <Row label="PID" value={String(processInfo.pid)} />
            <Row label="Process" value={processInfo.name} />
            <Row label="CPU" value={`${processInfo.cpu_percent.toFixed(1)}%`} />
            <Row label="Memory" value={`${processInfo.memory_mb.toFixed(1)} MB`} />
            <Row label="Status" value={processInfo.status} />
            {processInfo.path && <Row label="Exec" value={processInfo.path} mono />}
          </>
        )}

        {/* Metadata */}
        {Object.keys(metadata).filter((k) => k !== 'start_cmd' && k !== 'port').length > 0 && (
          <>
            <div className="col-span-2 my-1 border-t" />
            {Object.entries(metadata)
              .filter(([k]) => k !== 'start_cmd' && k !== 'port')
              .map(([key, value]) => (
                <Row key={key} label={key} value={String(value)} />
              ))}
          </>
        )}
      </div>
    </div>
  );
};

const Row: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <>
    <span className="text-muted-foreground">{label}</span>
    <span className={`truncate ${mono ? 'font-mono' : ''}`} title={value}>
      {value}
    </span>
  </>
);
