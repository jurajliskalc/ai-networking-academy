import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps one broken page (bad content, widget bug) from blanking the whole app. */
export default class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[academy] render error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-2xl border border-danger/40 bg-danger/10 p-6">
        <div className="font-semibold text-danger">Something on this page failed to render.</div>
        <p className="mt-2 text-sm text-muted">{this.state.error.message}</p>
        <p className="mt-2 text-sm text-muted">Please report it on GitHub with the page address. Other pages still work.</p>
      </div>
    );
  }
}
