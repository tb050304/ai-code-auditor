"use client";
import React, { useState, useCallback, useRef, useEffect } from "react";
import type { EditorTab } from "@/hooks/useEditorTabs";
import { getFileCategory, FILE_CATEGORY_COLORS, FILE_CATEGORY_ICONS } from "@/lib/storage/file-tree";

interface TabBarProps {
  tabs: EditorTab[];
  activeTabPath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onCloseAll: () => void;
  /** Tab 右键菜单中执行的保存操作 */
  onSave?: (path: string) => void;
}

export default function TabBar({
  tabs,
  activeTabPath,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onSave,
}: TabBarProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, path: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, path });
    },
    [],
  );

  // 中键关闭
  const handleMouseDown = useCallback(
    (e: React.MouseEvent, path: string) => {
      if (e.button === 1) {
        e.preventDefault();
        onClose(path);
      }
    },
    [onClose],
  );

  // 滚动时关闭右键菜单
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => setContextMenu(null);
    el.addEventListener("scroll", handler);
    return () => el.removeEventListener("scroll", handler);
  }, []);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="relative bg-slate-900 border-b border-slate-800">
      <div
        ref={scrollRef}
        className="flex items-center h-9 overflow-x-auto scrollbar-thin"
        onContextMenu={(e) => e.preventDefault()}
      >
        {tabs.map((tab) => {
          const isActive = tab.path === activeTabPath;
          const isDirty = tab.content !== tab.originalContent;
          const category = getFileCategory(tab.path);
          const colorClass = FILE_CATEGORY_COLORS[category];
          const iconText = FILE_CATEGORY_ICONS[category];

          return (
            <div
              key={tab.path}
              className={`
                group flex items-center gap-2 px-3 h-full text-sm cursor-pointer
                border-r border-slate-800 flex-shrink-0
                transition-colors
                ${isActive
                  ? "bg-slate-950 text-slate-100 border-t-2 border-t-cyan-500"
                  : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
                }
              `}
              onClick={() => onActivate(tab.path)}
              onMouseDown={(e) => handleMouseDown(e, tab.path)}
              onContextMenu={(e) => handleContextMenu(e, tab.path)}
              title={tab.path}
            >
              <span className={`text-[10px] font-bold ${colorClass} w-4 text-center`}>
                {iconText}
              </span>
              <span className="max-w-[160px] truncate">{tab.name}</span>
              <button
                className={`
                  w-4 h-4 flex items-center justify-center rounded
                  text-xs opacity-0 group-hover:opacity-100
                  hover:bg-slate-700 transition-opacity
                  ${isDirty ? "opacity-100" : ""}
                `}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.path);
                }}
                title="关闭 (Ctrl+W)"
              >
                {isDirty ? "•" : "×"}
              </button>
            </div>
          );
        })}

        {/* 右边：关闭所有按钮 */}
        <div className="ml-auto flex items-center px-2 gap-1 flex-shrink-0">
          <button
            className="px-2 py-1 text-xs text-slate-500 hover:text-slate-300 hover:bg-slate-800 rounded"
            onClick={onCloseAll}
            title="关闭所有标签"
          >
            ✕ 全部
          </button>
        </div>
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          tabPath={contextMenu.path}
          tabName={tabs.find((t) => t.path === contextMenu.path)?.name ?? ""}
          isDirty={
            (() => {
              const t = tabs.find((tab) => tab.path === contextMenu.path);
              return t ? t.content !== t.originalContent : false;
            })()
          }
          onClose={() => {
            onClose(contextMenu.path);
            setContextMenu(null);
          }}
          onCloseOthers={() => {
            onCloseOthers(contextMenu.path);
            setContextMenu(null);
          }}
          onCloseAll={() => {
            onCloseAll();
            setContextMenu(null);
          }}
          onSave={
            onSave
              ? () => {
                  onSave(contextMenu.path);
                  setContextMenu(null);
                }
              : undefined
          }
          onCloseMenu={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

// ---------- Tab 右键菜单 ----------

interface TabContextMenuProps {
  x: number;
  y: number;
  tabPath: string;
  tabName: string;
  isDirty: boolean;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onSave?: () => void;
  onCloseMenu: () => void;
}

function TabContextMenu({
  x,
  y,
  tabName,
  isDirty,
  onClose,
  onCloseOthers,
  onCloseAll,
  onSave,
  onCloseMenu,
}: TabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjX, setAdjX] = useState(x);
  const [adjY, setAdjY] = useState(y);

  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (x + rect.width > vw) setAdjX(Math.max(0, x - rect.width));
    if (y + rect.height > vh) setAdjY(Math.max(0, y - rect.height));
  }, [x, y]);

  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onCloseMenu();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseMenu();
    };
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onCloseMenu]);

  const items = [
    {
      key: "close",
      label: "关闭标签",
      icon: "✕",
      onClick: onClose,
    },
    {
      key: "close-others",
      label: "关闭其他标签",
      icon: "⊶",
      onClick: onCloseOthers,
    },
    {
      key: "close-all",
      label: "关闭所有标签",
      icon: "⊷",
      onClick: onCloseAll,
    },
  ];

  if (onSave && isDirty) {
    items.unshift({
      key: "save",
      label: "保存",
      icon: "💾",
      onClick: onSave,
    });
    items.push({ key: "div", label: "", icon: "", onClick: () => {}, divider: true } as any);
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] min-w-[160px] bg-slate-800 border border-slate-700 rounded-md shadow-xl py-1 text-sm text-slate-200"
      style={{ left: adjX, top: adjY }}
    >
      {items.map((item: any) =>
        item.divider ? (
          <div key={item.key} className="my-1 border-t border-slate-700" />
        ) : (
          <button
            key={item.key}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-slate-700/50"
            onClick={item.onClick}
          >
            <span className="w-4 text-center">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
