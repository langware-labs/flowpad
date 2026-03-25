import { Artifact, downloadFileFromUrl, FlowData, ISiteConfig } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useFS, useProject } from '@sdk/react/hooks';
import { Download, FileText, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useColorPalette } from '@src/hooks/useColorPalette';
import ArtifactSection from './artifact-section';

interface ArtifactsSectionProps {
  results: FlowData<Artifact>[];
  siteConfig?: ISiteConfig;
}

const ArtifactsSection: React.FC<ArtifactsSectionProps> = ({ results, siteConfig }) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { project } = useProject();
  const fs = useFS(project?.typeId);
  useColorPalette(siteConfig);

  const handleDownloadAllClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!fs) return;
      // Download files sequentially with delays to prevent browser from canceling requests
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const url = fs.getDownloadUrl(result.data.path);
        downloadFileFromUrl(url);
        // Add delay between downloads to prevent browser from canceling requests
        if (i < results.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    },
    [results, fs],
  );

  const handleToggleDropdown = useCallback(() => {
    setIsDropdownOpen(!isDropdownOpen);
  }, [isDropdownOpen]);

  const handleCloseDropdown = useCallback(() => {
    setIsDropdownOpen(false);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isDropdownOpen]);

  if (!results || results.length === 0) {
    return null;
  }

  return (
    <div className="relative my-0 px-2" ref={dropdownRef}>
      <Button
        variant="outline"
        size="sm"
        onClick={handleToggleDropdown}
        className="flex h-6 min-w-0 items-center space-x-1 border border-border bg-white px-1 py-0 text-xs font-normal text-foreground hover:bg-gray-50"
      >
        <FileText className="h-3 w-3 text-gray-500" />
        <span className="text-xs font-normal text-gray-600">Artifacts ({results.length})</span>
      </Button>

      {isDropdownOpen && (
        <div className="absolute bottom-full right-0 z-10 mb-2 max-h-96 min-w-64 overflow-hidden rounded-lg border bg-background text-sm shadow-lg">
          <div className="flex items-center justify-between border-b p-2">
            <div className="flex items-center space-x-2">
              <div className="flex h-5 w-5 items-center justify-center rounded-lg bg-background">
                <FileText className="h-3 w-3" />
              </div>
              <span className="font-medium text-gray-900">Artifacts ({results.length})</span>
            </div>
            <div className="flex items-center space-x-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  void handleDownloadAllClick(e);
                }}
                className="h-5 w-5 p-0"
              >
                <Download className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCloseDropdown} className="h-5 w-5 p-0">
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto p-2">
            <div className="space-y-2">
              {results.map((result: FlowData<Artifact>, index: number) => {
                return <ArtifactSection key={index} flowData={result} />;
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ArtifactsSection;
