import '@src/styles/xterm.css';
import '@xterm/xterm/css/xterm.css';

import { dataContext, Shell } from '@sdk';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';
import { useTheme } from 'next-themes';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

const DARK_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  selectionBackground: 'rgba(255, 255, 255, 0.3)',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1e1e1e',
  cursor: '#1e1e1e',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(0, 122, 204, 0.18)',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
};

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
  const [terminalReady, setTerminalReady] = useState(false);
  const reattachBufferRef = useRef<string[] | null>([]);
  const ptyOwnedRef = useRef(false);

  // Theme updates
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.theme = resolvedTheme === 'dark' ? DARK_THEME : LIGHT_THEME;
  }, [resolvedTheme]);

  // Load shell entity
  useEffect(() => {
    Shell.getById(shellId)
      .then((s) => {
        shellRef.current = s ?? null;
      })
      .catch(() => {
        shellRef.current = null;
      });
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
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      fontWeight: '400',
      fontWeightBold: '700',
      allowTransparency: true,
      allowProposedApi: true,
    });

    term.loadAddon(new WebLinksAddon());

    const fit = new FitAddon();
    term.loadAddon(fit);

    try {
      term.open(container);
      terminalRef.current = term;
      fitAddonRef.current = fit;
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

  // Connect to PTY when terminal is ready
  useEffect(() => {
    if (!terminalReady || !shellId) return;

    let retryCount = 0;
    const maxRetries = 5;

    const connect = async () => {
      const shell = shellRef.current;
      if (!shell) {
        if (retryCount < maxRetries) {
          retryCount++;
          setTimeout(() => void connect(), 500);
        }
        return;
      }

      if (ptyOwnedRef.current) return;
      ptyOwnedRef.current = true;

      const cols = terminalRef.current?.cols || 80;
      const rows = terminalRef.current?.rows || 24;
      const workingDir = shell.workdir || dataContext.project?.fs_storage_mount_path || undefined;
      await shell.start({ cols, rows, workdir: workingDir });
    };

    void connect();
  }, [terminalReady, shellId]);

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

  // Output handler
  useEffect(() => {
    if (!shellId) return;
    const shell = shellRef.current;

    const handleData = (data: string) => {
      if (reattachBufferRef.current !== null) {
        reattachBufferRef.current.push(data);
        return;
      }
      const term = terminalRef.current;
      if (term) {
        try {
          term.write(data);
        } catch {
          /* ignore */
        }
      }
    };

    const unsub = shell?.onOutput(handleData);
    return () => {
      unsub?.();
    };
  }, [shellId, terminalReady]);

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
