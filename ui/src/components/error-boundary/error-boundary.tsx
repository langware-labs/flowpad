import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  /** Rendered instead of `children` when a descendant throws during render. */
  fallback: ReactNode;
  /** Included in the console.error so the log says which boundary tripped. */
  label?: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches a render-time throw from its subtree and shows `fallback` instead of
 * letting it reach the router.
 *
 * The app's only other boundary is react-router's `errorElement` on the ROOT
 * route (`router.tsx`), which works at route granularity — so before this,
 * anything that threw while rendering replaced the WHOLE application with
 * `<ErrorScreen>`. That is how one malformed feed row blanked the app
 * (FLOWPAD-1974: a non-UUID `diagnosis_id` reached `new TypeId(...)` inside a
 * `useMemo`). Wrap a subtree in this to make its failure local.
 *
 * Must be a class — `getDerivedStateFromError`/`componentDidCatch` have no hook
 * equivalent.
 *
 * Two things it deliberately does NOT do:
 *  - **Catch async/event-handler errors.** React boundaries only see errors
 *    thrown during render and lifecycle. A throw inside an `onClick` still
 *    escapes; that is React's contract, not an omission here.
 *  - **Reset itself.** Once tripped it stays tripped until it remounts. Give it
 *    a `key` tied to the thing it wraps so a new item gets a fresh boundary.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Always log: the fallback is by design an ordinary-looking empty state, so
    // without this the crash is silent and nobody learns the data is broken.
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}]`, error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}
