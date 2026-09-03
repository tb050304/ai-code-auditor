"use client";
// ---------------------------------------------------------------------------
// ConversationSidebar —— 会话侧边栏
// ---------------------------------------------------------------------------
// 展示全部历史会话，支持：新建、切换、删除、重命名。
// 纯受控组件：状态由 useConversations 持有，这里只负责渲染与事件上抛。
// ---------------------------------------------------------------------------

import React from "react";
import type { Conversation } from "@/types";

interface ConversationSidebarProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

/** 简洁地格式化时间：MM/DD HH:mm */
function formatTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

export default function ConversationSidebar({
  conversations,
  activeConversationId,
  onCreate,
  onSelect,
  onDelete,
  onRename,
}: ConversationSidebarProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const editInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (editingId) editInputRef.current?.select();
  }, [editingId]);

  const beginRename = (conversation: Conversation) => {
    setEditingId(conversation.id);
    setDraft(conversation.title);
  };

  // 按下 Enter 保存重命名，Esc 取消
  const commitRename = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      setEditingId(null);
    }
  };

  return (
    <aside className="w-64 flex-shrink-0 flex flex-col bg-slate-900 border-r border-slate-800">
      {/* 头部：标题 + 新建按钮 */}
      <header className="px-3 py-3 flex items-center justify-between border-b border-slate-800 shrink-0">
        <h1 className="text-sm font-bold text-slate-200">对话历史</h1>
        <button
          onClick={onCreate}
          title="新建对话"
          className="px-2 py-1 text-xs rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
        >
          ＋ 新对话
        </button>
      </header>

      {/* 会话列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        {conversations.length === 0 ? (
          <p className="text-xs text-slate-600 text-center py-10">暂无历史对话</p>
        ) : (
          conversations.map((c) => {
            const isActive = c.id === activeConversationId;
            return (
              <div
                key={c.id}
                onClick={() => !editingId && onSelect(c.id)}
                className={`group px-2 py-2 rounded cursor-pointer border ${
                  isActive
                    ? "bg-slate-800 border-cyan-500/60"
                    : "hover:bg-slate-800/60 border-transparent"
                }`}
                onDoubleClick={() => beginRename(c)}
              >
                <div className="flex items-start justify-between gap-2">
                  {editingId === c.id ? (
                    <input
                      ref={editInputRef}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={handleKeyDown}
                      onBlur={commitRename}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="输入会话标题"
                      className="flex-1 min-w-0 text-xs bg-slate-900 border border-cyan-500 rounded px-1 py-0.5 text-slate-200 focus:outline-none"
                    />
                  ) : (
                    <span className="flex-1 min-w-0 text-xs text-slate-300 truncate">
                      {c.title || "未命名会话"}
                    </span>
                  )}
                  {/* 删除按钮：悬浮时可见 */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(c.id);
                    }}
                    title="删除该对话"
                    className="text-xs text-slate-500 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    ✕
                  </button>
                </div>
                <span className="block text-[10px] text-slate-600 mt-1">
                  {formatTime(c.updatedAt)} · {c.messages.length} 条消息
                </span>
              </div>
            );
          })
        )}
      </div>

      <footer className="px-3 py-2 text-[10px] text-slate-600 border-t border-slate-800 shrink-0">
        双击标题可重命名 · 本地存储
      </footer>
    </aside>
  );
}