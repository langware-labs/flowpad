import { ViewType } from '@sdk';
import React from 'react';
import { resolveViewer } from '@sdk/react/hooks/flow-hooks/viewer-utils';
import { ViewContext } from '../../types/ViewContext';
import { UnsupportedContentViewer } from './UnsupportedContentViewer';

export interface DynamicViewerProps {
  context?: ViewContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fallbackData?: any; // For backward compatibility during migration
  children?: React.ReactNode; // Allow custom rendering for specific view types
}

/**
 * DynamicViewer - Routes to the appropriate viewer based on ViewContext
 *
 * During migration, this component accepts fallbackData to maintain
 * compatibility with existing hardcoded component rendering.
 */
export function DynamicViewer({ context, fallbackData: _fallbackData, children }: DynamicViewerProps) {
  if (!context) {
    // No context provided - show placeholder or children
    if (children) {
      return <>{children}</>;
    }
    return <div className="p-4 text-muted-foreground">No content to display</div>;
  }

  const viewType = resolveViewer(context);

  // For now, during migration, we'll render children for most view types
  // and only handle UNSUPPORTED explicitly
  // The actual viewer wrappers will be created as we migrate each view type

  if (viewType === ViewType.UNSUPPORTED) {
    return <UnsupportedContentViewer context={context} />;
  }

  // During migration: render children (existing hardcoded components)
  if (children) {
    return <>{children}</>;
  }

  // If no children and no explicit viewer, show unsupported
  return <UnsupportedContentViewer context={context} />;
}
