import { registerTerminalLinks } from './terminal-links';
import { useTerminalLinks } from './TerminalLinkMenu';
import '@src/styles/xterm.css';
import '@xterm/xterm/css/xterm.css';

import { useShell } from '@src/hooks/useShell';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { useTheme } from 'next-themes';
import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useXtermShellAttach } from '../useXtermShellAttach';
import { XTERM_BASE_OPTIONS, applyRtlGridContract, registerOsc52ClipboardWrite } from './terminalConfig';
import { DARK_THEME, LIGHT_THEME } from './terminalThemes';

interface ShellTerminalProps {
  shellId: string;
  active: boolean;
  className?: string;
}

/** What a host can do to the terminal it shows. */
export interface ShellTerminalHandle {
  /** Clear the screen and scrollback (this view only — the terminal's recording is untouched). */
  clear: () => void;
  focus: () => void;
}

/**
 * A plain shell's terminal in a view: an xterm kept in step with the shell (`useXtermShellAttach`
 * — its past, then live), typed into, sized to the view. Starts the shell when it is not live
 * (`ensureStarted`). Hosts: a deployment's console, an agent terminal's sidecar, the snippet
 * view's run terminal.
 */
export const ShellTerminal = forwardRef<ShellTerminalHandle, ShellTerminalProps>(function ShellTerminal(
  { shellId, active, className = '' },
  ref,
) {
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [term, setTerm] = useState<XTerm | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const { shell } = useShell(shellId);
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const terminalLinks = useTerminalLinks(shellRef);

  useImperativeHandle(ref, () => ({ clear: () => term?.reset(), focus: () => term?.focus() }), [term]);

  useEffect(() => {
    if (term) term.options.theme = resolvedTheme === 'dark' ? DARK_THEME : LIGHT_THEME;
  }, [term, resolvedTheme]);

  // Terminal init/dispose
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof window === 'undefined') return;

    let disposed = false;
    const xterm = new XTerm({ ...XTERM_BASE_OPTIONS, scrollback: 10000 });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    try {
      xterm.open(container);
      registerTerminalLinks(xterm, terminalLinks.handlers);
      // A plain shell emits logical order on every platform — no CLI here that
      // pre-reverses, so this terminal always takes the browser-bidi contract.
      applyRtlGridContract(container, 'unknown');
      registerOsc52ClipboardWrite(xterm);
    } catch (e) {
      console.error('[ShellTerminal] Failed to open terminal:', e);
      return;
    }
    xterm.options.theme = resolvedTheme === 'dark' ? DARK_THEME : LIGHT_THEME;
    fitAddonRef.current = fit;
    setTerm(xterm);

    const fitTimeoutId = setTimeout(() => {
      if (disposed) return;
      try {
        fit.fit();
        if (active) xterm.focus();
      } catch (e) {
        console.warn('[ShellTerminal] Failed to fit:', e);
      }
      setTerminalReady(true);
    }, 50);

    return () => {
      disposed = true;
      clearTimeout(fitTimeoutId);
      setTerminalReady(false);
      setTerm(null);
      fitAddonRef.current = null;
      setTimeout(() => {
        try {
          xterm.dispose();
        } catch {
          /* ignore */
        }
      }, 10);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellId]);

  // A terminal nobody started yet (or whose PTY died) is started at this view's size.
  useEffect(() => {
    if (!shell || !term || !terminalReady) return;
    void shell
      .ensureStarted({ cols: term.cols, rows: term.rows, workdir: shell.workdir ?? undefined })
      .catch((error) => console.error('[ShellTerminal] Failed to start shell:', error));
  }, [shell, term, terminalReady]);

  useXtermShellAttach(shell, term, { ready: terminalReady, trimRecordedBlankRows: true });

  // Input
  useEffect(() => {
    if (!term || !terminalReady) return;
    const disp = term.onData((data: string) => {
      // The connection holds typeahead until its first attach; see PtyConnection.sendInput.
      void shellRef.current?.sendInput(data);
    });
    return () => disp.dispose();
  }, [term, terminalReady]);

  // Size follows the view.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !term || !terminalReady) return;
    const observer = new ResizeObserver(() => {
      if (!active) return;
      try {
        fitAddonRef.current?.fit();
      } catch {
        return;
      }
      const live = shellRef.current;
      if (live?.connected) void live.resize(term.cols, term.rows);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [active, term, terminalReady]);

  // Focus and fit when becoming active
  useEffect(() => {
    if (!active || !term || !terminalReady) return;
    requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        term.scrollToBottom();
        term.refresh(0, Math.max(0, term.rows - 1));
        term.focus();
        const live = shellRef.current;
        if (live?.connected) void live.resize(term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
  }, [active, term, terminalReady]);

  return (
    <>
      <div ref={containerRef} className={`min-h-0 flex-1 ${className}`} onClick={() => term?.focus()} tabIndex={0} />
      {terminalLinks.menu}
    </>
  );
});
