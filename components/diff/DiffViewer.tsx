"use client";
import React, { useRef, useEffect, useState, useMemo, useCallback } from "react";
import dynamic from "next/dynamic";
import type { Monaco } from "@monaco-editor/react";
import {
  computeChunks,
  getChangeChunks,
  mergeLines,
  splitLines,
  describeChunkRange,
  type DiffChunk,
} from "@/lib/diff/lines";

// 延迟加载 Monaco DiffEditor，与主编辑器一致避免首屏开销
const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.DiffEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        加载对比视图...
      </div>
    ),
  },
);

export interface DiffViewerProps {
  open: boolean;
  onClose: () => void;
  /** 标题，通常是文件路径 */
  title: string;
  /** 旧内容（左侧 / 回退目标一侧） */
  original: string;
  /** 新内容（右侧 / 当前一侧） */
  modified: string;
  /** Monaco 语言 id，如 typescript / json */
  language?: string;
  originalLabel?: string;
  modifiedLabel?: string;
  /**
   * 应用合并结果回调。
   * 提供时底部显示"应用合并结果"按钮（Day 11 的回退流程会接入）；
   * 不提供时显示"复制合并结果"，仅预览。
   */
  onApply?: (mergedText: string) => void | Promise<void>;
}

type Decision = "accepted" | "rejected";

export default function DiffViewer({
  open,
  onClose,
  title,
  original,
  modified,
  language = "plaintext",
  originalLabel = "旧版本",
  modifiedLabel = "新版本",
  onApply,
}: DiffViewerProps) {
  const diffEditorRef = useRef<any>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const originalDecoRef = useRef<string[]>([]);
  const modifiedDecoRef = useRef<string[]>([]);

  const [inline, setInline] = useState(false);
  // 每个 change 块的决策；默认全部拒绝（保留旧版本，安全侧默认）
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState("");

  const oldLines = useMemo(() => splitLines(original), [original]);
  const newLines = useMemo(() => splitLines(modified), [modified]);
  const chunks = useMemo(() => computeChunks(oldLines, newLines), [oldLines, newLines]);
  const changes = useMemo(() => getChangeChunks(chunks), [chunks]);

  // 弹窗打开时重置状态
  useEffect(() => {
    if (open) {
      setDecisions({});
      setInline(false);
      setMessage("");
    }
  }, [open, original, modified]);

  const acceptedIds = useMemo(() => {
    const set = new Set<number>();
    for (const [id, d] of Object.entries(decisions)) {
      if (d === "accepted") set.add(Number(id));
    }
    return set;
  }, [decisions]);

  const mergedText = useMemo(
    () => mergeLines(oldLines, newLines, chunks, acceptedIds).join("\n"),
    [oldLines, newLines, chunks, acceptedIds],
  );

  const acceptAll = useCallback(() => {
    const all: Record<number, Decision> = {};
    for (const c of changes) if (c.id !== undefined) all[c.id] = "accepted";
    setDecisions(all);
  }, [changes]);

  const rejectAll = useCallback(() => setDecisions({}), []);

  const setChunkDecision = useCallback((id: number, decision: Decision) => {
    setDecisions((prev) => ({ ...prev, [id]: decision }));
  }, []);

  const showMsg = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(""), 2500);
  }, []);

  // 根据决策更新左右两侧的行高亮
  useEffect(() => {
    const diffEditor = diffEditorRef.current;
    const monaco = monacoRef.current;
    if (!diffEditor || !monaco) return;

    const origEditor = diffEditor.getOriginalEditor();
    const modEditor = diffEditor.getModifiedEditor();
    if (!origEditor || !modEditor) return;

    const origDecos: any[] = [];
    const modDecos: any[] = [];

    for (const chunk of changes) {
      const decision: Decision =
        chunk.id !== undefined && decisions[chunk.id] === "accepted"
          ? "accepted"
          : "rejected";
      const accepted = decision === "accepted";

      // 旧侧：有旧行时才装饰（纯插入没有旧行）
      if (chunk.oldEnd > chunk.oldStart) {
        origDecos.push({
          range: new monaco.Range(chunk.oldStart + 1, 1, chunk.oldEnd, 1),
          options: {
            isWholeLine: true,
            className: accepted ? "diff-chunk-old-accepted" : "diff-chunk-old-rejected",
          },
        });
      }
      // 新侧：有新行时才装饰（纯删除没有新行）
      if (chunk.newEnd > chunk.newStart) {
        modDecos.push({
          range: new monaco.Range(chunk.newStart + 1, 1, chunk.newEnd, 1),
          options: {
            isWholeLine: true,
            className: accepted ? "diff-chunk-new-accepted" : "diff-chunk-new-rejected",
          },
        });
      }
    }

    originalDecoRef.current = origEditor.deltaDecorations(originalDecoRef.current, origDecos);
    modifiedDecoRef.current = modEditor.deltaDecorations(modifiedDecoRef.current, modDecos);
  }, [decisions, changes]);

  const handleMount = useCallback((diffEditor: any, monaco: Monaco) => {
    diffEditorRef.current = diffEditor;
    monacoRef.current = monaco;

    // 关闭与主编辑器一致的 TS/JS 诊断
    monaco.languages.typescript?.typescriptDefaults?.setDiagnosticsOptions({
      noSyntaxValidation: true,
      noSemanticValidation: true,
    });
    monaco.languages.typescript?.javascriptDefaults?.setDiagnosticsOptions({
      noSyntaxValidation: true,
      noSemanticValidation: true,
    });

    // chunk 决策高亮样式（注入一次）
    if (!document.getElementById("diff-viewer-styles")) {
      const style = document.createElement("style");
      style.id = "diff-viewer-styles";
      style.textContent = `
        .diff-chunk-new-accepted {
          background-color: rgba(34, 197, 94, 0.18) !important;
          border-left: 3px solid #22c55e;
        }
        .diff-chunk-old-accepted {
          opacity: 0.45;
        }
        .diff-chunk-new-rejected {
          background-color: rgba(239, 68, 68, 0.15) !important;
          border-left: 3px solid #ef4444;
        }
        .diff-chunk-old-rejected {
          border-left: 3px solid rgba(148, 163, 184, 0.5);
        }
      `;
      document.head.appendChild(style);
    }
  }, []);

  const revealChunk = useCallback((chunk: DiffChunk) => {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor) return;
    // 优先定位到新侧位置；纯删除定位到旧侧
    const line = chunk.newEnd > chunk.newStart ? chunk.newStart + 1 : chunk.oldStart + 1;
    diffEditor.revealLineInCenter(line);
  }, []);

  const handleApply = useCallback(async () => {
    if (!onApply || applying) return;
    setApplying(true);
    try {
      await onApply(mergedText);
    } catch (e) {
      showMsg(`应用失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApplying(false);
    }
  }, [onApply, applying, mergedText, showMsg]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(mergedText);
      showMsg("✓ 合并结果已复制到剪贴板");
    } catch {
      showMsg("复制失败（浏览器未授权剪贴板）");
    }
  }, [mergedText, showMsg]);

  if (!open) return null;

  const acceptedCount = acceptedIds.size;
  const rejectedCount = changes.length - acceptedCount;
  const identical = changes.length === 0;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-[92vw] h-[86vh] flex flex-col shadow-2xl overflow-hidden">
        {/* 头部 */}
        <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <span className="text-sm font-medium text-slate-200 truncate">🔍 {title}</span>
            <div className="flex items-center bg-slate-800 rounded text-xs overflow-hidden flex-shrink-0">
              <button
                onClick={() => setInline(false)}
                className={`px-2.5 py-1 ${!inline ? "bg-cyan-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                左右对比
              </button>
              <button
                onClick={() => setInline(true)}
                className={`px-2.5 py-1 ${inline ? "bg-cyan-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                内联对比
              </button>
            </div>
          </div>
          <button
            className="text-slate-500 hover:text-slate-300 text-sm flex-shrink-0"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* 主体：diff + chunk 列表面板 */}
        <div className="flex-1 flex min-h-0">
          <div className="flex-1 min-w-0">
            {identical ? (
              <div className="flex items-center justify-center h-full text-slate-500 text-sm">
                ✓ 两版内容完全一致，没有差异
              </div>
            ) : (
              <MonacoDiffEditor
                height="100%"
                language={language}
                original={original}
                modified={modified}
                onMount={handleMount}
                options={{
                  readOnly: true,
                  renderSideBySide: !inline,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                  renderLineHighlight: "all",
                  originalEditable: false,
                  diffWordWrap: "on",
                }}
              />
            )}
          </div>

          {/* chunk 列表 */}
          {!identical && (
            <div className="w-60 flex-shrink-0 border-l border-slate-800 flex flex-col">
              <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
                <span className="text-xs text-slate-400">
                  变更块（{changes.length}）
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={acceptAll}
                    className="px-1.5 py-0.5 text-[10px] text-green-400 border border-green-700/50 rounded hover:bg-green-500/10"
                    title="全部接受"
                  >
                    全接受
                  </button>
                  <button
                    onClick={rejectAll}
                    className="px-1.5 py-0.5 text-[10px] text-red-400 border border-red-700/50 rounded hover:bg-red-500/10"
                    title="全部拒绝"
                  >
                    全拒绝
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {changes.map((chunk, idx) => {
                  const accepted = chunk.id !== undefined && decisions[chunk.id] === "accepted";
                  const range = describeChunkRange(chunk);
                  const preview =
                    chunk.newEnd > chunk.newStart
                      ? newLines[chunk.newStart]
                      : oldLines[chunk.oldStart];
                  return (
                    <div
                      key={chunk.id}
                      className={`px-3 py-2 border-b border-slate-800/60 cursor-pointer hover:bg-slate-800/40 ${
                        accepted ? "bg-green-500/5" : ""
                      }`}
                      onClick={() => revealChunk(chunk)}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-slate-400">
                          #{idx + 1} 旧 {range.old} → 新 {range.new}
                        </span>
                        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => chunk.id !== undefined && setChunkDecision(chunk.id, "accepted")}
                            className={`w-5 h-5 text-[11px] rounded ${
                              accepted
                                ? "bg-green-600 text-white"
                                : "text-slate-500 hover:text-green-400 border border-slate-700"
                            }`}
                            title="接受此块（取新版本）"
                          >
                            ✓
                          </button>
                          <button
                            onClick={() => chunk.id !== undefined && setChunkDecision(chunk.id, "rejected")}
                            className={`w-5 h-5 text-[11px] rounded ${
                              !accepted
                                ? "bg-red-600 text-white"
                                : "text-slate-500 hover:text-red-400 border border-slate-700"
                            }`}
                            title="拒绝此块（保留旧版本）"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div className="text-[11px] text-slate-600 truncate mt-0.5 font-mono">
                        {preview?.trim() || (chunk.newEnd <= chunk.newStart ? "（删除）" : "")}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="px-4 py-2.5 border-t border-slate-800 flex items-center justify-between gap-3">
          <div className="text-[11px] text-slate-500">
            {identical ? (
              <span>无需操作</span>
            ) : (
              <span>
                共 {changes.length} 处变更 ·{" "}
                <span className="text-green-400">已接受 {acceptedCount}</span> ·{" "}
                <span className="text-red-400">已拒绝 {rejectedCount}</span>
                <span className="ml-2 text-slate-600">
                  （{originalLabel} → {modifiedLabel}）
                </span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {message && <span className="text-xs text-cyan-400">{message}</span>}
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            >
              关闭
            </button>
            {onApply ? (
              <button
                onClick={handleApply}
                disabled={applying || identical}
                className="px-3 py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white rounded transition-colors"
              >
                {applying ? "应用中..." : `应用合并结果${acceptedCount > 0 ? `（${acceptedCount} 处）` : ""}`}
              </button>
            ) : (
              <button
                onClick={handleCopy}
                disabled={identical}
                className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 rounded transition-colors"
              >
                复制合并结果
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
