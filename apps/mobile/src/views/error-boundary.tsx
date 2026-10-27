import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * A blank screen is the one failure nobody can report. This catches whatever the
 * WebView threw and puts the message on screen, with the build stamp, so a
 * broken render becomes a sentence instead of an empty page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the component stack where a devtools session can find it.
    console.error("render failed", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="screen crash">
        <header className="bar">
          <h1>出错了</h1>
        </header>
        <main>
          <p className="crash-line">{error.message || String(error)}</p>
          <pre className="crash-stack">{String(error.stack ?? "").split("\n").slice(0, 6).join("\n")}</pre>
          <p className="muted">构建 {__BUILD_STAMP__}</p>
          <button className="primary wide" onClick={() => location.reload()}>
            重新加载
          </button>
        </main>
      </div>
    );
  }
}
