import { AgenticProcess, FlowData, FlowElementTypes, ProcessStatus, WorkerStatus } from '@sdk';
import { describe, expect, it } from 'vitest';

const PROCESS_ID = '00000000-0000-4000-8000-0000000000e1';
const SECOND_PROCESS_ID = '00000000-0000-4000-8000-0000000000e2';
const THIRD_PROCESS_ID = '00000000-0000-4000-8000-0000000000e3';

function frame(elementType: string, content: string, attributes: Record<string, string> = {}): FlowData {
  const item = new FlowData(elementType, content, {
    'element-type': elementType,
    'data-type': 'text',
    t: '2026-07-14T04:27:00.000Z',
    ...attributes,
  });
  item.markReady();
  return item;
}

class WireUpdateProcess extends AgenticProcess {
  applyWireUpdate(data: { busy?: boolean; worker_status?: WorkerStatus; status?: ProcessStatus }): void {
    this.onEntityUpdate(data);
  }
}

describe('AgenticProcess.output terminal delivery', () => {
  it('drains frames queued before COMPLETE while the consumer is paused', async () => {
    const process = new AgenticProcess({ id: PROCESS_ID, pty_mode: false });
    const iterator = process.output();

    const firstPending = iterator.next();
    await Promise.resolve();
    process.emit('flow_data', frame(FlowElementTypes.STATUS, 'working'));
    expect((await firstPending).value?.content).toBe('working');

    const secondPending = iterator.next();
    await Promise.resolve();
    process.emit('flow_data', frame(FlowElementTypes.STATUS, 'settling'));
    process._handleComplete();
    process.emit('flow_data', frame(FlowElementTypes.CHAT, 'Hola'));

    expect((await secondPending).value?.content).toBe('settling');
    expect((await iterator.next()).value?.content).toBe('Hola');
    expect(await iterator.next()).toMatchObject({ done: true });
  });

  it('waits for the busy-to-idle edge when raw COMPLETE precedes terminal chat', async () => {
    const process = new WireUpdateProcess({ id: SECOND_PROCESS_ID, pty_mode: false });
    const iterator = process.output();

    const chatPending = iterator.next();
    await Promise.resolve();

    process.applyWireUpdate({ busy: true, worker_status: WorkerStatus.COMPLETE });
    expect(process.completed).toBe(false);

    process.handleFlowData(frame(FlowElementTypes.CHAT, 'Hola'));
    expect((await chatPending).value?.content).toBe('Hola');

    const completionPending = iterator.next();
    await Promise.resolve();
    process.handleFlowData(frame(FlowElementTypes.END, ''));
    process.applyWireUpdate({ busy: false, worker_status: WorkerStatus.COMPLETE });

    expect(process.completed).toBe(true);
    expect((await completionPending).value?.elementType).toBe(FlowElementTypes.END);
    expect(await iterator.next()).toMatchObject({ done: true });
  });

  it('settles a headless crash from this turn\'s ERROR/END frames despite stale raw COMPLETE', async () => {
    const process = new WireUpdateProcess({
      id: THIRD_PROCESS_ID,
      pty_mode: false,
      busy: false,
      worker_status: WorkerStatus.COMPLETE,
    });
    process.applyWireUpdate({ busy: true, worker_status: WorkerStatus.COMPLETE });
    const iterator = process.output();
    const outputPending = iterator.next();
    const stepIterator = process.step();
    const stepPending = stepIterator.next();
    await Promise.resolve();
    const waitPending = process.wait();

    process.handleFlowData(frame(FlowElementTypes.STATUS, 'killed', { subtype: 'exit-error' }));
    process.handleFlowData(frame(FlowElementTypes.END, ''));
    process.applyWireUpdate({ busy: false, worker_status: WorkerStatus.COMPLETE });

    await expect(waitPending).rejects.toThrow('killed');
    expect(process.completed).toBe(true);
    expect((await outputPending).value?.content).toBe('killed');
    expect((await stepPending).value?.content).toBe('killed');
    expect((await iterator.next()).value?.elementType).toBe(FlowElementTypes.END);
    expect((await stepIterator.next()).value?.elementType).toBe(FlowElementTypes.END);
    expect(await iterator.next()).toMatchObject({ done: true });
    expect(await stepIterator.next()).toMatchObject({ done: true });
  });

  it('captures live frames that arrive while existing output is being yielded', async () => {
    const process = new AgenticProcess({ id: '00000000-0000-4000-8000-0000000000e4', pty_mode: true });
    process.handleFlowData(frame(FlowElementTypes.STATUS, 'existing-1'));
    process.handleFlowData(frame(FlowElementTypes.STATUS, 'existing-2'));
    const iterator = process.output();

    expect((await iterator.next()).value?.content).toBe('existing-1');
    process.emit('flow_data', frame(FlowElementTypes.CHAT, 'live'));
    expect((await iterator.next()).value?.content).toBe('existing-2');
    expect((await iterator.next()).value?.content).toBe('live');
    process._handleComplete();
    expect(await iterator.next()).toMatchObject({ done: true });
  });

  it('does not infer PTY completion from a non-terminal busy-to-idle edge', () => {
    const process = new WireUpdateProcess({
      id: THIRD_PROCESS_ID,
      pty_mode: true,
      busy: true,
      worker_status: WorkerStatus.WORKING,
    });

    process.applyWireUpdate({ busy: false, worker_status: WorkerStatus.WORKING });

    expect(process.completed).toBe(false);
    expect(process.error).toBeNull();
  });

  it.each([WorkerStatus.INACTIVE, WorkerStatus.API_TIMEOUT])(
    'settles a live PTY %s terminal transition as an error',
    (workerStatus) => {
      const process = new WireUpdateProcess({
        id: '00000000-0000-4000-8000-0000000000e5',
        pty_mode: true,
        busy: true,
        worker_status: WorkerStatus.WORKING,
      });

      process.applyWireUpdate({ busy: false, worker_status: workerStatus });

      expect(process.completed).toBe(true);
      expect(process.error).not.toBeNull();
    },
  );

  it('applies a combined failed/busy/error entity update atomically', () => {
    const process = new WireUpdateProcess({
      id: '00000000-0000-4000-8000-0000000000e6',
      pty_mode: false,
      busy: false,
      worker_status: WorkerStatus.WORKING,
    });
    let errors = 0;
    process.on('error', () => errors++);

    process.applyWireUpdate({
      status: ProcessStatus.FAILED,
      busy: true,
      worker_status: WorkerStatus.ERROR,
    });
    process.applyWireUpdate({ busy: false, worker_status: WorkerStatus.ERROR });

    expect(process.error?.message).toContain('lifecycle status');
    expect(errors).toBe(1);
  });

  it.each([
    [WorkerStatus.ERROR, 'Process error'],
    [WorkerStatus.INTERRUPTED, 'Process was terminated'],
    [WorkerStatus.INACTIVE, 'Process became inactive'],
    [WorkerStatus.API_TIMEOUT, 'Process timed out'],
  ])('rejects wait() for an already-idle %s process', async (workerStatus, message) => {
    const process = new AgenticProcess({
      id: THIRD_PROCESS_ID,
      pty_mode: false,
      busy: false,
      worker_status: workerStatus,
    });

    await expect(process.wait()).rejects.toThrow(message);
    await expect(process.waitForComplete()).rejects.toThrow(message);
  });
});

describe('AgenticProcess headless turn settlement (multi-client)', () => {
  it('does not settle a fresh pending turn as error from a statusless op while status is FAILED', () => {
    const process = new WireUpdateProcess({
      id: '00000000-0000-4000-8000-0000000000f1',
      pty_mode: false,
      busy: false,
      status: ProcessStatus.FAILED,
      worker_status: WorkerStatus.ERROR,
    });
    let errors = 0;
    process.on('error', () => errors++);

    // A fresh turn begins on the busy:true edge (beginHeadlessTurn → pending),
    // but ``status`` is still the stale FAILED inherited from the prior turn.
    process.applyWireUpdate({ busy: true, worker_status: WorkerStatus.WORKING });
    expect(process.error).toBeNull();

    // A statusless op (name stamp / transcript debounce) observes the stale
    // FAILED status. It must NOT re-settle the fresh pending turn as an error.
    process.applyWireUpdate({ worker_status: WorkerStatus.WORKING });
    expect(errors).toBe(0);
    expect(process.error).toBeNull();
    expect(process.completed).toBe(false);

    // The turn still settles correctly from its own END frame + busy:false.
    process.handleFlowData(frame(FlowElementTypes.END, ''));
    process.applyWireUpdate({ busy: false, worker_status: WorkerStatus.COMPLETE });
    expect(process.completed).toBe(true);
    expect(process.error).toBeNull();
  });

  it('still settles on the real transition into FAILED', () => {
    const process = new WireUpdateProcess({
      id: '00000000-0000-4000-8000-0000000000f2',
      pty_mode: false,
      busy: true,
      status: ProcessStatus.RUNNING,
      worker_status: WorkerStatus.WORKING,
    });

    process.applyWireUpdate({ status: ProcessStatus.FAILED, busy: false });

    expect(process.completed).toBe(true);
    expect(process.error?.message).toContain('lifecycle status');
  });

  it('settles a passive client (entity edges only, no FlowData) from terminal worker_status on busy:false', () => {
    const process = new WireUpdateProcess({
      id: '00000000-0000-4000-8000-0000000000f3',
      pty_mode: false,
      busy: false,
      worker_status: WorkerStatus.INITIALIZING,
    });

    // Fresh turn: the busy:true edge begins a pending headless turn locally.
    process.applyWireUpdate({ busy: true, worker_status: WorkerStatus.WORKING });
    expect(process.completed).toBe(false);

    // Turn ends. This client never received any FlowData (no END frame), so it
    // must settle from the terminal worker_status instead of hanging forever.
    process.applyWireUpdate({ busy: false, worker_status: WorkerStatus.COMPLETE });
    expect(process.completed).toBe(true);
    expect(process.error).toBeNull();
  });

  it('settles a passive client as error from a terminal error worker_status on busy:false', () => {
    const process = new WireUpdateProcess({
      id: '00000000-0000-4000-8000-0000000000f4',
      pty_mode: false,
      busy: false,
      worker_status: WorkerStatus.INITIALIZING,
    });

    process.applyWireUpdate({ busy: true, worker_status: WorkerStatus.WORKING });
    process.applyWireUpdate({ busy: false, worker_status: WorkerStatus.ERROR });

    expect(process.completed).toBe(true);
    expect(process.error).not.toBeNull();
  });

  it('keeps a streaming client pending on busy:false until its own END frame despite terminal worker_status', () => {
    const process = new WireUpdateProcess({
      id: '00000000-0000-4000-8000-0000000000f5',
      pty_mode: false,
      busy: false,
      worker_status: WorkerStatus.INITIALIZING,
    });

    process.applyWireUpdate({ busy: true, worker_status: WorkerStatus.WORKING });
    // Streaming: a content frame for this turn arrives; END has NOT yet.
    process.handleFlowData(frame(FlowElementTypes.CHAT, 'partial'));

    // busy:false arrives before END, with a raw-terminal (possibly stale)
    // worker_status. The streaming client must keep waiting for its own END.
    process.applyWireUpdate({ busy: false, worker_status: WorkerStatus.COMPLETE });
    expect(process.completed).toBe(false);

    // END frame is the authoritative terminator — now it settles.
    process.handleFlowData(frame(FlowElementTypes.END, ''));
    expect(process.completed).toBe(true);
    expect(process.error).toBeNull();
  });
});
