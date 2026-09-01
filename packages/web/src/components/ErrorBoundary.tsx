import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render error and says something, instead of a blank white page.
 *
 * A React error unmounts the whole tree, so one bad field on one screen wipes
 * the entire application and leaves nothing on screen to act on. That has
 * cost real testing time here: "the screen goes blank" gives the person
 * using it nothing to report and nowhere to go.
 *
 * A class component because that is the only way React exposes this.
 */
interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console so the detail is recoverable when reporting it.
    console.error('Screen failed to render:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>This screen could not be displayed</h2>
        <p>
          Something on this page failed to load. The rest of Alka Vida is fine —
          use the menu on the left to carry on.
        </p>
        <p className="muted small">
          If Alka Vida was updated recently, close this window and open it again:
          a screen from a newer version cannot talk to a copy that is still
          running the old one.
        </p>
        <div className="notice error" style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {error.message}
        </div>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>{' '}
        <button type="button" className="secondary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
