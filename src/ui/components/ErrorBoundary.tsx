import { Component, type ReactNode } from 'react';

/** 页面级错误边界：某个页面渲染出错时不至于白屏 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-bad/40 bg-[#2a1416] p-5 text-sm">
          <div className="mb-2 font-semibold text-bad">页面出错了</div>
          <pre className="whitespace-pre-wrap text-xs text-[#ffb4b4]">{this.state.error.message}</pre>
          <button className="mt-3 cursor-pointer rounded border border-line px-3 py-1 text-xs" onClick={() => this.setState({ error: null })}>
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
