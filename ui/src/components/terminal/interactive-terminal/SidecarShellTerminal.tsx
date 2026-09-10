import { registerTerminalLinks, useTerminalLinkHandler } from './terminal-links';
import '@src/styles/xterm.css';
import '@xterm/xterm/css/xterm.css';

import { Shell } from '@sdk';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { useTheme } from 'next-themes';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FONT_FAMILY,
  FONT_SIZE_PX,
  applyRtlGridContract,
  registerOsc52ClipboardWrite,
} from './terminalConfig';
import { DARK_THEME, LIGHT_THEME } from './terminalThemes';

interface SidecarShellTerminalProps {
  shellId: string;
  active: boolean;
  className?: string;
}

export const SidecarShellTerminal: React.FC<SidecarShellTerminalProps> = ({ shellId, active, className = '' }) => {
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const shellRef = useRef<Shell | null>(null);
  const activateLink = useTerminalLinkHandler(shellRef);
  const [terminalReady, setTerminalReady] = useState(false);
  const [shell, setShell] = useState<Shell | null>(null);

  // Theme updates
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.theme = resolvedTheme === 'dark' ? DARK_THEME : LIGHT_THEME;
  }, [resolvedTheme]);

  // React to entity readiness instead of retrying a ref that cannot trigger effects.
  useEffect(() => {
    let disposed = false;
    setShell(null);
    shellRef.current = null;
    void Shell.getById(shellId).then((loaded) => {
      if (disposed) return;
      shellRef.current = loaded ?? null;
      setShell(loaded ?? null);
    }).catch((error) => console.error('[SidecarShellTerminal] Failed to load shell:', error));
    return () => { disposed = true; };
  }, [shellId]);

  // Terminal init/dispose
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof window === 'undefined') return;
    if (terminalRef.current) return;

    let disposed = false;
    let fitTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const term = new XTerm({
      scrollback: 10000,
      convertEol: true,
      cursorBlink: true,
      scrollOnUserInput: true,
      disableStdin: false,
      cursorStyle: 'block',
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE_PX,
      fontWeight: '400',
      fontWeightBold: '700',
      allowTransparency: true,
      allowProposedApi: true,
    });

    registerTerminalLinks(term, activateLink);

    const fit = new FitAddon();
    term.loadAddon(fit);

    try {
      term.open(container);
      // A plain shell emits logical order on every platform — no CLI here that
      // pre-reverses, so this terminal always takes the browser-bidi contract.
      applyRtlGridContract(container, 'unknown');
      terminalRef.current = term;
      fitAddonRef.current = fit;
      registerOsc52ClipboardWrite(term);
    } catch (e) {
      console.error('[SidecarShellTerminal] Failed to open terminal:', e);
      return;
    }

    term.options.theme = resolvedTheme === 'dark' ? DARK_THEME : LIGHT_THEME;

    fitTimeoutId = setTimeout(() => {
      if (!disposed) {
        try {
          fit.fit();
          setTerminalReady(true);
          if (active) term.focus();
        } catch (e) {
          console.warn('[SidecarShellTerminal] Failed to fit:', e);
          setTerminalReady(true);
        }
      }
    }, 50);

    return () => {
      disposed = true;
      if (fitTimeoutId) clearTimeout(fitTimeoutId);
      setTerminalReady(false);
      if (terminalRef.current) {
        const t = terminalRef.current;
        setTimeout(() => {
          try {
            t.dispose();
          } catch {
            /* ignore */
          }
        }, 10);
        terminalRef.current = null;
        fitAddonRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellId]);

  // Shell owns replay and live output. Subscribe after attach, when onOutput is available.
  useEffect(() => {
    const term = terminalRef.current;
    if (!terminalReady || !shell || !term) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      if (!shell.connected) {
        await shell.start({ cols: term.cols, rows: term.rows, workdir: shell.workdir ?? undefined });
      }
      if (disposed) return;
      term.reset();
      for (const chunk of shell.getPtyChunks()) term.write(chunk.data);
      unsubscribe = shell.onOutput((data) => term.write(data));
    })().catch((error) => console.error('[SidecarShellTerminal] Failed to attach shell:', error));
    return () => { disposed = true; unsubscribe?.(); };
  }, [shell, terminalReady]);

  // Input handler
  useEffect(() => {
    if (!terminalReady || !terminalRef.current) return;
    const term = terminalRef.current;
    const disp = term.onData(async (data: string) => {
      const shell = shellRef.current;
      if (shell?.connected) await shell.sendInput(data);
    });
    return () => disp.dispose();
  }, [terminalReady]);

  // ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !terminalReady) return;

    const observer = new ResizeObserver(() => {
      if (!active) return;
      const fit = fitAddonRef.current;
      const term = terminalRef.current;
      if (!fit || !term) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const shell = shellRef.current;
      if (shell?.connected) {
        void shell.resize(term.cols, term.rows);
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [active, terminalReady, shellId]);

  // Focus and fit when becoming active
  useEffect(() => {
    if (!active || !terminalReady) return;
    const term = terminalRef.current;
    const fit = fitAddonRef.current;
    if (!term || !fit) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        term.scrollToBottom();
        term.refresh(0, Math.max(0, term.rows - 1));
        term.focus();
        const shell = shellRef.current;
        if (shell?.connected) {
          void shell.resize(term.cols, term.rows);
        }
      } catch {
        /* ignore */
      }
    });
  }, [active, terminalReady]);

  return (
    <div
      ref={containerRef}
      className={`min-h-0 flex-1 ${className}`}
      onClick={() => terminalRef.current?.focus()}
      tabIndex={0}
    />
  );
};
