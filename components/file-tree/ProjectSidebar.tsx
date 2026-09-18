"use client";
import React, { useState, useCallback } from "react";
import FileDropzone from "@/components/file-dropzone/FileDropzone";
import FileTree from "@/components/file-tree/FileTree";
import ProjectSnapshotPanel from "@/components/snapshots/ProjectSnapshotPanel";
import FileHistoryPanel, { type FileHistoryData } from "@/components/snapshots/FileHistoryPanel";
import type { Project } from "@/lib/storage";
import type { TreeNode } from "@/lib/storage/file-tree";
import type { ImportResult } from "@/lib/storage/import";
import type { ProjectSnapshot, SnapshotMeta, FileSnapshot } from "@/lib/snapshots";
import type { FileAnalysisResult } from "@/lib/ast/batch-types";

interface ProjectSidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  fileTree: TreeNode | null;
  activeFilePath: string | null;
  fileResults?: Map<string, FileAnalysisResult>;
  onSelectProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onImported: (result: ImportResult) => void;
  onFileClick?: (path: string) => void;
  onCreateFile: (parentDir: string, name: string) => void;
  onCreateDir: (parentDir: string, name: string) => void;
  onDeleteNode: (path: string, type: "file" | "directory") => void;
  onRenameNode: (oldPath: string, newName: string) => void;
  // ---- 项目级快照 ----
  onCreateSnapshot: (name: string, description?: string) => Promise<ProjectSnapshot>;
  onRestoreSnapshot: (id: string) => Promise<ProjectSnapshot>;
  onListSnapshots: () => Promise<ProjectSnapshot[]>;
  onDeleteSnapshot: (id: string) => Promise<void>;
  /** 读取当前文件内容（快照对比用） */
  onReadCurrentFile?: (path: string) => Promise<string>;
  /** 写回文件内容（Diff 应用合并结果用，写前自动快照） */
  onWriteFile?: (path: string, content: string, meta?: SnapshotMeta) => Promise<unknown>;
  // ---- 文件级快照（Day 12） ----
  /** 列出某文件的历史快照（新 → 旧） */
  onListFileHistory?: (path: string) => Promise<FileSnapshot[]>;
  /** 回滚某文件到指定快照（回滚前自动快照当前内容） */
  onRestoreFileSnapshot?: (snapshotId: string) => Promise<FileSnapshot>;
}

export default function ProjectSidebar({
  projects,
  activeProjectId,
  fileTree,
  activeFilePath,
  fileResults,
  onSelectProject,
  onDeleteProject,
  onImported,
  onFileClick,
  onCreateFile,
  onCreateDir,
  onDeleteNode,
  onRenameNode,
  onCreateSnapshot,
  onRestoreSnapshot,
  onListSnapshots,
  onDeleteSnapshot,
  onReadCurrentFile,
  onWriteFile,
  onListFileHistory,
  onRestoreFileSnapshot,
}: ProjectSidebarProps) {
  const [showDropzone, setShowDropzone] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [showSnapshotPanel, setShowSnapshotPanel] = useState(false);
  /** 正在查看文件历史的路径（null = 关闭） */
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  /** 文件历史数据（null = 加载中）；在打开/刷新等事件回调中加载，避免 effect 内 setState */
  const [historyData, setHistoryData] = useState<FileHistoryData | null>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  // 加载某文件的历史时间线（事件回调中调用；文件已删除时 current 记为 null）
  const loadHistory = useCallback(
    async (path: string) => {
      if (!onListFileHistory) return;
      try {
        const [list, current] = await Promise.all([
          onListFileHistory(path),
          onReadCurrentFile
            ? onReadCurrentFile(path).then(
                (content) => content,
                () => null,
              )
            : Promise.resolve<string | null>(null),
        ]);
        setHistoryData({ snaps: list, current });
      } catch (e) {
        console.error("加载文件历史失败:", e);
        setHistoryData({ snaps: [], current: null });
      }
    },
    [onListFileHistory, onReadCurrentFile],
  );

  // 右键「历史记录」：打开面板并加载
  const handleShowHistory = useCallback(
    (path: string) => {
      setHistoryPath(path);
      setHistoryData(null);
      loadHistory(path);
    },
    [loadHistory],
  );

  const handleImported = (result: ImportResult) => {
    onImported(result);
    setShowDropzone(false);
  };

  // 计算文件总数（用于底部统计）
  const fileCount = React.useMemo(() => {
    if (!fileTree) return 0;
    let count = 0;
    function walk(node: TreeNode) {
      if (node.type === "file") count++;
      if (node.children) node.children.forEach(walk);
    }
    fileTree.children?.forEach(walk);
    return count;
  }, [fileTree]);

  return (
    <aside className="w-64 flex-shrink-0 flex flex-col bg-slate-900 border-r border-slate-800 text-slate-300">
      {/* 头部 */}
      <div className="p-3 border-b border-slate-800 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-200">项目</span>
        <div className="flex items-center gap-1">
          <button
            className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-colors"
            onClick={() => setShowSnapshotPanel(true)}
            disabled={!activeProjectId}
            title="项目快照：打版本标签 / 恢复"
          >
            📸 快照
          </button>
          <button
            className="px-2 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded transition-colors"
            onClick={() => setShowDropzone((v) => !v)}
            title={showDropzone ? "收起导入" : "导入项目"}
          >
            {showDropzone ? "收起" : "+ 导入"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {showDropzone && (
          <div className="p-3">
            <FileDropzone onImported={handleImported} mode="inline" />
          </div>
        )}

        {/* 项目列表 */}
        {projects.length > 0 && (
          <div className="border-b border-slate-800">
            <div className="px-3 py-1.5 text-xs text-slate-500 uppercase tracking-wide flex items-center justify-between">
              <span>我的项目</span>
              <button
                className="text-slate-500 hover:text-slate-300"
                onClick={() => setCollapsed((v) => !v)}
                title={collapsed ? "展开" : "折叠"}
              >
                {collapsed ? "▸" : "▾"}
              </button>
            </div>
            {!collapsed &&
              projects.map((p) => (
                <div
                  key={p.id}
                  className={`
                    group flex items-center justify-between px-3 py-2 cursor-pointer text-sm
                    ${activeProjectId === p.id ? "bg-cyan-500/10 text-cyan-300 border-l-2 border-cyan-500" : "hover:bg-slate-800/50"}
                  `}
                  onClick={() => {
                    // 切换项目时关闭文件历史面板，避免展示上一个项目的过期数据
                    setHistoryPath(null);
                    onSelectProject(p.id);
                  }}
                >
                  <span className="truncate">📂 {p.name}</span>
                  <button
                    className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition-opacity ml-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteConfirm(p.id);
                    }}
                    title="删除项目"
                  >
                    ✕
                  </button>
                </div>
              ))}
          </div>
        )}

        {/* 文件树 */}
        {activeProject && fileTree && (
          <div className="flex-1 flex flex-col">
            <div className="px-3 py-1.5 text-xs text-slate-500 uppercase tracking-wide border-b border-slate-800 flex items-center justify-between">
              <span>文件</span>
            </div>
            <div className="flex-1 py-1">
              <FileTree
                root={fileTree}
                activeFilePath={activeFilePath}
                fileResults={fileResults}
                onFileClick={onFileClick}
                onCreateFile={onCreateFile}
                onCreateDir={onCreateDir}
                onDelete={onDeleteNode}
                onRename={onRenameNode}
                onShowHistory={handleShowHistory}
                defaultExpanded={new Set(["/"])}
              />
            </div>
          </div>
        )}

        {activeProject && fileTree && fileTree.children?.length === 0 && (
          <div className="p-4 text-xs text-slate-500 text-center">项目为空，右键新建文件</div>
        )}

        {!activeProject && projects.length === 0 && !showDropzone && (
          <div className="p-4 text-xs text-slate-500 text-center">
            还没有项目，点击上方「导入」开始
          </div>
        )}
      </div>

      {/* 底部：当前项目信息 */}
      {activeProject && (
        <div className="p-3 border-t border-slate-800 text-xs text-slate-500">
          <div className="truncate">当前：{activeProject.name}</div>
          <div>{fileCount} 个文件</div>
        </div>
      )}

      {/* 项目快照面板：打开时才挂载，关闭即卸载，内部子视图状态天然重置 */}
      {showSnapshotPanel && (
        <ProjectSnapshotPanel
          open
          onClose={() => setShowSnapshotPanel(false)}
          hasProject={!!activeProjectId}
          onCreateSnapshot={onCreateSnapshot}
          onRestoreSnapshot={onRestoreSnapshot}
          onListSnapshots={onListSnapshots}
          onDeleteSnapshot={onDeleteSnapshot}
          onReadCurrentFile={onReadCurrentFile}
          onWriteFile={onWriteFile}
        />
      )}

      {/* 文件历史时间线面板（Day 12）：数据由本组件在事件回调中加载 */}
      {onListFileHistory && onRestoreFileSnapshot && (
        <FileHistoryPanel
          open={historyPath !== null}
          path={historyPath}
          data={historyData}
          onClose={() => setHistoryPath(null)}
          onRestoreSnapshot={onRestoreFileSnapshot}
          onWriteFile={onWriteFile}
          onReload={loadHistory}
        />
      )}

      {/* 删除项目确认弹窗 */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 w-72 shadow-xl">
            <div className="text-sm font-medium text-slate-200 mb-2">确认删除项目？</div>
            <div className="text-xs text-slate-400 mb-4">
              删除后项目中的所有文件都将丢失，此操作不可撤销。
            </div>
            <div className="flex gap-2 justify-end">
              <button
                className="px-3 py-1 text-xs text-slate-400 hover:text-slate-300"
                onClick={() => setShowDeleteConfirm(null)}
              >
                取消
              </button>
              <button
                className="px-3 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded"
                onClick={() => {
                  onDeleteProject(showDeleteConfirm);
                  setShowDeleteConfirm(null);
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
