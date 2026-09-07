"use client";
import React, { useRef, useEffect, forwardRef, useImperativeHandle, useState } from "react";
import dynamic from "next/dynamic";
import type { Monaco, OnMount } from "@monaco-editor/react";
import TabBar from "./TabBar";

// 延迟加载 Monaco Editor，避免首屏就拉起 Monaco 的编译和 Web Worker
const Editor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-slate-600 text-sm">
      加载编辑器...
    </div>
  ),
});
import AnalysisProgress from "./AnalysisProgress";
import IssuesPanel from "./IssuesPanel";
import type { EditorTab } from "@/hooks/useEditorTabs";
import type { BatchProgress, BatchAnalysisResult, FileAnalysisResult } from "@/lib/ast/batch-types";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface Issue {
  id: string;
  type: string;
  severity: "error" | "warning" | "info";
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  suggestion?: string;
}

interface CodeEditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  models?: ModelInfo[];
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  issues?: Issue[];
  onIssuesChange?: (issues: Issue[]) => void;
  fileName?: string;
  language?: string;
  // ---- 多 Tab 相关 ----
  tabs?: EditorTab[];
  activeTabPath?: string | null;
  onActivateTab?: (path: string) => void;
  onCloseTab?: (path: string) => void;
  onCloseOtherTabs?: (path: string) => void;
  onCloseAllTabs?: () => void;
  onSaveTab?: (path: string) => void;
  onRunAudit?: () => void;
  // ---- 批量分析进度 ----
  batchAnalyzing?: boolean;
  batchProgress?: BatchProgress | null;
  batchResult?: BatchAnalysisResult | null;
  batchError?: string | null;
  /** 收集文件内容中（startAnalysis 之前的阶段） */
  isPreparing?: boolean;
  /** 准备阶段的提示消息（如"无文件"或错误） */
  prepareMessage?: string;
  onCancelBatchAnalysis?: () => void;
  onStartBatchAnalysis?: () => void;
  onReanalyze?: () => void;
  // ---- 问题面板 ----
  fileResults?: Map<string, FileAnalysisResult>;
  onIssueClick?: (path: string, line: number) => void;
}

// 暴露给父组件的方法
export interface CodeEditorHandle {
  scrollToLine: (line: number) => void;
}

export default forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  {
    value,
    onChange,
    models = [],
    selectedModel,
    onModelChange,
    issues = [],
    onIssuesChange,
    fileName,
    language = "javascript",
    tabs = [],
    activeTabPath,
    onActivateTab,
    onCloseTab,
    onCloseOtherTabs,
    onCloseAllTabs,
    onSaveTab,
    batchAnalyzing = false,
    batchProgress = null,
    batchResult = null,
    batchError = null,
    isPreparing = false,
    prepareMessage = "",
    onCancelBatchAnalysis,
    onStartBatchAnalysis,
    onReanalyze,
    fileResults,
    onIssueClick,
  },
  ref
) {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const [showIssuesPanel, setShowIssuesPanel] = useState(true);
  const [issuesPanelHeight, setIssuesPanelHeight] = useState(224); // 56 * 4 = h-56
  const isDraggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // 暴露 scrollToLine 方法给父组件
  useImperativeHandle(ref, () => ({
    scrollToLine: (line: number) => {
      if (editorRef.current) {
        editorRef.current.revealLineInCenter(line);
        editorRef.current.setPosition({ lineNumber: line, column: 1 });
        editorRef.current.focus();
      }
    },
  }));

  // 高亮问题代码
  const highlightIssues = (editor: any, monaco: Monaco, issueList: Issue[]) => {
    if (!editor || !monaco) return;

    // 清除之前的高亮
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);

    if (issueList.length === 0) return;

    // 根据严重程度设置样式
    const getClassName = (severity: string) => {
      switch (severity) {
        case "error":
          return "issue-highlight-error";
        case "warning":
          return "issue-highlight-warning";
        default:
          return "issue-highlight-info";
      }
    };

    const getGlyphMarginClass = (severity: string) => {
      switch (severity) {
        case "error":
          return "issue-glyph-error";
        case "warning":
          return "issue-glyph-warning";
        default:
          return "issue-glyph-info";
      }
    };

    // 创建新的高亮
    const newDecorations = issueList.map((issue) => {
      // Monaco 使用 0-based 行号，但我们的 issue 是 1-based
      const startLineNumber = issue.startLine;
      const endLineNumber = issue.endLine;

      return {
        range: new monaco.Range(
          startLineNumber,
          issue.startColumn,
          endLineNumber,
          issue.endColumn
        ),
        options: {
          isWholeLine: false,
          className: getClassName(issue.severity),
          glyphMarginClassName: getGlyphMarginClass(issue.severity),
          hoverMessage: {
            value: `**${issue.message}**\n\n💡 ${issue.suggestion || "无建议"}`,
          },
          overviewRuler: {
            color: issue.severity === "error" ? "#f14c4c" : issue.severity === "warning" ? "#cca700" : "#1890ff",
            position: monaco.editor.OverviewRulerLane.Right,
          },
        },
      };
    });

    decorationsRef.current = editor.deltaDecorations([], newDecorations);
  };

  // 当 issues 变化时更新高亮
  useEffect(() => {
    if (editorRef.current && monacoRef.current) {
      highlightIssues(editorRef.current, monacoRef.current, issues);
    }
  }, [issues]);

  // 底部面板拖拽调整高度
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      e.preventDefault();
      const deltaY = startYRef.current - e.clientY;
      let newHeight = startHeightRef.current + deltaY;
      // 限制高度范围：100 ~ 600px
      newHeight = Math.max(100, Math.min(600, newHeight));
      setIssuesPanelHeight(newHeight);
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = issuesPanelHeight;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  };

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // 关闭 Monaco 自带的 TS/JS 语义和语法诊断
    // 我们的 AST 分析（Web Worker）才是权威的问题来源，
    // Monaco 自带的类型检查会给出大量无关飘红（缺 import、类型不匹配等），干扰用户
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSyntaxValidation: true,
      noSemanticValidation: true,
    });
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSyntaxValidation: true,
      noSemanticValidation: true,
    });

    // 手动管理 layout，替代 automaticLayout: true
    // automaticLayout 用 ResizeObserver 监听容器，但在 flex 布局中
    // 可能导致 layout() → reflow → resize → layout() 循环，CPU 持续拉满
    const container = editor.getContainerDomNode();
    let resizeRaf = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        editor.layout();
      });
    });
    resizeObserver.observe(container);

    // 编辑器卸载时清理
    editor.onDidDispose(() => {
      resizeObserver.disconnect();
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
    });

    // 注册自定义样式
    const style = document.createElement("style");
    style.textContent = `
      .issue-highlight-error {
        background-color: rgba(248, 81, 73, 0.2);
        border-bottom: 2px solid #f85149;
      }
      .issue-highlight-warning {
        background-color: rgba(201, 167, 0, 0.2);
        border-bottom: 2px solid #c9a700;
      }
      .issue-highlight-info {
        background-color: rgba(24, 144, 255, 0.2);
        border-bottom: 2px solid #1890ff;
      }
      .issue-glyph-error {
        background-color: #f85149;
        width: 4px !important;
        margin-left: 3px;
        border-radius: 2px;
      }
      .issue-glyph-warning {
        background-color: #c9a700;
        width: 4px !important;
        margin-left: 3px;
        border-radius: 2px;
      }
      .issue-glyph-info {
        background-color: #1890ff;
        width: 4px !important;
        margin-left: 3px;
        border-radius: 2px;
      }
      /* Tab 栏滚动条样式 */
      .scrollbar-thin::-webkit-scrollbar {
        height: 4px;
      }
      .scrollbar-thin::-webkit-scrollbar-track {
        background: transparent;
      }
      .scrollbar-thin::-webkit-scrollbar-thumb {
        background: #475569;
        border-radius: 2px;
      }
      .scrollbar-thin::-webkit-scrollbar-thumb:hover {
        background: #64748b;
      }
    `;
    document.head.appendChild(style);

    // 默认高亮
    if (issues.length > 0) {
      highlightIssues(editor, monaco, issues);
    }
  };

  const showTabs = tabs.length > 0;

  return (
    <section
      className="flex-1 flex flex-col border-r border-slate-800 min-w-0"
      style={{ minWidth: 0 }}
    >
      <header className="px-4 py-3 bg-slate-900 border-b border-slate-800 flex justify-between items-center shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <h1 className="text-sm font-bold text-cyan-400 flex-shrink-0">AI Code Auditor</h1>
          {!showTabs && fileName && (
            <span className="text-xs text-slate-400 bg-slate-800 px-2 py-1 rounded truncate" title={fileName}>
              📄 {fileName}
            </span>
          )}
          {!showTabs && (
            <span className="text-xs text-slate-500 bg-slate-800 px-2 py-1 rounded flex-shrink-0">
              {language}
            </span>
          )}
        </div>

        {models.length > 0 && onModelChange && (
          <select
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded px-3 py-1 text-sm text-slate-300 focus:outline-none focus:border-cyan-500"
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        )}
      </header>

      {/* 多 Tab 模式下的 Tab 栏 */}
      {showTabs && onActivateTab && onCloseTab && onCloseOtherTabs && onCloseAllTabs && (
        <TabBar
          tabs={tabs}
          activeTabPath={activeTabPath ?? null}
          onActivate={onActivateTab}
          onClose={onCloseTab}
          onCloseOthers={onCloseOtherTabs}
          onCloseAll={onCloseAllTabs}
          onSave={onSaveTab}
        />
      )}

      {/* min-h-0 是关键：让该 flex 子项可收缩到实际可用高度，否则会被 Monaco 内容高度撑开，产生多余的空白区可滚动 */}
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden relative">
        <Editor
          key={activeTabPath ?? "default"}
          height="100%"
          width="100%"
          defaultLanguage={language}
          language={language}
          theme="vs-dark"
          value={value}
          onChange={onChange}
          onMount={handleEditorDidMount}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            wordWrap: "on",
            automaticLayout: false,
            glyphMargin: true,
            folding: true,
            lineNumbers: "on",
            renderLineHighlight: "all",
          }}
        />
      </div>

      {/* 底部：分析相关区域 */}
      <div className="shrink-0 border-t border-slate-800 bg-slate-900 flex flex-col">
        {/* 准备中：收集文件内容阶段 */}
        {isPreparing && (
          <div className="px-3 py-2 flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-cyan-400">正在收集文件内容...</span>
          </div>
        )}

        {/* 准备阶段的提示消息（无文件/错误） */}
        {!isPreparing && prepareMessage && (
          <div className="px-3 py-2">
            <span className="text-xs text-amber-400">⚠ {prepareMessage}</span>
          </div>
        )}

        {/* 没有任何分析状态时：显示「开始批量分析」入口 */}
        {!isPreparing && !prepareMessage && !batchAnalyzing && !batchResult && !batchError &&
          (!fileResults || fileResults.size === 0) && onStartBatchAnalysis && (
            <div className="px-3 py-2 flex items-center justify-between gap-3">
              <span className="text-xs text-slate-500">
                还没有分析结果 —— 对当前项目所有支持文件运行 AST 静态分析
              </span>
              <button
                onClick={onStartBatchAnalysis}
                disabled={isPreparing}
                className="px-3 py-1 text-xs font-medium rounded bg-cyan-600/20 text-cyan-400 border border-cyan-600/40 hover:bg-cyan-600/40 hover:text-cyan-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="开始批量分析"
              >
                ⚡ 开始批量分析
              </button>
            </div>
          )}

        {/* 批量分析进度条 */}
        {(batchAnalyzing || batchResult || batchError) && (
          <AnalysisProgress
            isAnalyzing={batchAnalyzing}
            progress={batchProgress}
            result={batchResult}
            error={batchError}
            onCancel={onCancelBatchAnalysis}
            onReanalyze={onReanalyze}
          />
        )}

        {/* 问题面板切换条 + 拖拽手柄 */}
        {fileResults && fileResults.size > 0 && (
          <>
            {/* 拖拽调整手柄（放在标题栏顶部） */}
            <div
              onMouseDown={handleResizeStart}
              className="group relative h-2 cursor-ns-resize bg-slate-800 hover:bg-cyan-500/30 transition-colors"
              title="上下拖拽调整高度"
            >
              {/* 中间的抓握指示线 */}
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-0.5 rounded-full bg-slate-600 group-hover:bg-cyan-400 transition-colors" />
            </div>
            <div
              className="flex items-center justify-between px-3 py-1.5 text-xs cursor-pointer hover:bg-slate-800/40"
              onClick={() => setShowIssuesPanel((v) => !v)}
            >
              <div className="flex items-center gap-2">
                <span className="text-slate-500">{showIssuesPanel ? "▾" : "▸"}</span>
                <span className="text-slate-300 font-medium">问题面板</span>
                {batchResult && (
                  <span className="text-slate-500">
                    {batchResult.totalIssues} 个问题
                    {batchResult.highSeverity > 0 && (
                      <span className="text-red-400 ml-1">
                        · {batchResult.highSeverity} 高危</span>
                    )}
                  </span>
                )}
              </div>
            </div>
            {showIssuesPanel && (
              <div style={{ height: `${issuesPanelHeight}px` }} className="border-t border-slate-800">
                <IssuesPanel
                  fileResults={fileResults}
                  onIssueClick={onIssueClick}
                  activeFilePath={activeTabPath ?? null}
                />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
});
