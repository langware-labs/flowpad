import { fsManager, mcpUIManager, MCPUIComponent, MCPUIViewer, VFSPath } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useEffect, useRef, useState, useMemo } from 'react';
import { generateStubHTML } from './stub-html';

/**
 * Default values for page and component
 * These are applied when not explicitly specified in the URI
 */
const DEFAULT_PAGE = 'index';
const DEFAULT_COMPONENT = 'main';

interface ParsedShowParams {
  /** Entity VFS path or skill name */
  entityVfs: string;
  /** Page name (defaults to "index") */
  page: string;
  /** Component name (defaults to "main") */
  component: string;
}

/**
 * Parse show view parameters from pointer and options
 *
 * URI format: ui://<entity_vfs>?page=<page>&component=<component>
 * - pointer contains the entity_vfs
 * - options contain page and component query params
 *
 * Defaults:
 * - page: "index"
 * - component: "main"
 *
 * @param pointer - The entity VFS path from URL pointer segment
 * @param options - Query params containing page and component
 */
function parseShowParams(
  pointer: string | undefined,
  options: Record<string, string> | undefined,
): ParsedShowParams | null {
  if (!pointer) return null;

  // Apply defaults for page and component
  const page = options?.page || DEFAULT_PAGE;
  const component = options?.component || DEFAULT_COMPONENT;

  return {
    entityVfs: pointer,
    page,
    component,
  };
}

/**
 * Fetch skill UI HTML using VFS path and fsManager
 *
 * @param entityVfs - The entity VFS path (e.g., "compute_node-@local/.flow/system_skills/onboarding")
 * @param component - The component name (e.g., "hello-flowpad")
 * @returns HTML content as string
 */
async function fetchSkillUIHtml(entityVfs: string, component: string): Promise<string> {
  // Parse the entity VFS path to get typeId and construct the HTML path
  const vfsPath = VFSPath.parse(entityVfs);
  if (!vfsPath) {
    throw new Error(`Invalid VFS path: ${entityVfs}`);
  }

  // Construct the HTML file path: <skill-path>/ui/<component>.html
  const htmlPath = `${vfsPath.entitySubPath}/ui/${component}.html`;

  // Download the HTML content via fsManager
  if (!vfsPath.typeId) {
    throw new Error(`VFS path does not contain a valid TypeId: ${entityVfs}`);
  }
  const content = await fsManager.download(vfsPath.typeId, htmlPath);
  if (typeof content !== 'string') {
    throw new Error(`Skill UI content is not a string: ${entityVfs}/ui/${component}.html`);
  }

  return content;
}

/**
 * Build the internal URI for MCP UI component
 *
 * Format: ui://<entity_vfs>?page=<page>&component=<component>
 */
function buildUIUri(entityVfs: string, page: string, component: string): string {
  return `ui://${entityVfs}?page=${encodeURIComponent(page)}&component=${encodeURIComponent(component)}`;
}

export function ShowView() {
  const { currentDock } = useDockNavigation();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<MCPUIViewer | null>(null);
  const componentRef = useRef<MCPUIComponent | null>(null);
  const uriRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Parse params from pointer (entity_vfs) and options (page, component)
  const params = useMemo(
    () => parseShowParams(currentDock?.pointer, currentDock?.options),
    [currentDock?.pointer, currentDock?.options],
  );

  useEffect(() => {
    if (!params || !containerRef.current) return;

    const { entityVfs, page, component } = params;

    // Build URI in new format: ui://<entity_vfs>?page=<page>&component=<component>
    const uri = buildUIUri(entityVfs, page, component);

    // Determine how to get HTML:
    // - For VFS paths (contain entity type like "compute_node-@local/..."): fetch via fsManager
    // - For other entities: generate stub HTML
    // VFS paths contain the entity type prefix with format "type-@identifier"
    const isVfsPath = entityVfs.includes('-@') || entityVfs.includes('/');
    const htmlPromise = isVfsPath
      ? fetchSkillUIHtml(entityVfs, component)
      : Promise.resolve(generateStubHTML(entityVfs, page, component));

    // Track current URI for cleanup
    uriRef.current = uri;

    let viewer: MCPUIViewer | null = null;
    let mcpComponent: MCPUIComponent | null = null;
    let isMounted = true;

    const loadComponent = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Get HTML (either from API or generated)
        const html = await htmlPromise;

        // Load component via MCPUIManager
        mcpComponent = await mcpUIManager.loadWithHTML(uri, html, {
          hostContext: { theme: 'light', displayMode: 'inline' },
          initTimeout: 10000,
        });

        if (!isMounted) {
          // Component unmounted during async load
          void mcpComponent.close('Component unmounted');
          return;
        }

        componentRef.current = mcpComponent;

        // Create viewer and add component
        viewer = new MCPUIViewer({ container: containerRef.current! });
        viewerRef.current = viewer;
        viewer.add(mcpComponent, { activate: true });

        // Send initial params to the component
        mcpComponent.sendParams({ entityVfs, page, component });

        setIsLoading(false);
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : String(err));
          setIsLoading(false);
        }
      }
    };

    void loadComponent();

    // Cleanup on unmount or params change
    return () => {
      isMounted = false;
      if (viewer) {
        void viewer.destroy();
      }
      if (uriRef.current) {
        void mcpUIManager.closeComponent(uriRef.current);
        mcpUIManager.unregisterHTML(uriRef.current);
      }
      viewerRef.current = null;
      componentRef.current = null;
      uriRef.current = null;
    };
  }, [params]);

  if (!params) {
    return (
      <div className="p-8 font-mono">
        <h2 className="mb-4 text-xl font-bold">Invalid Show Path</h2>
        <p>Expected format: /dock/show/&lt;entity-vfs&gt;?page=&lt;page&gt;&amp;component=&lt;component&gt;</p>
        <p className="mt-2 text-sm text-gray-600">
          Defaults: page=&quot;{DEFAULT_PAGE}&quot;, component=&quot;{DEFAULT_COMPONENT}&quot;
        </p>
        <p className="mt-2">Received pointer: {currentDock?.pointer || 'none'}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 font-mono text-red-600">
        <h2 className="mb-4 text-xl font-bold">Error Loading Component</h2>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      {isLoading && (
        <div className="flex h-full items-center justify-center">
          <p className="text-gray-500">Loading MCP UI component...</p>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" style={{ display: isLoading ? 'none' : 'block' }} />
    </div>
  );
}
