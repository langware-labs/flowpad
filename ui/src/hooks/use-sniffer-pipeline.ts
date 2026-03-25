import { dataContext } from '@sdk';
import { useMemo } from 'react';

import type { FilterMask } from './use-event-filter-mask';
import { LAYER_PROCESSORS } from './sniffer-layers';
import type { EventLayer, SnifferEvent } from './use-hooks-sniffer';

export enum SnifferScope {
  All = 'all',
  Project = 'project',
}

export enum SnifferLevel {
  Debug = 'debug',
  Info = 'info',
}

export interface PipelineFilters {
  scope: SnifferScope;
  level: SnifferLevel;
  layers?: EventLayer[];
  mask?: FilterMask;
}

const VALID_SCOPES = Object.values(SnifferScope) as string[];
const VALID_LEVELS = Object.values(SnifferLevel) as string[];

/** Parse a JSON-serialised PipelineFilters, falling back to the given defaults. */
export function parsePipelineFilters(
  json: string | null,
  defaults: Pick<PipelineFilters, 'scope' | 'level'> = { scope: SnifferScope.All, level: SnifferLevel.Debug },
): Pick<PipelineFilters, 'scope' | 'level'> {
  if (!json) return defaults;
  try {
    const parsed = JSON.parse(json);
    return {
      scope: VALID_SCOPES.includes(parsed.scope) ? parsed.scope : defaults.scope,
      level: VALID_LEVELS.includes(parsed.level) ? parsed.level : defaults.level,
    };
  } catch {
    return defaults;
  }
}

// Event property extractors for mask keys
const MASK_EXTRACTORS: Record<string, (e: SnifferEvent) => string | undefined> = {
  session_id: (e) => e.session_id,
};

export function useSnifferPipeline(
  rawEvents: SnifferEvent[],
  filters: PipelineFilters,
): { filteredEvents: SnifferEvent[] } {
  const filteredEvents = useMemo(() => {
    // 1. Scope filter
    let scoped = rawEvents;
    if (filters.scope === SnifferScope.Project) {
      const mountPath = dataContext.project?.fs_storage_mount_path;
      if (mountPath) {
        const basename = mountPath.split('/').filter(Boolean).pop() || '';
        const projectFolder = basename.replace(/_/g, '-');
        scoped = rawEvents.filter((event) => {
          const path = event.transcript_path || event.hook_file_path || '';
          return path.includes(projectFolder);
        });
      }
    }

    // 2. Layer processing — run each processor to produce synthetic events
    const syntheticEvents: SnifferEvent[] = [];
    for (const processor of LAYER_PROCESSORS) {
      syntheticEvents.push(...processor.process(scoped));
    }

    // 3. Merge & sort by timestamp
    const merged = [...scoped, ...syntheticEvents].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    // 4. Layer filter: per-layer granular filter (takes priority when set)
    // 5. Level filter (fallback): info = info-only, debug = all layers
    let result: SnifferEvent[];
    if (filters.layers !== undefined) {
      if (filters.layers.length === 0) result = [];
      else {
        const layerSet = new Set(filters.layers);
        result = merged.filter((event) => layerSet.has(event.layer));
      }
    } else if (filters.level === SnifferLevel.Info) {
      result = merged.filter((event) => event.layer !== 'debug');
    } else {
      result = merged;
    }

    // 6. Mask filter
    if (filters.mask) {
      for (const [key, value] of Object.entries(filters.mask)) {
        const extractor = MASK_EXTRACTORS[key];
        if (extractor) {
          result = result.filter((e) => extractor(e) === value);
        }
      }
    }

    return result;
  }, [rawEvents, filters.scope, filters.level, filters.layers, filters.mask]);

  return { filteredEvents };
}
