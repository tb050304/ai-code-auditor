"use client";
import React, { useState, useCallback } from "react";
import type { FileSnapshot, SnapshotSource, SnapshotMeta } from "@/lib/snapshots";
import { formatSize } from "@/lib/storage/import";
import { inferMonacoLanguage } from "@/lib/monaco-lang";
import DiffViewer, { type DiffApplyAction } from "@/components/diff/DiffViewer";

/** 面板数据：快照列表（新 → 旧）+ 当前 VFS 内容（current 为 null 表示文件已删除） */
export interface FileHistoryData {
  snaps: FileSnapshot[];
  current: string | null;
}

interface FileHistoryPanelProps {
  open: boolean;
  /** 要查看历史的文件路径；null 时面板不渲染 */
  path: string | null;
  /** 快照列表 + 当前内容；null = 加载中（由打开方负责加载） */
  data: FileHistoryData | null;
  onClose: () => void;
  /** 回滚到指定快照（回滚前自动快照当前内容，由实现方保证） */
  onRestoreSnapshot: (snapshotId: string) => Promise<FileSnapshot>;
  /** 应用合并结果回写 VFS（写前自动快照，由实现方保证）；文件已删除时不传 */
  onWriteFile?: (path: string, content: string, meta?: SnapshotMeta) => Promise<unknown>;
  /** 重新加载时间线（回滚 / 应用后调用） */
  onReload: (path: string) => Promise<void>;
}

const SOURCE_BADGE: Record<SnapshotSource, { label: string; cls: string }> = {
  "manual-save": { label: "保存", cls: "bg-cyan-500/15 text-cyan-400 border-cyan-600/40" },
  "auto-fix": { label: "自动修复", cls: "bg-violet-500/15 text-violet-400 border-violet-600/40" },
  agent: { label: "Agent", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-600/40" },
  rollback: { label: "回退", cls: "bg-amber-500/15 text-amber-400 border-amber-600/40" },
  "diff-apply": { label: "对比应用", cls: "bg-sky-500/15 text-sky-400 border-sky-600/40" },
  import: { label: "导入", cls: "bg-slate-500/15 text-slate-400 border-slate-600/40" },
  external: { label: "外部", cls: "bg-slate-500/15 text-slate-400 border-slate-600/40" },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function FileHistoryPanel({
  open,
  path,
  data,
  onClose,
  onRestoreSnapshot,
  onWriteFile,
  onReload,
}: FileHistoryPanelProps) {
  const [isWorking, setIsWorking] = useState(false);
  const [message, setMessage] = useState("");
  /** 正在对比的快照（null = 关闭 diff 弹窗） */
  const [diffSnapshot, setDiffSnapshot] = useState<FileSnapshot | null>(null);

  const showMsg = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(""), 3000);
  }, []);

  // 关闭时重置瞬时状态
  const handleClose = useCallback(() => {
    setDiffSnapshot(null);
    setMessage("");
    onClose();
  }, [onClose]);

  const handleRestore = useCallback(
    async (snap: FileSnapshot, missing: boolean) => {
      if (isWorking || !path) return;
      const ok = confirm(
        missing
          ? `文件当前已被删除，回滚将恢复该文件到 ${formatTime(snap.createdAt)} 的版本。`
          : `回滚「${path.slice(1)}」到 ${formatTime(snap.createdAt)} 的版本？\n\n当前内容会自动保存为快照，可随时再滚回来。`,
      );
      if (!ok) return;

      setIsWorking(true);
      try {
        await onRestoreSnapshot(snap.id);
        showMsg("✓ 已回滚到所选版本");
        await onReload(path);
      } catch (e) {
        showMsg(`回滚失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setIsWorking(false);
      }
    },
    [isWorking, path, onRestoreSnapshot, showMsg, onReload],
  );

  // Day 11 同款应用链路：从任意历史快照做部分/全部回退（写前自动快照 → 回写 → 刷新时间线）
  const handleApplyMerge = useCallback(
    async (mergedText: string, action: DiffApplyAction) => {
      if (!path || !onWriteFile) return;
      const isRollback = action === "rollback-all";
      await onWriteFile(path, mergedText, {
        source: isRollback ? "rollback" : "diff-apply",
        description: isRollback ? "Diff 全部回退前自动快照" : "Diff 合并应用前自动快照",
      });
      setDiffSnapshot(null);
      showMsg(
        isRollback ? "✓ 已回退到快照版本，回退前内容已自动快照" : "✓ 合并结果已写入，应用前内容已自动快照",
      );
      await onReload(path);
    },
    [path, onWriteFile, showMsg, onReload],
  );

  if (!open || !path) return null;

  const isLoading = data === null;
  const snaps = data?.snaps ?? [];
  const currentContent = data?.current ?? null;
  const newest = snaps[0];
  const currentMatchesNewest = currentContent !== null && newest?.content === currentContent;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-[520px] max-w-[92vw] max-h-[80vh] flex flex-col shadow-2xl">
        {/* 头部 */}
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="text-sm font-medium text-slate-200">🕘 文件历史</span>
            <div className="text-[11px] text-slate-500 truncate font-mono mt-0.5">{path.slice(1)}</div>
          </div>
          <button className="text-slate-500 hover:text-slate-300 text-sm" onClick={handleClose} title="关闭">
            ✕
          </button>
        </div>

        {/* 操作结果提示 */}
        {message && (
          <div className="px-4 py-2 text-xs text-cyan-400 border-b border-slate-800">{message}</div>
        )}

        {/* 时间线 */}
        <div className="flex-1 overflow-y-auto min-h-[120px]">
          {isLoading ? (
            <div className="p-4 text-xs text-slate-500 text-center">加载中...</div>
          ) : (
            <div className="px-4 py-2">
              {/* 当前版本（时间线最新状态） */}
              <div className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-cyan-400 flex-shrink-0" />
                  <span className="text-sm text-cyan-300">当前版本</span>
                  {currentContent === null ? (
                    <span className="px-1.5 py-0.5 text-[10px] rounded border bg-red-500/15 text-red-400 border-red-600/40">
                      文件已删除
                    </span>
                  ) : (
                    currentMatchesNewest && (
                      <span className="text-[10px] text-slate-600">与最新快照一致</span>
                    )
                  )}
                </div>
                <span className="text-[10px] text-slate-600 flex-shrink-0">
                  {currentContent === null ? "—" : formatSize(currentContent.length)}
                </span>
              </div>

              {/* 快照列表（新 → 旧） */}
              {snaps.length === 0 ? (
                <div className="py-6 text-xs text-slate-500 text-center border-t border-slate-800/60">
                  还没有历史快照。每次保存 / 回退 / 修复前会自动生成。
                </div>
              ) : (
                <div className="border-t border-slate-800/60">
                  {snaps.map((snap, idx) => {
                    const badge = SOURCE_BADGE[snap.source] ?? SOURCE_BADGE.external;
                    return (
                      <div key={snap.id} className="relative pl-5 py-2.5 group hover:bg-slate-800/40 rounded">
                        {/* 时间线竖线与节点 */}
                        <span
                          className={`absolute left-[3px] top-4 w-1.5 h-1.5 rounded-full ${
                            idx === 0 ? "bg-amber-400" : "bg-slate-600"
                          }`}
                        />
                        {idx < snaps.length - 1 && (
                          <span className="absolute left-[6px] top-7 bottom-0 w-px bg-slate-800" />
                        )}
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-slate-300 whitespace-nowrap">
                                {formatTime(snap.createdAt)}
                              </span>
                              <span
                                className={`px-1.5 py-0.5 text-[10px] rounded border whitespace-nowrap ${badge.cls}`}
                              >
                                {badge.label}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                              {snap.encoding === "delta" && snap.storedSize !== undefined ? (
                                <span title={`增量补丁存储；全量内容约 ${formatSize(snap.size)}`}>
                                  <span className="text-sky-400">增量 {formatSize(snap.storedSize)}</span>
                                  {` · 全量 ${formatSize(snap.size)}`}
                                </span>
                              ) : (
                                formatSize(snap.size)
                              )}
                              {snap.description ? ` · ${snap.description}` : ""}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                            <button
                              onClick={() => setDiffSnapshot(snap)}
                              disabled={isWorking}
                              className="px-2 py-1 text-[11px] text-slate-300 border border-slate-600/60 rounded hover:bg-slate-700/40 disabled:opacity-40 whitespace-nowrap"
                              title="对比该快照与当前版本"
                            >
                              对比
                            </button>
                            <button
                              onClick={() => handleRestore(snap, currentContent === null)}
                              disabled={isWorking}
                              className="px-2 py-1 text-[11px] text-cyan-400 border border-cyan-600/40 rounded hover:bg-cyan-500/10 disabled:opacity-40 whitespace-nowrap"
                            >
                              {isWorking ? "回滚中..." : "回滚"}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 底部说明 */}
        <div className="px-4 py-2 border-t border-slate-800 text-[11px] text-slate-600">
          时间线从新到旧；「对比」查看快照与当前版本的差异，「回滚」覆盖当前内容（当前内容自动快照，不会丢失）。
        </div>
      </div>

      {/* Diff 弹窗：快照版本 vs 当前版本 */}
      {diffSnapshot && (
        <DiffViewer
          key={`${path}:${diffSnapshot.id}`}
          open={!!diffSnapshot}
          onClose={() => setDiffSnapshot(null)}
          title={`${path.slice(1)} · ${formatTime(diffSnapshot.createdAt)}`}
          original={diffSnapshot.content}
          modified={currentContent ?? ""}
          language={inferMonacoLanguage(path)}
          originalLabel={`快照 ${formatTime(diffSnapshot.createdAt)}`}
          modifiedLabel={currentContent === null ? "已删除" : "当前版本"}
          onApply={currentContent === null ? undefined : handleApplyMerge}
        />
      )}
    </div>
  );
}
