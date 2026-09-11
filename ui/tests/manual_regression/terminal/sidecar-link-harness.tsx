/** Mount the real sidecar against the running app's router and backend, without an LLM. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Router, createPath } from 'react-router';
import { router } from '@src/router';
import { SidecarShellTerminal } from '@src/components/terminal/interactive-terminal/SidecarShellTerminal';

export function mountSidecar(shellId: string): () => void {
  const host = document.createElement('div');
  host.dataset.testid = 'sidecar-link-harness';
  Object.assign(host.style, {
    position: 'fixed', inset: '80px 40px 80px 350px', zIndex: '100', display: 'flex', background: 'white',
  });
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <Router location={router.state.location} navigator={{
      createHref: (to) => typeof to === 'string' ? to : createPath(to),
      go: (delta) => { void router.navigate(delta); },
      push: (to, state) => { void router.navigate(to, { state }); },
      replace: (to, state) => { void router.navigate(to, { state, replace: true }); },
    }}>
      <SidecarShellTerminal shellId={shellId} active />
    </Router>,
  );
  return () => { root.unmount(); host.remove(); };
}
