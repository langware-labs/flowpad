import type { Pipeline } from '@sdk';
import { Loader2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { PipelineCanvas } from './PipelineCanvas';
import { fsManager, type TypeId } from '@sdk';

interface PipelineViewerProps {
  /** VFS path to the pipeline.json file */
  pipelinePath: string;
  fsTypeId: TypeId;
}

/**
 * Fetches and renders a Pipeline JSON as a visual left-to-right graph.
 */
export function PipelineViewer({ pipelinePath, fsTypeId }: PipelineViewerProps) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    setPipeline(null);

    void fsManager
      .download(fsTypeId, pipelinePath)
      .then((text) => {
        const data = JSON.parse(typeof text === 'string' ? text : JSON.stringify(text)) as Pipeline;
        setPipeline(data);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      })
      .finally(() => setIsLoading(false));
  }, [pipelinePath, fsTypeId]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">Failed to load pipeline: {error}</p>
      </div>
    );
  }

  if (!pipeline) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No pipeline data.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-muted/20 p-4">
      <PipelineCanvas pipeline={pipeline} />
    </div>
  );
}
