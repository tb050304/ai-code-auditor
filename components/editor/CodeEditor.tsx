"use client";
import React, { useRef, useEffect, forwardRef, useImperativeHandle, useState } from "react";
import Editor, { Monaco, OnMount } from "@monaco-editor/react";
import TabBar from "./TabBar";
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
  onCancelBatchAnalysis?: () => void;
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
    onCancelBatchAnalysis,
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

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

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
            automaticLayout: true,
            glyphMargin: true,
            folding: true,
            lineNumbers: "on",
            renderLineHighlight: "all",
          }}
        />
      </div>

      {/* 底部：分析相关区域 */}
      <div className="shrink-0 border-t border-slate-800 bg-slate-900 flex flex-col">
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

        {/* 问题面板切换条 */}
        {fileResults && fileResults.size > 0 && (
          <>
            <div
              className="flex items-center justify-between px-3 py-1.5 text-xs cursor-pointer hover:bg-slate-800/40 border-t border-slate-800"
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
              <div className="h-56 border-t border-slate-800">
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
