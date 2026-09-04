"use client";
import React, { useState } from "react";
import FileDropzone from "@/components/file-dropzone/FileDropzone";
import type { Project, FileNode } from "@/lib/storage";
import type { ImportResult } from "@/lib/storage/import";
import { formatSize } from "@/lib/storage/import";

interface ProjectSidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  rootFiles: FileNode[];
  onSelectProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onImported: (result: ImportResult) => void;
  onFileClick?: (path: string) => void;
}

export default function ProjectSidebar({
  projects,
  activeProjectId,
  rootFiles,
  onSelectProject,
  onDeleteProject,
  onImported,
  onFileClick,
}: ProjectSidebarProps) {
  const [showDropzone, setShowDropzone] = useState(projects.length === 0);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  const handleImported = (result: ImportResult) => {
    onImported(result);
    setShowDropzone(false);
  };

  const fileIcon = (node: FileNode) => {
    if (node.type === "directory") return "📁";
    const name = node.path.toLowerCase();
    if (name.endsWith(".ts") || name.endsWith(".tsx")) return "🔷";
    if (name.endsWith(".js") || name.endsWith(".jsx")) return "🟨";
    if (name.endsWith(".json")) return "📋";
    if (name.endsWith(".css") || name.endsWith(".scss")) return "🎨";
    if (name.endsWith(".md")) return "📝";
    if (name.endsWith(".html")) return "🌐";
    return "📄";
  };

  return (
    <aside className="w-64 flex-shrink-0 flex flex-col bg-slate-900 border-r border-slate-800 text-slate-300">
      {/* 头部 */}
      <div className="p-3 border-b border-slate-800 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-200">项目</span>
        <button
          className="px-2 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded transition-colors"
          onClick={() => setShowDropzone(true)}
        >
          + 导入
        </button>
      </div>

      {/* 项目列表 */}
      <div className="flex-1 overflow-y-auto">
        {showDropzone && (
          <div className="p-3">
            <FileDropzone onImported={handleImported} mode="inline" />
            <button
              className="mt-2 w-full text-xs text-slate-500 hover:text-slate-400"
              onClick={() => setShowDropzone(false)}
            >
              收起
            </button>
          </div>
        )}

        {projects.length > 0 && (
          <div className="border-b border-slate-800">
            <div className="px-3 py-1.5 text-xs text-slate-500 uppercase tracking-wide">
              我的项目
            </div>
            {projects.map((p) => (
              <div
                key={p.id}
                className={`
                  group flex items-center justify-between px-3 py-2 cursor-pointer text-sm
                  ${activeProjectId === p.id ? "bg-cyan-500/10 text-cyan-300 border-l-2 border-cyan-500" : "hover:bg-slate-800/50"}
                `}
                onClick={() => onSelectProject(p.id)}
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

        {/* 当前项目根目录文件列表（Day 3 会替换为完整文件树） */}
        {activeProject && rootFiles.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs text-slate-500 uppercase tracking-wide border-b border-slate-800">
              文件（根目录）
            </div>
            <div className="py-1">
              {rootFiles.map((node) => (
                <div
                  key={node.path}
                  className="px-4 py-1 text-sm hover:bg-slate-800/50 cursor-pointer truncate flex items-center gap-2"
                  onClick={() => onFileClick?.(node.path)}
                  title={node.path}
                >
                  <span className="text-xs">{fileIcon(node)}</span>
                  <span className="truncate">{node.path.slice(1) || "/"}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeProject && rootFiles.length === 0 && !showDropzone && (
          <div className="p-4 text-xs text-slate-500 text-center">
            项目为空
          </div>
        )}

        {!activeProject && projects.length === 0 && !showDropzone && (
          <div className="p-4 text-xs text-slate-500 text-center">
            还没有项目，点击上方"导入"开始
          </div>
        )}
      </div>

      {/* 底部：当前项目信息 */}
      {activeProject && (
        <div className="p-3 border-t border-slate-800 text-xs text-slate-500">
          <div className="truncate">当前：{activeProject.name}</div>
          <div>{rootFiles.length} 个条目</div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 w-72 shadow-xl">
            <div className="text-sm font-medium text-slate-200 mb-2">确认删除？</div>
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
