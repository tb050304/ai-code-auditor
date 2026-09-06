"use client";
import React, { useState, useRef, useEffect, useCallback } from "react";
import CodeEditor, { CodeEditorHandle } from "@/components/editor/CodeEditor";
import AgentConsole from "@/components/console/AgentConsole";
import ConversationSidebar from "@/components/console/ConversationSidebar";
import ProjectSidebar from "@/components/file-tree/ProjectSidebar";
import { useAuditor } from "@/hooks/useAuditor";
import { useASTAnalysis } from "@/hooks/useASTAnalysis";
import { useConversations } from "@/hooks/useConversations";
import { useProject } from "@/hooks/useProject";
import { useEditorTabs } from "@/hooks/useEditorTabs";
import { useBatchAnalysis } from "@/hooks/useBatchAnalysis";
import { DEFAULT_CODE } from "@/lib/defaultCode";
import { isAnalyzableFile } from "@/lib/ast/batch-types";
import { createMessage, buildHistoryMessages } from "@/lib/messages";
import type { Conversation } from "@/types";
import type { ImportResult } from "@/lib/storage/import";

export default function IDEPage() {
  const [userPrompt, setUserPrompt] = useState<string>("");
  const [consoleWidth, setConsoleWidth] = useState(450);
  // 右侧会话历史面板是否展开
  const [showConversationPanel, setShowConversationPanel] = useState(false);

  // ---- 会话层 ----
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

  // ---- AST 静态分析层 ----
  const { analysisResult, analyzeCode } = useASTAnalysis();

  // ---- 项目与文件管理层 ----
  const {
    projects,
    activeProjectId,
    selectProject,
    deleteProject,
    refreshProjects,
    fileTree,
    writeFile,
    mkdir,
    deleteNode,
    renameNode,
    readFile,
  } = useProject();

  // ---- 多 Tab 编辑器 ----
  const {
    tabs,
    activeTabPath,
    activeTab,
    openTab,
    closeTab,
    activateTab,
    updateActiveContent,
    saveActiveTab,
    isDirty,
    closeOtherTabs,
    closeAllTabs,
    renameTab,
    removeTab,
  } = useEditorTabs();

  // ---- 批量 AST 分析 ----
  const {
    isAnalyzing: batchAnalyzing,
    progress: batchProgress,
    result: batchResult,
    error: batchError,
    fileResults,
    startAnalysis: startBatchAnalysis,
    cancelAnalysis: cancelBatchAnalysis,
    getFileIssues,
  } = useBatchAnalysis();

  // 当前编辑器内容：有激活 Tab 时用 Tab 的内容，否则用单文件模式的 code
  const [standaloneCode, setStandaloneCode] = useState<string>(DEFAULT_CODE);
  const editorCode = activeTab ? activeTab.content : standaloneCode;

  // 点击文件树中的文件 → 在 Tab 中打开
  const handleFileClick = useCallback(
    async (path: string) => {
      // 如果已经打开，直接激活
      const existing = tabs.find((t) => t.path === path);
      if (existing) {
        activateTab(path);
        return;
      }
      try {
        const content = await readFile(path);
        openTab(path, content);
      } catch (e) {
        console.error("读取文件失败:", e);
        alert(`读取文件失败: ${e}`);
      }
    },
    [readFile, openTab, activateTab, tabs],
  );

  // 点击问题面板中的问题 → 打开文件并滚动到指定行
  const handleIssueClick = useCallback(
    async (path: string, line: number) => {
      // 打开/激活对应 Tab
      const existing = tabs.find((t) => t.path === path);
      if (existing) {
        activateTab(path);
      } else {
        try {
          const content = await readFile(path);
          openTab(path, content);
        } catch (e) {
          console.error("读取文件失败:", e);
          return;
        }
      }
      // 滚动到指定行（等一帧让编辑器挂载/切换完成）
      requestAnimationFrame(() => {
        editorRef.current?.scrollToLine(line);
      });
    },
    [tabs, activateTab, readFile, openTab],
  );

  // 编辑器内容变化回调
  const handleEditorChange = useCallback(
    (val: string | undefined) => {
      if (val === undefined) return;
      if (activeTabPath) {
        updateActiveContent(val);
      } else {
        setStandaloneCode(val);
      }
    },
    [activeTabPath, updateActiveContent],
  );

  // 新建文件
  const handleCreateFile = useCallback(
    async (parentDir: string, name: string) => {
      if (!name.trim()) return;
      try {
        const path = parentDir === "/" ? `/${name}` : `${parentDir}/${name}`;
        await writeFile(path, "");
        openTab(path, "");
      } catch (e) {
        console.error("新建文件失败:", e);
        alert(`新建文件失败: ${e}`);
      }
    },
    [writeFile, openTab],
  );

  // 新建文件夹
  const handleCreateDir = useCallback(
    async (parentDir: string, name: string) => {
      if (!name.trim()) return;
      try {
        const path = parentDir === "/" ? `/${name}` : `${parentDir}/${name}`;
        await mkdir(path);
      } catch (e) {
        console.error("新建文件夹失败:", e);
        alert(`新建文件夹失败: ${e}`);
      }
    },
    [mkdir],
  );

  // 删除文件/文件夹
  const handleDeleteNode = useCallback(
    async (path: string, type: "file" | "directory") => {
      const displayName = path.slice(1) || path;
      if (!confirm(`确认删除 ${type === "directory" ? "文件夹" : "文件"} "${displayName}" 吗？`)) {
        return;
      }
      try {
        await deleteNode(path);
        // 从 Tab 中移除（不提示，文件都没了）
        if (type === "file") {
          removeTab(path);
        } else {
          // 目录：移除所有子路径的 tab
          const toRemove = tabs.filter((t) => t.path.startsWith(path + "/"));
          for (const t of toRemove) removeTab(t.path);
        }
      } catch (e) {
        console.error("删除失败:", e);
        alert(`删除失败: ${e}`);
      }
    },
    [deleteNode, removeTab, tabs],
  );

  // 重命名文件/文件夹
  const handleRenameNode = useCallback(
    async (oldPath: string, newName: string) => {
      if (!newName.trim()) return;
      try {
        const node = await renameNode(oldPath, newName);
        // 如果是文件，更新对应的 tab
        if (node.type === "file") {
          renameTab(oldPath, node.path);
        } else {
          // 目录：更新所有子路径的 tab
          const affected = tabs.filter((t) => t.path.startsWith(oldPath + "/"));
          for (const t of affected) {
            const newPath = node.path + t.path.slice(oldPath.length);
            renameTab(t.path, newPath);
          }
        }
      } catch (e) {
        console.error("重命名失败:", e);
        alert(`重命名失败: ${e}`);
      }
    },
    [renameNode, renameTab, tabs],
  );

  // Tab 保存（右键菜单触发）
  const handleSaveTab = useCallback(
    (path: string) => {
      const tab = tabs.find((t) => t.path === path);
      if (!tab) return;
      saveActiveTab(async (p, c) => {
        await writeFile(p, c);
      });
    },
    [tabs, saveActiveTab, writeFile],
  );

  // 导入成功后刷新 + 重新批量分析
  const handleImported = useCallback(
    (_result: ImportResult) => {
      refreshProjects();
    },
    [refreshProjects],
  );

  // 切换项目后自动触发批量分析
  const runIdRef = useRef(0);
  useEffect(() => {
    if (!activeProjectId || !fileTree) return;

    const runId = ++runIdRef.current;

    (async () => {
      // 收集所有可分析文件的内容
      const analyzable: Array<{ path: string; content: string }> = [];

      const walk = (node: typeof fileTree): void => {
        if (!node) return;
        if (node.type === "file" && isAnalyzableFile(node.path)) {
          analyzable.push({ path: node.path, content: "" });
        }
        if (node.type === "directory" && node.children) {
          for (const child of node.children) walk(child as any);
        }
      };
      walk(fileTree);

      if (analyzable.length === 0) return;

      // 批量读取内容（用 Promise.all 并发读）
      const tasks = await Promise.all(
        analyzable.map(async (f) => ({
          path: f.path,
          content: await readFile(f.path),
        })),
      );

      if (runId !== runIdRef.current) return;

      startBatchAnalysis(tasks);
    })();

    return () => {
      runIdRef.current++;
    };
  }, [activeProjectId, fileTree?.path, readFile, startBatchAnalysis]);

  // 手动重新分析当前项目
  const handleReanalyze = useCallback(() => {
    if (!activeProjectId || !fileTree) return;

    (async () => {
      const analyzable: Array<{ path: string; content: string }> = [];
      const walk = (node: any): void => {
        if (!node) return;
        if (node.type === "file" && isAnalyzableFile(node.path)) {
          analyzable.push({ path: node.path, content: "" });
        }
        if (node.children) {
          for (const child of node.children) walk(child);
        }
      };
      walk(fileTree);

      const tasks = await Promise.all(
        analyzable.map(async (f) => ({
          path: f.path,
          content: await readFile(f.path),
        })),
      );

      startBatchAnalysis(tasks);
    })();
  }, [activeProjectId, fileTree, readFile, startBatchAnalysis]);

  // 拖拽分隔条
  const dragState = useRef({ isDragging: false, startX: 0, startWidth: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CodeEditorHandle | null>(null);

  // 初始水合后恢复一次编辑器代码（单文件模式）
  const didInitialRestore = useRef(false);
  useEffect(() => {
    if (isHydrated && !didInitialRestore.current) {
      didInitialRestore.current = true;
      const conversation = activeConversation;
      queueMicrotask(() => {
        const lastUser = conversation
          ? [...conversation.messages].reverse().find((m) => m.role === "user" && m.code)
          : undefined;
        if (lastUser?.code) setStandaloneCode(lastUser.code);
      });
    }
  }, [isHydrated, activeConversation]);

  // 把某个会话的最新用户代码恢复到编辑器（单文件模式）
  const restoreToEditor = useCallback((conv: Conversation | null) => {
    const lastUser = conv
      ? [...conv.messages].reverse().find((m) => m.role === "user" && m.code)
      : undefined;
    setStandaloneCode(lastUser?.code ?? DEFAULT_CODE);
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

  // ---------------- 运行审计 ----------------
  const handleRunAudit = async () => {
    const code = editorCode;
    if (!code.trim() || isAuditing) return;

    let conv = activeConversation;
    if (!conv) {
      conv = createConversation(code, userPrompt);
    }
    const convId = conv.id;

    // 1) AST 静态分析
    await analyzeCode(code);

    // 2) 追加用户消息 + 代码快照
    const userMessage = addUserMessage(convId, {
      code,
      userPrompt,
      modelId: selectedModel || undefined,
    });

    // 3) 构造多轮上下文
    const history = buildHistoryMessages(conv, userMessage.id);

    // 4) 追加 assistant 占位
    const assistantMessage = createMessage("assistant", { status: "running", content: "" });
    appendMessage(convId, assistantMessage);

    // 5) 流式审计
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

  // 快捷键：Ctrl+S 保存当前 Tab
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (activeTabPath && isDirty(activeTabPath)) {
          saveActiveTab(async (p, c) => {
            await writeFile(p, c);
          });
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activeTabPath, isDirty, saveActiveTab, writeFile]);

  // AST 摘要
  const astSummary = analysisResult?.success
    ? { totalIssues: analysisResult.totalIssues, highSeverity: analysisResult.highSeverity }
    : null;

  const editorLanguage = activeTab ? activeTab.language : "javascript";
  const editorFileName = activeTab ? activeTab.path.slice(1) : undefined;

  return (
    <main
      ref={containerRef}
      className="flex h-screen w-full overflow-hidden bg-slate-950 text-slate-300"
    >
      {/* 左侧项目侧边栏 */}
      <ProjectSidebar
        projects={projects}
        activeProjectId={activeProjectId}
        fileTree={fileTree}
        activeFilePath={activeTabPath}
        fileResults={fileResults}
        onSelectProject={selectProject}
        onDeleteProject={deleteProject}
        onImported={handleImported}
        onFileClick={handleFileClick}
        onCreateFile={handleCreateFile}
        onCreateDir={handleCreateDir}
        onDeleteNode={handleDeleteNode}
        onRenameNode={handleRenameNode}
      />

      {/* 代码编辑器（多 Tab 模式） */}
      <CodeEditor
        ref={editorRef}
        value={editorCode}
        onChange={handleEditorChange}
        models={models}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        issues={
          activeTabPath && fileResults.has(activeTabPath)
            ? getFileIssues(activeTabPath)
            : analysisResult?.success
              ? analysisResult.issues
              : []
        }
        fileName={editorFileName}
        language={editorLanguage}
        tabs={tabs}
        activeTabPath={activeTabPath}
        onActivateTab={activateTab}
        onCloseTab={closeTab}
        onCloseOtherTabs={closeOtherTabs}
        onCloseAllTabs={closeAllTabs}
        onSaveTab={handleSaveTab}
        batchAnalyzing={batchAnalyzing}
        batchProgress={batchProgress}
        batchResult={batchResult}
        batchError={batchError}
        onCancelBatchAnalysis={cancelBatchAnalysis}
        onReanalyze={handleReanalyze}
        fileResults={fileResults}
        onIssueClick={handleIssueClick}
      />

      {/* 右侧：会话历史面板 */}
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
