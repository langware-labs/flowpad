import { Button } from '@src/components/ui/button';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { useCurrentArtifacts } from '@src/hooks/flow-hooks';
import { Plus } from 'lucide-react';
import React, { useState } from 'react';
import { ArtifactForm } from './artifact-form';
import { ArtifactsList } from './artifacts-list';

interface ArtifactsViewProps {
  className?: string;
}

/**
 * Main artifacts view component with list and add functionality.
 */
export const ArtifactsView: React.FC<ArtifactsViewProps> = ({ className = '' }) => {
  const { data: artifacts = [] } = useCurrentArtifacts();
  const [showAddForm, setShowAddForm] = useState(false);

  const totalArtifacts = artifacts.length;

  return (
    <div className={`flex h-full flex-col ${className}`}>
      {/* Top Bar */}
      <div className="flex items-center justify-between border-b bg-background px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Project Artifacts</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
            {totalArtifacts} {totalArtifacts === 1 ? 'artifact' : 'artifacts'}
          </span>
        </div>

        <Button size="sm" onClick={() => setShowAddForm(true)}>
          <Plus className="mr-1 h-4 w-4" />
          Add Artifact
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          <ArtifactsList groupByType />
        </div>
      </ScrollArea>

      {/* Add Artifact Form */}
      <ArtifactForm open={showAddForm} onOpenChange={setShowAddForm} />
    </div>
  );
};
