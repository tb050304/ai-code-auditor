"use client";
import React, { useState, useCallback, useEffect } from "react";
import type { ProjectSnapshot, ProjectSnapshotSource } from "@/lib/snapshots";
import { formatSize } from "@/lib/storage/import";
import { inferMonacoLanguage } from "@/lib/monaco-lang";
import DiffViewer from "@/components/diff/DiffViewer";

interface ProjectSnapshotPanelProps {
  open: boolean;
  onClose: () => void;
  /** 当前是否有活动项目 */
  hasProject: boolean;
  onCreateSnapshot: (name: string, description?: string) => Promise<ProjectSnapshot>;
  onRestoreSnapshot: (id: string) => Promise<ProjectSnapshot>;
  onListSnapshots: () => Promise<ProjectSnapshot[]>;
  onDeleteSnapshot: (id: string) => Promise<void>;
  /** 读取当前 VFS 中文件内容，用于快照版本 vs 当前版本的对比；文件已删时抛错 */
  onReadCurrentFile?: (path: string) => Promise<string>;
}

/** diff 弹窗所需的数据 */
interface DiffTarget {
  path: string;
  snapshotContent: string;
  currentContent: string;
}

const SOURCE_BADGE: Record<ProjectSnapshotSource, { label: string; cls: string }> = {
  manual: { label: "手动", cls: "bg-cyan-500/15 text-cyan-400 border-cyan-600/40" },
  "restore-backup": {
    label: "恢复备份",
    cls: "bg-amber-500/15 text-amber-400 border-amber-600/40",
  },
  "auto-fix-batch": {
    label: "自动修复",
    cls: "bg-violet-500/15 text-violet-400 border-violet-600/40",
  },
  agent: { label: "Agent", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-600/40" },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function ProjectSnapshotPanel({
  open,
  onClose,
  hasProject,
  onCreateSnapshot,
  onRestoreSnapshot,
  onListSnapshots,
  onDeleteSnapshot,
  onReadCurrentFile,
}: ProjectSnapshotPanelProps) {
  const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [message, setMessage] = useState("");
  /** 正在查看文件列表的快照（对比入口） */
  const [comparingSnap, setComparingSnap] = useState<ProjectSnapshot | null>(null);
  /** 打开的 diff 目标 */
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [diffLoadingPath, setDiffLoadingPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!hasProject) return;
    setIsLoading(true);
    try {
      setSnapshots(await onListSnapshots());
    } catch (e) {
      console.error("加载快照列表失败:", e);
    } finally {
      setIsLoading(false);
    }
  }, [hasProject, onListSnapshots]);

  // 打开时加载一次
  useEffect(() => {
    if (open) {
      refresh();
    } else {
      // 关闭时退出文件对比子视图
      setComparingSnap(null);
      setDiffTarget(null);
    }
  }, [open, refresh]);

  const showMsg = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(""), 3000);
  }, []);

  const handleCreate = useCallback(async () => {
    if (isWorking) return;
    setIsWorking(true);
    try {
      await onCreateSnapshot(name, description.trim() || undefined);
      setName("");
      setDescription("");
      showMsg("✓ 快照已创建");
      await refresh();
    } catch (e) {
      showMsg(`创建失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsWorking(false);
    }
  }, [isWorking, name, description, onCreateSnapshot, showMsg, refresh]);

  const handleRestore = useCallback(
    async (snap: ProjectSnapshot) => {
      if (isWorking) return;
      const ok = confirm(
        `确认恢复到「${snap.name}」？\n\n` +
          `项目将回到该快照时的状态（${snap.fileCount} 个文件）。\n` +
          `恢复前的当前状态会自动备份为新快照，可随时再恢复回来。`,
      );
      if (!ok) return;

      setIsWorking(true);
      try {
        await onRestoreSnapshot(snap.id);
        showMsg("✓ 恢复完成");
        await refresh();
      } catch (e) {
        showMsg(`恢复失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setIsWorking(false);
      }
    },
    [isWorking, onRestoreSnapshot, showMsg, refresh],
  );

  const handleDelete = useCallback(
    async (snap: ProjectSnapshot) => {
      if (isWorking) return;
      if (!confirm(`确认删除快照「${snap.name}」？此操作不可撤销。`)) return;

      setIsWorking(true);
      try {
        await onDeleteSnapshot(snap.id);
        await refresh();
      } catch (e) {
        showMsg(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setIsWorking(false);
      }
    },
    [isWorking, onDeleteSnapshot, showMsg, refresh],
  );

  // 打开快照中某个文件与当前版本的 diff
  const handleOpenDiff = useCallback(
    async (snap: ProjectSnapshot, filePath: string) => {
      const snapshotContent =
        snap.files.find((f) => f.path === filePath)?.content ?? "";
      let currentContent = "";
      setDiffLoadingPath(filePath);
      try {
        currentContent = onReadCurrentFile
          ? await onReadCurrentFile(filePath)
          : "";
      } catch {
        // 文件已被删除 → 当前内容按空处理（diff 显示为删除状态）
        currentContent = "";
      } finally {
        setDiffLoadingPath(null);
      }
      setDiffTarget({ path: filePath, snapshotContent, currentContent });
    },
    [onReadCurrentFile],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-[480px] max-w-[92vw] max-h-[80vh] flex flex-col shadow-2xl">
        {/* 头部 */}
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          {comparingSnap ? (
            <button
              className="text-sm font-medium text-slate-300 hover:text-cyan-400 flex items-center gap-1 truncate"
              onClick={() => setComparingSnap(null)}
              title="返回快照列表"
            >
              <span>←</span>
              <span className="truncate">「{comparingSnap.name}」中的文件（点击对比当前版本）</span>
            </button>
          ) : (
            <span className="text-sm font-medium text-slate-200">📸 项目快照</span>
          )}
          <button
            className="text-slate-500 hover:text-slate-300 text-sm"
            onClick={onClose}
            title="关闭"
          >
            ✕
          </button>
        </div>

        {/* 创建快照（文件对比子视图下隐藏） */}
        {!comparingSnap && (
        <div className="p-4 border-b border-slate-800 space-y-2">
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && hasProject) handleCreate();
              }}
              placeholder="快照名称，如：修复前 / v1-原始版本"
              disabled={!hasProject || isWorking}
              className="flex-1 px-3 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded focus:outline-none focus:border-cyan-500 disabled:opacity-50 text-slate-200 placeholder:text-slate-600"
            />
            <button
              onClick={handleCreate}
              disabled={!hasProject || isWorking || !name.trim()}
              className="px-3 py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:hover:bg-cyan-600 text-white rounded transition-colors whitespace-nowrap"
            >
              {isWorking ? "处理中..." : "创建快照"}
            </button>
          </div>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述（可选）"
            disabled={!hasProject || isWorking}
            className="w-full px-3 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded focus:outline-none focus:border-cyan-500 disabled:opacity-50 text-slate-300 placeholder:text-slate-600"
          />
          {!hasProject && (
            <div className="text-xs text-slate-500">请先选择一个项目</div>
          )}
        </div>
        )}

        {/* 操作结果提示 */}
        {message && (
          <div className="px-4 py-2 text-xs text-cyan-400 border-b border-slate-800">
            {message}
          </div>
        )}

        {/* 文件对比子视图：列出快照中的全部文件 */}
        {comparingSnap ? (
          <div className="flex-1 overflow-y-auto min-h-[120px]">
            {comparingSnap.files.length === 0 ? (
              <div className="p-6 text-xs text-slate-500 text-center">该快照不包含任何文件</div>
            ) : (
              <div className="divide-y divide-slate-800">
                {comparingSnap.files.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => handleOpenDiff(comparingSnap, f.path)}
                    disabled={diffLoadingPath !== null}
                    className="w-full text-left px-4 py-2 hover:bg-slate-800/40 disabled:opacity-50 flex items-center justify-between gap-2"
                  >
                    <span className="text-xs text-slate-300 truncate font-mono">
                      {diffLoadingPath === f.path ? "加载中... " : "🔍 "}
                      {f.path.slice(1)}
                    </span>
                    <span className="text-[10px] text-slate-600 flex-shrink-0">
                      {formatSize(f.content.length)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
        /* 快照列表 */
        <div className="flex-1 overflow-y-auto min-h-[120px]">
          {isLoading ? (
            <div className="p-4 text-xs text-slate-500 text-center">加载中...</div>
          ) : snapshots.length === 0 ? (
            <div className="p-6 text-xs text-slate-500 text-center">
              {hasProject
                ? "还没有快照。输入名称创建第一个版本标签。"
                : "选择项目后可管理快照"}
            </div>
          ) : (
            <div className="divide-y divide-slate-800">
              {snapshots.map((snap) => {
                const badge = SOURCE_BADGE[snap.source] ?? SOURCE_BADGE.manual;
                return (
                  <div key={snap.id} className="px-4 py-2.5 hover:bg-slate-800/40 group">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-slate-200 truncate">{snap.name}</span>
                          <span
                            className={`px-1.5 py-0.5 text-[10px] rounded border whitespace-nowrap ${badge.cls}`}
                          >
                            {badge.label}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {formatTime(snap.createdAt)} · {snap.fileCount} 个文件 ·{" "}
                          {formatSize(snap.totalSize)}
                          {snap.description ? ` · ${snap.description}` : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => setComparingSnap(snap)}
                          disabled={isWorking}
                          className="px-2 py-1 text-[11px] text-slate-300 border border-slate-600/60 rounded hover:bg-slate-700/40 disabled:opacity-40 whitespace-nowrap"
                          title="逐文件对比该快照与当前版本"
                        >
                          对比
                        </button>
                        <button
                          onClick={() => handleRestore(snap)}
                          disabled={isWorking}
                          className="px-2 py-1 text-[11px] text-cyan-400 border border-cyan-600/40 rounded hover:bg-cyan-500/10 disabled:opacity-40 whitespace-nowrap"
                        >
                          恢复
                        </button>
                        <button
                          onClick={() => handleDelete(snap)}
                          disabled={isWorking}
                          className="px-2 py-1 text-[11px] text-slate-500 hover:text-red-400 disabled:opacity-40"
                          title="删除快照"
                        >
                          ✕
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

        {/* 底部说明 */}
        <div className="px-4 py-2 border-t border-slate-800 text-[11px] text-slate-600">
          {comparingSnap
            ? "左侧为快照版本，右侧为当前版本；逐块接受/拒绝后可复制合并结果。"
            : "恢复 = 项目回到快照时的状态；恢复前当前状态自动备份，不会丢失。"}
        </div>
      </div>

      {/* Diff 对比弹窗（快照版本 vs 当前版本；应用回写在 Day 11 接入） */}
      {diffTarget && (
        <DiffViewer
          open={!!diffTarget}
          onClose={() => setDiffTarget(null)}
          title={diffTarget.path.slice(1)}
          original={diffTarget.snapshotContent}
          modified={diffTarget.currentContent}
          language={inferMonacoLanguage(diffTarget.path)}
          originalLabel="快照版本"
          modifiedLabel="当前版本"
        />
      )}
    </div>
  );
}
