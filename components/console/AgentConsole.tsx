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

import React, { useRef, useEffect, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMode, Conversation } from "@/types";
import AgentSteps from "./AgentSteps";

/** 从 ReactMarkdown 渲染出的 <code> 子节点中递归提取纯文本 */
function nodeToText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (React.isValidElement(node)) {
    return nodeToText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

interface CodeBlockActionsProps {
  lang: string;
  code: string;
  hasEditorSelection: boolean;
  onInsertCode?: (code: string) => void;
  onReplaceCode?: (code: string) => void;
  onCreateFile?: (code: string, lang: string) => void;
}

/** 代码块顶部操作条：复制 / 插入光标处 / 替换选中 / 新建文件（Day 23） */
function CodeBlockActions({
  lang,
  code,
  hasEditorSelection,
  onInsertCode,
  onReplaceCode,
  onCreateFile,
}: CodeBlockActionsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // 剪贴板权限/非安全上下文降级：临时 textarea + execCommand
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* 忽略：复制失败不影响其他操作 */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [code]);

  const btnCls =
    "px-1.5 py-0.5 text-[10px] rounded border border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-slate-700 bg-slate-900/80">
      <span className="text-[10px] text-slate-500 mr-auto truncate">
        {lang ? `代码块 · ${lang}` : "代码块"}
      </span>
      <button type="button" className={btnCls} onClick={handleCopy} title="复制代码">
        {copied ? "✓ 已复制" : "📋 复制"}
      </button>
      <button
        type="button"
        className={btnCls}
        onClick={() => onInsertCode?.(code)}
        disabled={!onInsertCode}
        title="在编辑器当前光标处插入这段代码"
      >
        ⤵ 插入光标处
      </button>
      <button
        type="button"
        className={btnCls}
        onClick={() => onReplaceCode?.(code)}
        disabled={!onReplaceCode || !hasEditorSelection}
        title={hasEditorSelection ? "替换编辑器中当前选中的内容" : "请先在编辑器中选中要替换的内容"}
      >
        ⇆ 替换选中
      </button>
      <button
        type="button"
        className={btnCls}
        onClick={() => onCreateFile?.(code, lang)}
        disabled={!onCreateFile}
        title="把这段代码保存为项目中的新文件并打开"
      >
        📄 新建文件
      </button>
    </div>
  );
}

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
  /** 当前对话模式（Day 22）：审计 / 通用编程 / Agent */
  chatMode?: ChatMode;
  onChatModeChange?: (mode: ChatMode) => void;
  // ---- Day 23：代码块写回编辑器 ----
  /** 编辑器当前是否有选中内容（控制"替换选中"可用性） */
  hasEditorSelection?: boolean;
  onInsertCode?: (code: string) => void;
  onReplaceCode?: (code: string) => void;
  onCreateFile?: (code: string, lang: string) => void;
}

/** 模式的展示元数据（分段切换按钮、文案复用） */
const MODE_META: Record<ChatMode, { label: string; icon: string; title: string }> = {
  audit: { label: "审计", icon: "🔍", title: "代码审计：围绕编辑器中的代码产出结构化审计报告" },
  chat: { label: "编程问答", icon: "💬", title: "通用编程：写新代码、解释代码、重构建议，可不依赖当前文件" },
  agent: { label: "Agent", icon: "🤖", title: "Agent：循环调用工具（读/写文件、分析、修复）实际操作项目" },
};

/** assistant 消息上的模式徽章（旧数据无 mode 字段，按有无 steps 推断） */
const MODE_BADGE: Record<ChatMode, { text: string; cls: string }> = {
  audit: { text: "审计", cls: "bg-cyan-500/20 text-cyan-400" },
  chat: { text: "问答", cls: "bg-violet-500/20 text-violet-300" },
  agent: { text: "Agent", cls: "bg-emerald-500/20 text-emerald-300" },
};

/** 结束状态对应的提示条 */
const STATUS_BANNER: Record<string, { text: string; cls: string }> = {
  error: { text: "⚠️ 本次输出出错，请查看下方内容或控制台。", cls: "bg-rose-500/15 text-rose-400 border-rose-500/40" },
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
  chatMode = "audit",
  onChatModeChange,
  hasEditorSelection = false,
  onInsertCode,
  onReplaceCode,
  onCreateFile,
}: AgentConsoleProps) {
  const messages = conversation?.messages ?? [];
  const lastMessage = messages[messages.length - 1];

  // 滚动到底部：新消息或内容变长时自动跟随
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastMessage?.content?.length, isAuditing]);

  // 各模式下的输入区文案
  const inputLabel =
    chatMode === "agent"
      ? "Agent 任务指令（可操作项目文件）"
      : chatMode === "chat"
        ? "编程问题 / 需求描述"
        : "补充要求 / 继续追问（可选）";
  const inputPlaceholder =
    chatMode === "agent"
      ? "例如：审计整个项目并自动修复所有可安全修复的问题…"
      : chatMode === "chat"
        ? "例如：帮我写一个带取消功能的防抖 hook，或解释一下当前文件的这段逻辑…"
        : "例如：重点解释第 2 个问题的修复方式…";
  const runButtonText =
    chatMode === "agent" ? "🤖 运行 Agent" : chatMode === "chat" ? "💬 发送" : "🚀 运行审计";
  const emptyHint =
    chatMode === "agent"
      ? { icon: "🤖", title: "输入任务指令后运行 Agent", desc: "Agent 会自主分析、修改项目文件，每一步工具调用实时展示" }
      : chatMode === "chat"
        ? { icon: "💬", title: "直接输入编程问题开始对话", desc: "写代码、解释代码、重构建议；编辑器中有打开文件时会自动附带上下文" }
        : { icon: "🔍", title: "输入代码后点击「运行审计」", desc: "支持多轮追问，历史与代码将保留在本会话中" };

  // Markdown 渲染定制：围栏代码块附带"复制/插入/替换/新建文件"操作条
  const markdownComponents = {
    pre({ children }: { children?: React.ReactNode }) {
      if (!React.isValidElement(children)) return <pre>{children}</pre>;
      const codeProps = children.props as { className?: string; children?: React.ReactNode };
      const lang = /language-([\w-]+)/.exec(codeProps.className ?? "")?.[1] ?? "";
      const code = nodeToText(codeProps.children).replace(/\n$/, "");
      return (
        <div className="my-2 rounded-lg overflow-hidden border border-slate-700">
          <CodeBlockActions
            lang={lang}
            code={code}
            hasEditorSelection={hasEditorSelection}
            onInsertCode={onInsertCode}
            onReplaceCode={onReplaceCode}
            onCreateFile={onCreateFile}
          />
          {children}
        </div>
      );
    },
  };

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
            <div className="text-4xl mb-4">{emptyHint.icon}</div>
            <p>{emptyHint.title}</p>
            <p className="text-xs mt-2">{emptyHint.desc}</p>
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
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-300">
                        AI
                      </span>
                      {(() => {
                        const mode: ChatMode =
                          message.mode ?? (message.steps?.length ? "agent" : "audit");
                        const badge = MODE_BADGE[mode];
                        return (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.cls}`}>
                            {badge.text}
                          </span>
                        );
                      })()}
                      {message.status === "running" && (
                        <span className="text-[10px] text-slate-500 animate-pulse">生成中…</span>
                      )}
                    </div>

                    {/* Agent 模式：思考-执行循环的每步工具面板 */}
                    <AgentSteps steps={message.steps} />

                    <article className="prose prose-invert prose-sm max-w-none prose-pre:bg-slate-800 prose-pre:border prose-pre:border-slate-700">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {message.content || (message.steps?.length ? "" : "*正在等待模型输出…*")}
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

      {/* 底部：模式分段切换 + 输入框 + 运行/停止 */}
      <div className="px-4 pt-2 pb-3 border-t border-slate-800 bg-slate-900 shrink-0">
        {/* 三态模式切换：审计 / 编程问答 / Agent */}
        <div
          role="tablist"
          aria-label="对话模式"
          className="mb-2 grid grid-cols-3 gap-1 rounded-lg bg-slate-800/70 border border-slate-700 p-1"
        >
          {(Object.keys(MODE_META) as ChatMode[]).map((mode) => {
            const meta = MODE_META[mode];
            const active = chatMode === mode;
            const activeCls =
              mode === "agent"
                ? "bg-emerald-500/25 text-emerald-300 border-emerald-500/50"
                : mode === "chat"
                  ? "bg-violet-500/25 text-violet-200 border-violet-500/50"
                  : "bg-cyan-500/25 text-cyan-200 border-cyan-500/50";
            return (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={active}
                title={meta.title}
                onClick={() => onChatModeChange?.(mode)}
                className={`flex items-center justify-center gap-1 px-1 py-1 text-[11px] rounded-md border transition-colors ${
                  active
                    ? activeCls
                    : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-700/50"
                }`}
              >
                <span>{meta.icon}</span>
                <span>{meta.label}</span>
              </button>
            );
          })}
        </div>

        <label className="block text-[11px] text-slate-400 mb-1">{inputLabel}</label>
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
          placeholder={inputPlaceholder}
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-300 placeholder-slate-500 focus:outline-none focus:border-cyan-500 resize-none"
          rows={2}
        />
        <div className="mt-2 flex gap-2">
          <button
            onClick={onRunAudit}
            disabled={isAuditing}
            className={`flex-1 font-bold py-2 px-4 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-white ${
              chatMode === "agent"
                ? "bg-emerald-600 hover:bg-emerald-500"
                : chatMode === "chat"
                  ? "bg-violet-600 hover:bg-violet-500"
                  : "bg-cyan-600 hover:bg-cyan-500"
            }`}
          >
            {runButtonText}
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
        <p className="mt-1 text-[10px] text-slate-600">
          {chatMode === "agent"
            ? "Agent 将循环执行：思考 → 调用工具 → 回执 → 继续思考，每一步在上方实时展示。"
            : "提示：Ctrl/Cmd + Enter 快速发送；编辑器中打开的文件会自动附带为上下文。"}
        </p>
      </div>
    </section>
  );
}