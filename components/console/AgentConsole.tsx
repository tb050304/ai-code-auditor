"use client";
// ---------------------------------------------------------------------------
// AgentConsole —— 会话消息流 + 审计控制台
// ---------------------------------------------------------------------------
// 本组件从“展示一段审计结果”升级为“展示一整串对话消息”：
//   1. 按时间顺序渲染当前会话的 user / assistant 消息；
//   2. assistant 报告用 Markdown 实时渲染（支持流式增量）；
//   3. 每条 user 消息可展开查看当时的待审计代码；
//   4. 底部为补充要求输入框 + 运行 / 停止按钮（即“继续追问”入口）。
// ---------------------------------------------------------------------------

import React, { useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Conversation } from "@/types";

interface ASTSummary {
  totalIssues: number;
  highSeverity: number;
}

interface AgentConsoleProps {
  conversation: Conversation | null;
  isAuditing: boolean;
  isHydrated: boolean;
  onRunAudit: () => void;
  onStopAudit: () => void;
  userPrompt: string;
  onUserPromptChange: (prompt: string) => void;
  astSummary: ASTSummary | null;
  width?: number;
  /** 点击头部图标展开 / 收起右侧会话历史面板 */
  onToggleConversations?: () => void;
  /** 会话历史面板当前是否展开 */
  conversationsOpen?: boolean;
}

/** 结束状态对应的提示条 */
const STATUS_BANNER: Record<string, { text: string; cls: string }> = {
  error: { text: "⚠️ 本次审计出错，请查看下方报告或控制台。", cls: "bg-rose-500/15 text-rose-400 border-rose-500/40" },
  aborted: { text: "⏹️ 已手动停止本次输出。", cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/40" },
};

export default function AgentConsole({
  conversation,
  isAuditing,
  isHydrated,
  onRunAudit,
  onStopAudit,
  userPrompt,
  onUserPromptChange,
  astSummary,
  width = 450,
  onToggleConversations,
  conversationsOpen = false,
}: AgentConsoleProps) {
  const messages = conversation?.messages ?? [];
  const lastMessage = messages[messages.length - 1];

  // 滚动到底部：新消息或内容变长时自动跟随
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastMessage?.content?.length, isAuditing]);

  return (
    <section
      className="bg-slate-900 flex flex-col border-l border-slate-800"
      style={{ width: `${width}px`, flexShrink: 0 }}
    >
      {/* 头部 */}
      <header className="px-4 py-3 bg-slate-800/50 border-b border-slate-800 shrink-0 flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-rose-400 flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                isAuditing ? "bg-rose-500 animate-pulse" : "bg-slate-500"
              }`}
            />
            Agent Console
          </h2>
          {/* 当前会话标题，方便在切换时明确“现在在看哪一个” */}
          <p className="text-[11px] text-slate-500 truncate mt-0.5" title={conversation?.title}>
            {conversation?.title || "未选择对话"}
          </p>
        </div>
        {/* 对话历史切换入口：展开 / 收起右侧会话面板 */}
        <button
          type="button"
          onClick={onToggleConversations}
          title={conversationsOpen ? "收起对话历史" : "展开对话历史"}
          aria-pressed={conversationsOpen}
          className={`shrink-0 flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
            conversationsOpen
              ? "bg-cyan-500/20 border-cyan-500/60 text-cyan-300"
              : "bg-slate-800 border-slate-700 text-slate-300 hover:text-white"
          }`}
        >
          🕘 对话
        </button>
      </header>

      {/* 消息流 */}
      <div ref={scrollRef} className="flex-1 min-h-0 p-4 overflow-y-auto space-y-4">
        {/* AST 摘要：来自最近一次静态分析，紧凑一行 */}
        {astSummary && (
          <div className="text-[11px] text-slate-500 bg-slate-800/50 rounded px-2 py-1">
            AST 静态分析：{astSummary.totalIssues} 个问题
            {astSummary.highSeverity > 0 && `（含 ${astSummary.highSeverity} 个错误）`} · 详见编辑器标记
          </div>
        )}

        {!isHydrated ? (
          <div className="text-center text-slate-500 py-10 text-sm">正在加载对话…</div>
        ) : messages.length === 0 ? (
          <div className="text-center text-slate-500 py-10">
            <div className="text-4xl mb-4">🔍</div>
            <p>输入代码后点击「Run Audit」开始审计</p>
            <p className="text-xs mt-2">支持多轮追问，历史与代码将保留在本会话中</p>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="space-y-2">
              {/* -------- 用户消息 -------- */}
              {message.role === "user" && (
                <div className="flex flex-col items-end">
                  <div className="max-w-full rounded-lg px-3 py-2 bg-slate-800 border border-slate-700 text-sm text-slate-200">
                    <div className="text-[10px] uppercase text-slate-500 mb-0.5">
                      {message.modelId ? `You · ${message.modelId}` : "You"}
                    </div>
                    <p className="whitespace-pre-wrap break-words">
                      {message.content || "审计以下代码："}
                    </p>

                    {/* 可展开的代码快照 */}
                    {message.code && (
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-cyan-400 select-none">
                          查看待审计代码（{message.code.split("\n").length} 行）
                        </summary>
                        <pre className="mt-2 max-h-60 overflow-auto rounded bg-slate-950 p-2 border border-slate-700 text-[11px] leading-relaxed">
                          {message.code}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              )}

              {/* -------- 助手消息 -------- */}
              {message.role === "assistant" && (
                <div className="flex flex-col items-start">
                  <div className="w-full rounded-lg bg-slate-950 border border-slate-800 p-3 text-sm">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-400">
                        AI
                      </span>
                      {message.status === "running" && (
                        <span className="text-[10px] text-slate-500 animate-pulse">生成中…</span>
                      )}
                    </div>

                    <article className="prose prose-invert prose-sm max-w-none prose-pre:bg-slate-800 prose-pre:border prose-pre:border-slate-700">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {message.content || "*正在等待模型输出…*"}
                      </ReactMarkdown>
                    </article>
                  </div>

                  {/* 结束状态提示 */}
                  {STATUS_BANNER[message.status] && (
                    <div
                      className={`mt-2 text-xs px-3 py-1.5 rounded border ${STATUS_BANNER[message.status].cls}`}
                    >
                      {STATUS_BANNER[message.status].text}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* 底部：补充要求 + 运行/停止 */}
      <div className="px-4 pt-2 pb-3 border-t border-slate-800 bg-slate-900 shrink-0">
        <label className="block text-[11px] text-slate-400 mb-1">
          补充要求 / 继续追问（可选）
        </label>
        <textarea
          value={userPrompt}
          onChange={(e) => onUserPromptChange(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd + Enter 快捷运行
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (!isAuditing) onRunAudit();
            }
          }}
          placeholder="例如：重点解释第 2 个问题的修复方式…"
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-300 placeholder-slate-500 focus:outline-none focus:border-cyan-500 resize-none"
          rows={2}
        />
        <div className="mt-2 flex gap-2">
          <button
            onClick={onRunAudit}
            disabled={isAuditing}
            className="flex-1 font-bold py-2 px-4 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-cyan-600 hover:bg-cyan-500 text-white"
          >
            🚀 运行审计
          </button>
          {isAuditing && (
            <button
              onClick={onStopAudit}
              className="font-bold py-2 px-4 rounded transition-colors bg-rose-600 hover:bg-rose-500 text-white"
            >
              ⏹️ 停止
            </button>
          )}
        </div>
        <p className="mt-1 text-[10px] text-slate-600">提示：喜欢的话可用 Ctrl/Cmd + Enter 快速运行审计。</p>
      </div>
    </section>
  );
}