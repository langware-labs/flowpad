import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FSRef, Mcp, TypeId } from '@sdk';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpViewer } from '@src/components/assets/editor/mcp/McpViewer';

vi.mock('@src/components/assets/editor/PublishedToggle', () => ({
  PublishedToggle: () => <button>Publish</button>,
}));

const NODE = new TypeId('compute_node', '@local');
const first = '/project/agentic-assets/mcp/copy-one';
const second = '/project/agentic-assets/mcp/copy-two';
const spec = (name: string) => ({ name, command: 'python', entrypoint: 'server.py', future_field: 'kept' });

function View({ path, mcp, readOnly = false }: { path: string; mcp?: Mcp; readOnly?: boolean }) {
  return <MemoryRouter initialEntries={['/dock/desk/assets/editor/mcp/vfs/compute_node-%40local' + path + (readOnly ? '?readOnly=1' : '')]}>
    <Routes><Route path="/dock/:page/:viewType/*" element={<McpViewer fsRef={new FSRef(path, NODE)} mcp={mcp} />} /></Routes>
  </MemoryRouter>;
}

beforeEach(() => {
  vi.spyOn(FSRef.prototype, 'read').mockImplementation(function () {
    return Promise.resolve(JSON.stringify(spec(this.path.startsWith(second) ? 'copy-two' : 'copy-one')));
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('MCP occurrence editor', () => {
  it('renders an unindexed file and writes only its selected occurrence', async () => {
    const write = vi.spyOn(FSRef.prototype, 'write').mockResolvedValue();
    render(<View path={second} />);
    const input = await screen.findByLabelText<HTMLInputElement>('Name');
    expect(input.value).toBe('copy-two');
    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.blur(input);
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(write.mock.contexts[0].path).toBe(second + '/mcp.json');
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ ...spec('renamed') });
    expect(screen.queryByTestId('mcp-test')).toBeNull();
  });

  it('switches files when two folders share the same MCP identity', async () => {
    const mcp = new Mcp({ id: '11111111-1111-4111-8111-111111111111', name: 'primary', asset_ref: first });
    const { rerender } = render(<View path={first} mcp={mcp} readOnly />);
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('copy-one'));
    rerender(<View path={second} mcp={mcp} readOnly />);
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('copy-two'));
  });

  it('enforces read-only fields and hides entity mutation and launch controls', async () => {
    const write = vi.spyOn(FSRef.prototype, 'write').mockResolvedValue();
    const mcp = new Mcp({ name: 'primary', asset_ref: first });
    const markEdit = vi.spyOn(mcp, 'markEdit');
    render(<View path={second} mcp={mcp} readOnly />);
    const input = await screen.findByLabelText<HTMLInputElement>('Name');
    expect(input.readOnly).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>('mcp-transport').disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'blocked' } });
    fireEvent.blur(input);
    expect(write).not.toHaveBeenCalled();
    expect(markEdit).not.toHaveBeenCalled();
    expect(screen.queryByText('Publish')).toBeNull();
    expect(screen.queryByTestId('mcp-test')).toBeNull();
  });
});
