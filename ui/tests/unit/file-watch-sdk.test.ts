/**
 * fsManager.watchFile: the SDK half of `fs/watch` → `file_changed_msg`.
 *
 * Real ConnectionManager (events are emitted on it, the way the socket does);
 * only the request leaving the SDK (`dataManager.callAction`) is captured.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '@sdk/websocket';
import { dataManager, fsManager, TypeId } from '@sdk';

const node = new TypeId('compute_node', '@local');
const cm = ConnectionManager.getInstance();

function capture() {
  const sent: Array<{ subpath: string; body: unknown }> = [];
  vi.spyOn(dataManager, 'callAction').mockImplementation((info: { subpath?: string; bodyParameters?: unknown }) => {
    sent.push({ subpath: String(info.subpath), body: info.bodyParameters });
    return Promise.resolve(true);
  });
  vi.spyOn(cm, 'connected', 'get').mockReturnValue(true);
  return sent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fsManager.watchFile', () => {
  it('one server watch per file, however many listeners; dropped with the last', async () => {
    const sent = capture();
    const a = vi.fn();
    const b = vi.fn();
    const offA = fsManager.watchFile(node, '/tmp/s1.py', a);
    const offB = fsManager.watchFile(node, 'tmp/s1.py', b);
    await vi.waitFor(() => expect(sent.map((s) => s.subpath)).toEqual(['watch/tmp/s1.py']));
    expect(sent[0].body).toEqual({ connection_id: cm.id });

    cm.emit('on_file_changed', { path: 'tmp/s1.py' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    await Promise.resolve();
    expect(sent.map((s) => s.subpath)).toEqual(['watch/tmp/s1.py']);
    offB();
    await vi.waitFor(() => expect(sent.map((s) => s.subpath)).toEqual(['watch/tmp/s1.py', 'unwatch/tmp/s1.py']));

    cm.emit('on_file_changed', { path: 'tmp/s1.py' });
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('an unmount and remount never leave the server unwatched (requests stay in order)', async () => {
    const sent: string[] = [];
    let release: () => void = () => undefined;
    vi.spyOn(cm, 'connected', 'get').mockReturnValue(true);
    // Every request is slow and in flight together unless the SDK serialises them.
    vi.spyOn(dataManager, 'callAction').mockImplementation((info: { subpath?: string }) => {
      sent.push(String(info.subpath).split('/')[0]);
      return new Promise((resolve) => (release = () => resolve(true)));
    });
    const off1 = fsManager.watchFile(node, '/tmp/remount.py', vi.fn());
    off1(); // unmount while the watch is still in flight
    const off2 = fsManager.watchFile(node, '/tmp/remount.py', vi.fn()); // remount
    expect(sent).toEqual(['watch']); // nothing else sent while the first request is out
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(['watch']); // wanted == registered: no unwatch/watch churn at all
    off2();
    await vi.waitFor(() => expect(sent).toEqual(['watch', 'unwatch']));
    release();
  });

  it('a change to another file reaches nobody here', async () => {
    capture();
    const a = vi.fn();
    const off = fsManager.watchFile(node, '/tmp/s2.py', a);
    cm.emit('on_file_changed', { path: 'tmp/other.py' });
    expect(a).not.toHaveBeenCalled();
    off();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('a watch in flight when the socket reconnects is sent again for the new socket', async () => {
    const sent: string[] = [];
    let release: () => void = () => undefined;
    vi.spyOn(cm, 'connected', 'get').mockReturnValue(true);
    vi.spyOn(dataManager, 'callAction').mockImplementation((info: { subpath?: string }) => {
      sent.push(String(info.subpath));
      return new Promise((resolve) => (release = () => resolve(true)));
    });
    const off = fsManager.watchFile(node, '/tmp/inflight.py', vi.fn());
    expect(sent).toEqual(['watch/tmp/inflight.py']);
    cm.emit('on_open'); // reconnect while that request is still out
    release();
    await vi.waitFor(() => expect(sent).toEqual(['watch/tmp/inflight.py', 'watch/tmp/inflight.py']));
    release();
    off();
    await vi.waitFor(() => expect(sent.at(-1)).toBe('unwatch/tmp/inflight.py'));
    release();
  });

  it('re-registers every live watch when the socket reconnects', async () => {
    const sent = capture();
    const off = fsManager.watchFile(node, '/tmp/s3.py', vi.fn());
    await vi.waitFor(() => expect(sent.length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0)); // the watch settles
    sent.length = 0;
    cm.emit('on_open');
    await vi.waitFor(() => expect(sent.map((s) => s.subpath)).toEqual(['watch/tmp/s3.py']));
    off();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
