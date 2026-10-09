"use client";
import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import ContextMenu from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";
import type { TreeNode } from "@/lib/storage/file-tree";
import { getFileCategory, FILE_CATEGORY_COLORS, FILE_CATEGORY_ICONS } from "@/lib/storage/file-tree";
import { basename, dirname } from "@/lib/storage/path";
import { buildTreeIssueMap, type NodeIssueSummary } from "@/lib/ast/issue-aggregate";
import type { FileAnalysisResult } from "@/lib/ast/batch-types";

export interface FileTreeActions {
  onFileClick?: (path: string) => void;
  onCreateFile?: (parentDir: string, name: string) => void;
  onCreateDir?: (parentDir: string, name: string) => void;
  onDelete?: (path: string, type: "file" | "directory") => void;
  onRename?: (oldPath: string, newName: string) => void;
  /** 查看文件修改历史（仅文件，Day 12 时间线侧边栏） */
  onShowHistory?: (path: string) => void;
  /** 加载子目录内容（懒加载用），可选。如果不提供则认为树已经完整 */
  onLoadChildren?: (path: string) => Promise<void>;
}

interface FileTreeProps extends FileTreeActions {
  root: TreeNode;
  activeFilePath?: string | null;
  /** 初始自动展开的路径集合 */
  defaultExpanded?: Set<string>;
  /** 批量分析结果（用于显示问题指示器） */
  fileResults?: Map<string, FileAnalysisResult>;
}

interface EditingState {
  path: string;
  mode: "rename" | "new-file" | "new-dir";
  initialValue?: string;
}

export default function FileTree({
  root,
  activeFilePath,
  defaultExpanded,
  onFileClick,
  onCreateFile,
  onCreateDir,
  onDelete,
  onRename,
  onShowHistory,
  onLoadChildren,
  fileResults,
}: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(
    defaultExpanded ?? new Set(["/"]),
  );

  // 构建文件树问题摘要 Map（文件 + 目录聚合）
  const issueMap = useMemo<Map<string, NodeIssueSummary>>(() => {
    if (!fileResults || fileResults.size === 0) return new Map();
    return buildTreeIssueMap(root, fileResults);
  }, [root, fileResults]);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    type: "file" | "directory";
  } | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, path: string, type: "file" | "directory") => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, path, type });
    },
    [],
  );

  const handleBlankContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // 空白区域右键：在根目录新建
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, path: "/", type: "directory" });
    },
    [],
  );

  const buildMenuItems = useCallback(
    (path: string, type: "file" | "directory"): ContextMenuItem[] => {
      const items: ContextMenuItem[] = [];

      if (type === "directory") {
        items.push({
          key: "new-file",
          label: "新建文件",
          icon: "+",
          onClick: () => {
            setExpanded((prev) => new Set(prev).add(path));
            setEditing({ path, mode: "new-file", initialValue: "" });
          },
        });
        items.push({
          key: "new-dir",
          label: "新建文件夹",
          icon: "⊞",
          onClick: () => {
            setExpanded((prev) => new Set(prev).add(path));
            setEditing({ path, mode: "new-dir", initialValue: "" });
          },
        });
        items.push({ key: "div1", label: "", divider: true, onClick: () => {} });
      }

      if (path !== "/") {
        if (type === "file") {
          items.push({
            key: "history",
            label: "历史记录",
            icon: "🕘",
            onClick: () => onShowHistory?.(path),
          });
        }
        items.push({
          key: "rename",
          label: "重命名",
          icon: "✎",
          onClick: () => {
            // 确保父目录展开，才能看到重命名
            const parent = dirname(path);
            setExpanded((prev) => new Set(prev).add(parent));
            setEditing({ path, mode: "rename", initialValue: basename(path) });
          },
        });
        items.push({
          key: "delete",
          label: "删除",
          icon: "🗑",
          danger: true,
          onClick: () => onDelete?.(path, type),
        });
      }

      return items;
    },
    [onDelete, onShowHistory],
  );

  const handleEditingSubmit = useCallback(
    (value: string) => {
      setEditing((prev) => {
        if (!prev) return prev;
        const trimmed = value.trim();
        if (!trimmed) return null;

        if (prev.mode === "rename") {
          if (trimmed !== basename(prev.path)) {
            onRename?.(prev.path, trimmed);
          }
        } else if (prev.mode === "new-file") {
          onCreateFile?.(prev.path, trimmed);
        } else if (prev.mode === "new-dir") {
          onCreateDir?.(prev.path, trimmed);
        }
        return null;
      });
    },
    [onCreateFile, onCreateDir, onRename],
  );

  const handleEditingCancel = useCallback(() => {
    setEditing(null);
  }, []);

  // 点击空白处关闭右键菜单
  const handleClick = useCallback(() => {
    setContextMenu(null);
  }, []);

  // activeFilePath 变化时展开其所有祖先目录。
  // 采用 React 官方「render 期间根据 props 变化调整 state」模式，
  // 比 effect 同步 setState 少一轮渲染，也不触发 set-state-in-effect 规则。
  const [lastActiveFilePath, setLastActiveFilePath] = useState<string | null>(null);
  if (activeFilePath && activeFilePath !== lastActiveFilePath) {
    setLastActiveFilePath(activeFilePath);
    const parts = activeFilePath.split("/").filter(Boolean);
    const ancestorPaths: string[] = [];
    let cur = "";
    for (const p of parts.slice(0, -1)) {
      cur += "/" + p;
      ancestorPaths.push(cur);
    }
    if (ancestorPaths.length > 0 && !ancestorPaths.every((p) => expanded.has(p))) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const p of ancestorPaths) next.add(p);
        return next;
      });
    }
  }

  return (
    <div className="w-full h-full overflow-y-auto select-none" onContextMenu={handleBlankContextMenu} onClick={handleClick}>
      <TreeNodeRow
        node={root}
        depth={-1} // 根目录不显示，depth 从 -1 开始，子节点从 0 开始
        isRoot
        expanded={expanded}
        activeFilePath={activeFilePath}
        editing={editing}
        issueMap={issueMap}
        onToggleExpand={toggleExpand}
        onFileClick={onFileClick}
        onContextMenu={handleContextMenu}
        onEditingSubmit={handleEditingSubmit}
        onEditingCancel={handleEditingCancel}
        onLoadChildren={onLoadChildren}
      />
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems(contextMenu.path, contextMenu.type)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

// ---------- 单个节点行 ----------

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  isRoot?: boolean;
  expanded: Set<string>;
  activeFilePath?: string | null;
  editing: EditingState | null;
  issueMap: Map<string, NodeIssueSummary>;
  onToggleExpand: (path: string) => void;
  onFileClick?: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, type: "file" | "directory") => void;
  onEditingSubmit: (value: string) => void;
  onEditingCancel: () => void;
  onLoadChildren?: (path: string) => Promise<void>;
}

function TreeNodeRowBase({
  node,
  depth,
  isRoot,
  expanded,
  activeFilePath,
  editing,
  issueMap,
  onToggleExpand,
  onFileClick,
  onContextMenu,
  onEditingSubmit,
  onEditingCancel,
  onLoadChildren,
}: TreeNodeRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // 进入编辑模式时自动聚焦
  useEffect(() => {
    if (editing && editing.path === node.path && editing.mode === "rename") {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, node.path]);

  if (isRoot) {
    // 根目录不显示自身，直接渲染子节点
    return (
      <>
        {node.children?.map((child) => (
          <TreeNodeRow
            key={child.path}
            node={child}
            depth={0}
            expanded={expanded}
            activeFilePath={activeFilePath}
            editing={editing}
            issueMap={issueMap}
            onToggleExpand={onToggleExpand}
            onFileClick={onFileClick}
            onContextMenu={onContextMenu}
            onEditingSubmit={onEditingSubmit}
            onEditingCancel={onEditingCancel}
            onLoadChildren={onLoadChildren}
          />
        ))}
        {editing && editing.path === "/" && editing.mode !== "rename" && (
          <NewItemRow
            depth={0}
            mode={editing.mode}
            ref={inputRef}
            onSubmit={onEditingSubmit}
            onCancel={onEditingCancel}
          />
        )}
      </>
    );
  }

  const isActive = activeFilePath === node.path;
  const isDir = node.type === "directory";
  const isOpen = expanded.has(node.path);
  const category = isDir ? null : getFileCategory(node.path);
  const colorClass = isDir ? "text-slate-300" : FILE_CATEGORY_COLORS[category!];
  const iconText = isDir ? (isOpen ? "▾" : "▸") : FILE_CATEGORY_ICONS[category!];
  const issueSummary = issueMap.get(node.path);
  const hasIssue = issueSummary && issueSummary.level !== "none";

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDir) {
      onToggleExpand(node.path);
      // 如果是第一次展开且有懒加载回调
      if (!isOpen && onLoadChildren && (!node.children || node.children.length === 0)) {
        onLoadChildren(node.path);
      }
    } else {
      onFileClick?.(node.path);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDir) return;
    // 双击文件：触发点击（Day 4 多 Tab 时改成打开新 Tab）
    onFileClick?.(node.path);
  };

  const isEditingThis = editing?.path === node.path && editing.mode === "rename";

  return (
    <>
      <div
        className={`
          flex items-center h-7 cursor-pointer text-sm
          ${isActive ? "bg-cyan-500/15 text-cyan-200" : "hover:bg-slate-800/50"}
        `}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => onContextMenu(e, node.path, node.type)}
        title={node.path}
      >
        <span className={`w-5 text-xs flex-shrink-0 text-center ${isDir ? "text-slate-500" : ""}`}>
          {isDir ? iconText : ""}
        </span>
        <span className={`w-5 text-[10px] font-bold flex-shrink-0 text-center ${colorClass}`}>
          {isDir ? "" : iconText}
        </span>
        {isEditingThis ? (
          <input
            ref={inputRef}
            className="flex-1 min-w-0 bg-slate-700 border border-cyan-500 rounded px-1 py-0.5 text-xs text-slate-100 outline-none"
            defaultValue={editing.initialValue}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditingSubmit((e.target as HTMLInputElement).value);
              if (e.key === "Escape") onEditingCancel();
              e.stopPropagation();
            }}
            onBlur={(e) => onEditingSubmit(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate flex-1 min-w-0">{node.name}</span>
        )}
        {hasIssue && issueSummary && (
          <span
            className={`
              flex-shrink-0 ml-1 mr-1 px-1.5 py-0.5 rounded text-[10px] font-medium min-w-[18px] text-center
              ${issueSummary.level === "error"
                ? "bg-red-500/20 text-red-400"
                : issueSummary.level === "warning"
                  ? "bg-yellow-500/20 text-yellow-400"
                  : "bg-blue-500/20 text-blue-400"}
            `}
            title={`${issueSummary.errorCount} error, ${issueSummary.warningCount} warning, ${issueSummary.infoCount} info`}
          >
            {issueSummary.total}
          </span>
        )}
      </div>
      {isDir && isOpen && node.children && (
        <>
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              activeFilePath={activeFilePath}
              editing={editing}
              issueMap={issueMap}
              onToggleExpand={onToggleExpand}
              onFileClick={onFileClick}
              onContextMenu={onContextMenu}
              onEditingSubmit={onEditingSubmit}
              onEditingCancel={onEditingCancel}
              onLoadChildren={onLoadChildren}
            />
          ))}
          {editing && editing.path === node.path && editing.mode !== "rename" && (
            <NewItemRow
              depth={depth + 1}
              mode={editing.mode}
              ref={inputRef}
              onSubmit={onEditingSubmit}
              onCancel={onEditingCancel}
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * Day 27 性能优化：memo + 自定义比较器
 *
 * `expanded` 是一个 Set，每次 toggle 任何节点都会产生新的 Set 引用。
 * 默认的浅比较会认为所有子树都"变了"，导致整棵文件树重渲染。
 *
 * 自定义比较器只检查与"当前节点"相关的状态切片：
 *   1. node 引用（buildTree 产出的 TreeNode 对象引用稳定）
 *   2. expanded.has(node.path) 布尔值（本节点的展开状态）
 *   3. activeFilePath === node.path 布尔值（本节点是否激活）
 *   4. editing?.path === node.path 相关性 + editing.mode/initialValue
 *   5. issueMap.get(node.path) 引用（本节点的问题摘要）
 *   6. depth / isRoot 基本类型
 *   7. 回调函数引用（全部 useCallback 稳定）
 *
 * 效果：toggle 节点 A 的展开状态时，只有 A 及其直接子树重渲染，
 * 其余未受影响的子树（B、C…）因比较器判定"无变化"而跳过渲染。
 */
const TreeNodeRow = memo(
  TreeNodeRowBase,
  (prev, next) => {
    // 1. node 引用
    if (prev.node !== next.node) return false;
    // 2. 本节点展开状态
    if (prev.expanded.has(prev.node.path) !== next.expanded.has(next.node.path)) return false;
    // 3. 激活文件相关性
    if ((prev.activeFilePath === prev.node.path) !== (next.activeFilePath === next.node.path)) return false;
    // 4. 编辑相关性：只有 editing.path === node.path 时本节点才需要响应
    const prevEd = prev.editing?.path === prev.node.path ? prev.editing : null;
    const nextEd = next.editing?.path === next.node.path ? next.editing : null;
    if (prevEd !== nextEd) {
      if (!prevEd || !nextEd) return false;
      if (prevEd.mode !== nextEd.mode || prevEd.initialValue !== nextEd.initialValue) return false;
    }
    // 5. 问题摘要引用
    if (prev.issueMap.get(prev.node.path) !== next.issueMap.get(next.node.path)) return false;
    // 6. depth / isRoot
    if (prev.depth !== next.depth) return false;
    if (prev.isRoot !== next.isRoot) return false;
    // 7. 回调引用（稳定 useCallback，检查以防万一）
    if (
      prev.onToggleExpand !== next.onToggleExpand ||
      prev.onFileClick !== next.onFileClick ||
      prev.onContextMenu !== next.onContextMenu ||
      prev.onEditingSubmit !== next.onEditingSubmit ||
      prev.onEditingCancel !== next.onEditingCancel ||
      prev.onLoadChildren !== next.onLoadChildren
    ) {
      return false;
    }
    return true;
  },
);

const NewItemRow = React.forwardRef<
  HTMLInputElement,
  {
    depth: number;
    mode: "new-file" | "new-dir";
    onSubmit: (value: string) => void;
    onCancel: () => void;
  }
>(function NewItemRow({ depth, mode, onSubmit, onCancel }, ref) {
  return (
    <div
      className="flex items-center h-7"
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <span className="w-5 text-xs flex-shrink-0 text-center text-slate-500">
        {mode === "new-dir" ? "▸" : ""}
      </span>
      <span className="w-5 text-[10px] font-bold flex-shrink-0 text-center text-slate-500">
        {mode === "new-dir" ? "" : "+"}
      </span>
      <input
        ref={ref}
        autoFocus
        className="flex-1 min-w-0 bg-slate-700 border border-cyan-500 rounded px-1 py-0.5 text-xs text-slate-100 outline-none"
        placeholder={mode === "new-dir" ? "文件夹名" : "文件名"}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit((e.target as HTMLInputElement).value);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={(e) => onSubmit(e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
});
