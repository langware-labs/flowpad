import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FSRef, TypeId, type Skill } from '@sdk';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { AssetRow } from '@src/components/asset-manager/AssetManagerPopover';
import { SkillAssetEditor } from '@src/components/assets/editor/skill/SkillAssetEditor';
vi.mock('@src/hooks/use-entity-by-path', () => ({ useEntityByPath: () => ({ entity: null }) }));
vi.mock('@src/components/assets/editor/PublishedToggle', () => ({ PublishedToggle: () => null }));
vi.mock('@src/components/assets/editor/markdown/MarkdownEditor', () => ({
  MarkdownEditor: ({ fsRef }: { fsRef: FSRef }) => <output data-testid="content-path">{fsRef.path}</output>,
}));
const ID = '11111111-1111-4111-8111-111111111111';
const NODE = new TypeId('compute_node', '@local');
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
afterEach(cleanup);
describe('asset occurrence navigation', () => {
  it('puts the clicked copy path and read-only option in the URL', async () => {
    render(<MemoryRouter><TooltipProvider>
      <AssetRow descriptor={{typeid: `skill-${ID}`, source: 'project_dir', posix_path: '/project/.claude/skills/copy-two'}}
        scope={{kind: 'project', label: 'Project'}} label="copy-two" selected={false} improvable={false} busy={false} />
      <Location />
    </TooltipProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', {name: /View copy-two/}));
    await waitFor(() => expect(decodeURIComponent(screen.getByTestId('location').textContent ?? '')).toContain('/vfs/compute_node-@local/project/.claude/skills/copy-two'));
    expect(screen.getByTestId('location').textContent).toContain('readOnly=1');
    expect(screen.getByTestId('location').textContent).not.toContain('/typeid/');
  });
  it('changes the content path when two copies share the same entity ID', () => {
    const skill = {typeId: new TypeId('skill', ID), doc: new FSRef('/copy-one/SKILL.md', NODE)} as Skill;
    const {rerender} = render(<MemoryRouter><SkillAssetEditor fsRef={new FSRef('/copy-one', NODE)} skill={skill} /></MemoryRouter>);
    expect(screen.getByTestId('content-path').textContent).toBe('/copy-one/SKILL.md');
    rerender(<MemoryRouter><SkillAssetEditor fsRef={new FSRef('/copy-two', NODE)} skill={skill} /></MemoryRouter>);
    expect(screen.getByTestId('content-path').textContent).toBe('/copy-two/SKILL.md');
  });
});
