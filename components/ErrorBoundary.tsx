"use client";
/**
 * 全局错误边界（Day 28）
 *
 * 捕获 React 渲染层抛出的未处理异常，展示恢复 UI 而非白屏。
 * 用户可点击「重试」重新渲染，或「刷新页面」完全重启。
 */
import React, { Component, type ReactNode } from "react";
import { classifyError } from "@/lib/errors";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] 渲染异常:", error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const classified = classifyError(this.state.error);

    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950">
        <div className="w-[min(480px,92vw)] rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
          <div className="mb-4 flex items-center gap-3">
            <span className="text-2xl">⚠️</span>
            <h2 className="text-base font-semibold text-rose-400">页面渲染出错</h2>
          </div>

          <p className="mb-2 text-sm text-slate-300">{classified.message}</p>

          {this.state.error.message && (
            <details className="mb-4 rounded-lg border border-slate-700 bg-slate-950/50 p-3 text-xs">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-300">
                技术详情
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-all text-slate-400">
                {this.state.error.message}
                {"\n\n"}
                {this.state.error.stack}
              </pre>
            </details>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.handleRetry}
              className="flex-1 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500"
            >
              重试渲染
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="flex-1 rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
            >
              刷新页面
            </button>
          </div>
        </div>
      </div>
    );
  }
}
