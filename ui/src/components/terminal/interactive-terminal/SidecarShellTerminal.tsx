import '@src/styles/xterm.css';
import '@xterm/xterm/css/xterm.css';

import { dataContext, Shell } from '@sdk';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';
import { useTheme } from 'next-themes';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FONT_FAMILY,
  FONT_SIZE_PX,
  applyRtlGridContract,
  openTerminalLink,
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
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE_PX,
      fontWeight: '400',
      fontWeightBold: '700',
      allowTransparency: true,
      allowProposedApi: true,
    });

    term.loadAddon(new WebLinksAddon(openTerminalLink));

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
