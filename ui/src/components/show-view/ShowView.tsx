import { fsManager, VFSPath } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useMemo } from 'react';
import { McpAppShell } from '@src/components/app-host/McpAppShell';
import { Trans } from '@lingui/react/macro';

const DEFAULT_PAGE = 'index';
const DEFAULT_COMPONENT = 'main';

interface ParsedShowParams {
  entityVfs: string;
  page: string;
  component: string;
}

function parseShowParams(
  pointer: string | undefined,
  page: string | undefined,
  component: string | undefined,
): ParsedShowParams | null {
  if (!pointer) return null;
  return {
    entityVfs: pointer,
    page: page || DEFAULT_PAGE,
    component: component || DEFAULT_COMPONENT,
  };
}

async function fetchSkillUIHtml({ entityVfs, component }: ParsedShowParams): Promise<string> {
  const vfsPath = VFSPath.parse(entityVfs);
  if (!vfsPath.typeId) {
    throw new Error(`VFS path does not contain a valid TypeId: ${entityVfs}`);
  }
  const htmlPath = `${vfsPath.entitySubPath}/ui/${component}.html`;
  const content = await fsManager.download(vfsPath.typeId, htmlPath);
  if (typeof content !== 'string') {
    throw new Error(`Skill UI content is not a string: ${entityVfs}/ui/${component}.html`);
  }
  return content;
}

export function ShowView() {
  const { currentDock } = useDockNavigation();

  const params = useMemo(
    () => parseShowParams(currentDock?.pointer, currentDock?.options?.page, currentDock?.options?.component),
    [currentDock?.pointer, currentDock?.options?.page, currentDock?.options?.component],
  );

  return (
    <McpAppShell
      params={params}
      loadHtml={fetchSkillUIHtml}
      loadKey={params}
      toolName={params?.component ?? ''}
      toolInput={{ entityVfs: params?.entityVfs, page: params?.page, component: params?.component }}
      invalidTitle={<Trans>Invalid Show Path</Trans>}
      invalidHint={
        <>
          <p>
            <Trans>Expected format: /dock/show/&lt;entity-vfs&gt;?page=&lt;page&gt;&amp;component=&lt;component&gt;</Trans>
          </p>
          <p className="mt-2 text-sm text-gray-600">
            <Trans>Defaults: page=&quot;{DEFAULT_PAGE}&quot;, component=&quot;{DEFAULT_COMPONENT}&quot;</Trans>
          </p>
          <p className="mt-2">
            <Trans>Received pointer: {currentDock?.pointer || 'none'}</Trans>
          </p>
        </>
      }
      errorTitle={<Trans>Error Loading Component</Trans>}
      loadingLabel={<Trans>Loading MCP UI component...</Trans>}
    />
  );
}
