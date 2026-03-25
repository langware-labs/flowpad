import { useState, useEffect, useRef } from 'react';
import type { ITerminalOptions } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import { LiveXtermAdapter } from '../adapter/XtermAdapter.js';
import { XTermHarness } from './XTermHarness.js';

export interface XtermSetup {
  termRef:      React.RefObject<Terminal | null>;
  adapterRef:   React.RefObject<LiveXtermAdapter | null>;
  harnessRef:   React.RefObject<XTermHarness | null>;
  termState:    Terminal | null;      // triggers re-renders (safe as useScrollSync dep)
  adapterState: LiveXtermAdapter | null;
}

/**
 * Mount an xterm Terminal on a container ref, creating a LiveXtermAdapter and
 * XTermHarness. Returns refs (for synchronous callback access) and state values
 * (which trigger React re-renders, making them safe dependencies for useScrollSync
 * and other hooks that need to re-run when the terminal mounts).
 *
 * Options are captured at mount time and never re-read — changes after mount are
 * silently ignored. Pass a stable object or inline literal; either works.
 *
 * Teardown — terminal.dispose(), harness.destroy(), ref nulling — is automatic
 * on unmount. Import xterm CSS separately: import '@xterm/xterm/css/xterm.css'.
 *
 * @example
 * const containerRef = useRef<HTMLDivElement>(null);
 * const { termRef, adapterRef, harnessRef, termState, adapterState } =
 *   useXtermSetup(containerRef, { cols: 80, rows: 24, allowProposedApi: true });
 *
 * // Domain-specific wiring after mount:
 * useEffect(() => {
 *   if (!termState) return;
 *   harnessRef.current!.enableEcho();
 * }, [termState]);
 */
export function useXtermSetup(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options?: Partial<ITerminalOptions>,
): XtermSetup {
  const termRef    = useRef<Terminal | null>(null);
  const adapterRef = useRef<LiveXtermAdapter | null>(null);
  const harnessRef = useRef<XTermHarness | null>(null);
  const [termState,    setTermState]    = useState<Terminal | null>(null);
  const [adapterState, setAdapterState] = useState<LiveXtermAdapter | null>(null);
  const optionsRef = useRef(options);  // read once — options are not reactive

  useEffect(() => {
    if (!containerRef.current) return;
    const term    = new Terminal(optionsRef.current);
    const adapter = new LiveXtermAdapter(term);
    const harness = new XTermHarness(term, adapter);
    term.open(containerRef.current);
    termRef.current    = term;
    adapterRef.current = adapter;
    harnessRef.current = harness;
    setTermState(term);
    setAdapterState(adapter);
    return () => {
      harness.destroy();
      term.dispose();
      termRef.current    = null;
      adapterRef.current = null;
      harnessRef.current = null;
      setTermState(null);
      setAdapterState(null);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { termRef, adapterRef, harnessRef, termState, adapterState };
}
