"use client";
import React, { useState, useRef, useEffect, useCallback } from "react";
import CodeEditor, { CodeEditorHandle } from "@/components/editor/CodeEditor";
import AgentConsole from "@/components/console/AgentConsole";
import ConversationSidebar from "@/components/console/ConversationSidebar";
import { useAuditor } from "@/hooks/useAuditor";
import { useASTAnalysis } from "@/hooks/useASTAnalysis";
import { useConversations } from "@/hooks/useConversations";
import { DEFAULT_CODE } from "@/lib/defaultCode";
import { createMessage, buildHistoryMessages } from "@/lib/messages";
import type { Conversation } from "@/types";

export default function IDEPage() {
  const [code, setCode] = useState<string>(DEFAULT_CODE);
  const [userPrompt, setUserPrompt] = useState<string>("");
  const [consoleWidth, setConsoleWidth] = useState(450);
  // 右侧会话历史面板是否展开（点击 AgentConsole 头部图标切换）
  const [showConversationPanel, setShowConversationPanel] = useState(false);

  // ---- 会话层：历史对话、切换、持久化 ----
  const {
    conversations,
    activeConversation,
    activeConversationId,
    isHydrated,
    createConversation,
    selectConversation,
    deleteConversation,
    appendMessage,
    updateMessage,
    addUserMessage,
    renameConversation,
  } = useConversations();

  // ---- 审计执行层 ----
  const { isAuditing, models, selectedModel, setSelectedModel, startAudit, stopAudit } =
    useAuditor();

  // ---- AST 静态分析层（用于编辑器高亮） ----
  const { analysisResult, analyzeCode } = useASTAnalysis();

  // 拖拽分隔条相关
  const dragState = useRef({ isDragging: false, startX: 0, startWidth: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CodeEditorHandle | null>(null);

  // 只在初始水合后恢复一次编辑器代码，避免覆盖用户输入
  const didInitialRestore = useRef(false);
  useEffect(() => {
    if (isHydrated && !didInitialRestore.current) {
      didInitialRestore.current = true;
      // 读取到外部恢复的数据后，延迟到微任务写回编辑器，满足 react-hooks/set-state-in-effect 校验
      const conversation = activeConversation;
      queueMicrotask(() => {
        const lastUser = conversation
          ? [...conversation.messages].reverse().find((m) => m.role === "user" && m.code)
          : undefined;
        if (lastUser?.code) setCode(lastUser.code);
      });
    }
  }, [isHydrated, activeConversation]);

  // 把某个会话的最新用户代码恢复到编辑器
  const restoreToEditor = useCallback((conv: Conversation | null) => {
    const lastUser = conv
      ? [...conv.messages].reverse().find((m) => m.role === "user" && m.code)
      : undefined;
    setCode(lastUser?.code ?? DEFAULT_CODE);
  }, []);

  const handleCreateConversation = useCallback(() => {
    createConversation();
    restoreToEditor(null);
  }, [createConversation, restoreToEditor]);

  const handleSelectConversation = useCallback(
    (id: string) => {
      selectConversation(id);
      const target = conversations.find((c) => c.id === id) ?? null;
      restoreToEditor(target);
    },
    [conversations, selectConversation, restoreToEditor]
  );

  const handleDeleteConversation = useCallback(
    (id: string) => {
      deleteConversation(id);
      // 删除后回退到列表中最新的会话，并恢复其代码
      const remaining = conversations.filter((c) => c.id !== id);
      restoreToEditor(remaining.length ? remaining[remaining.length - 1] : null);
    },
    [conversations, deleteConversation, restoreToEditor]
  );

  // ---------------- 拖拽调整控制台宽度 ----------------
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.current.isDragging || !containerRef.current) return;
      const deltaX = dragState.current.startX - e.clientX;
      let newWidth = dragState.current.startWidth + deltaX;
      newWidth = Math.max(300, Math.min(800, newWidth));
      setConsoleWidth(newWidth);
    };
    const handleMouseUp = () => {
      dragState.current.isDragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { isDragging: true, startX: e.clientX, startWidth: consoleWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // ---------------- 运行审计：AST 分析 + 写入会话 + 流式 AI ----------------
  const handleRunAudit = async () => {
    if (!code.trim() || isAuditing) return;

    // 无当前会话时自动创建（标题由代码/追问自动生成）
    let conv = activeConversation;
    if (!conv) {
      conv = createConversation(code, userPrompt);
    }
    const convId = conv.id;

    // 1) 先跑 AST 静态分析，更新编辑器高亮
    await analyzeCode(code);

    // 2) 追加本轮用户消息并记录代码快照
    const userMessage = addUserMessage(convId, {
      code,
      userPrompt,
      modelId: selectedModel || undefined,
    });

    // 3) 构造多轮上下文（当前回合之前的所有已完成消息）
    const history = buildHistoryMessages(conv, userMessage.id);

    // 4) 追加 assistant 占位消息，随后由流式回调逐步填充
    const assistantMessage = createMessage("assistant", { status: "running", content: "" });
    appendMessage(convId, assistantMessage);

    // 5) 启动流式审计，增量内容实时写回对应 assistant 消息
    startAudit({
      code,
      userPrompt,
      modelId: selectedModel || undefined,
      history,
      onChunk: (content) =>
        updateMessage(convId, assistantMessage.id, { status: "running", content }),
      onStatus: (status) => updateMessage(convId, assistantMessage.id, { status }),
    });
  };

  // AST 摘要（紧凑一行，展示在控制台顶部）
  // AST 摘要：分析成功后始终显示（含 0 问题），给用户明确的反饋
  const astSummary = analysisResult?.success
    ? { totalIssues: analysisResult.totalIssues, highSeverity: analysisResult.highSeverity }
    : null;

  return (
    <main
      ref={containerRef}
      className="flex h-screen w-full overflow-hidden bg-slate-950 text-slate-300"
    >
      {/* 代码编辑器（左侧留空，预留为将来的本地项目 / 文件选择区） */}
      <CodeEditor
        ref={editorRef}
        value={code}
        onChange={(val) => val !== undefined && setCode(val)}
        models={models}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        issues={analysisResult?.success ? analysisResult.issues : []}
      />

      {/* 右侧：会话历史面板（由 AgentConsole 头部图标控制展开 / 收起） */}
      {showConversationPanel && (
        <ConversationSidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          onCreate={handleCreateConversation}
          onSelect={handleSelectConversation}
          onDelete={handleDeleteConversation}
          onRename={renameConversation}
        />
      )}

      {/* 拖拽分隔条 */}
      <div
        className="w-1 cursor-col-resize bg-slate-700 hover:bg-cyan-500 transition-colors flex-shrink-0"
        onMouseDown={handleMouseDown}
      />

      {/* 右侧：会话消息流 + 审计控制 */}
      <AgentConsole
        conversation={activeConversation}
        isAuditing={isAuditing}
        isHydrated={isHydrated}
        onRunAudit={handleRunAudit}
        onStopAudit={stopAudit}
        userPrompt={userPrompt}
        onUserPromptChange={setUserPrompt}
        astSummary={astSummary}
        width={consoleWidth}
        onToggleConversations={() => setShowConversationPanel((v) => !v)}
        conversationsOpen={showConversationPanel}
      />
    </main>
  );
}