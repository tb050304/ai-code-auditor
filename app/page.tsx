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
import { DEFAULT_CODE } from "@/lib/defaultCode";
import { createMessage, buildHistoryMessages } from "@/lib/messages";
import type { Conversation } from "@/types";
import type { ImportResult } from "@/lib/storage/import";
import { extname } from "@/lib/storage/path";

function inferMonacoLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".html": "html",
    ".htm": "html",
    ".xml": "xml",
    ".svg": "xml",
    ".md": "markdown",
    ".markdown": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".sql": "sql",
    ".vue": "html",
    ".svelte": "html",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
  };
  return map[ext] || "plaintext";
}

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

  // 当前打开的文件路径（null 表示单文件模式，用 DEFAULT_CODE）
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  // 点击文件树中的文件，读取内容并加载到编辑器
  const handleFileClick = useCallback(
    async (path: string) => {
      try {
        const content = await readFile(path);
        setCode(content);
        setActiveFilePath(path);
      } catch (e) {
        console.error("读取文件失败:", e);
      }
    },
    [readFile],
  );

  // 新建文件
  const handleCreateFile = useCallback(
    async (parentDir: string, name: string) => {
      if (!name.trim()) return;
      try {
        const path = parentDir === "/" ? `/${name}` : `${parentDir}/${name}`;
        await writeFile(path, "");
        setActiveFilePath(path);
        setCode("");
      } catch (e) {
        console.error("新建文件失败:", e);
        alert(`新建文件失败: ${e}`);
      }
    },
    [writeFile],
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
        // 如果删除的是当前打开的文件，清空编辑器
        if (activeFilePath === path || (type === "directory" && activeFilePath?.startsWith(path + "/"))) {
          setActiveFilePath(null);
          setCode(DEFAULT_CODE);
        }
      } catch (e) {
        console.error("删除失败:", e);
        alert(`删除失败: ${e}`);
      }
    },
    [deleteNode, activeFilePath],
  );

  // 重命名文件/文件夹
  const handleRenameNode = useCallback(
    async (oldPath: string, newName: string) => {
      if (!newName.trim()) return;
      try {
        const node = await renameNode(oldPath, newName);
        // 如果重命名的是当前打开的文件，更新路径
        if (activeFilePath === oldPath) {
          setActiveFilePath(node.path);
        }
      } catch (e) {
        console.error("重命名失败:", e);
        alert(`重命名失败: ${e}`);
      }
    },
    [renameNode, activeFilePath],
  );

  // 导入成功后刷新项目列表（新的项目 id 会由 useProject 自动选中）
  const handleImported = useCallback(
    (_result: ImportResult) => {
      refreshProjects();
    },
    [refreshProjects],
  );

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

  // 根据文件扩展名推断 Monaco 语言
  const editorLanguage = activeFilePath
    ? inferMonacoLanguage(activeFilePath)
    : "javascript";

  // 编辑器显示的文件名（去掉开头的 /）
  const editorFileName = activeFilePath ? activeFilePath.slice(1) : undefined;

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
        activeFilePath={activeFilePath}
        onSelectProject={selectProject}
        onDeleteProject={deleteProject}
        onImported={handleImported}
        onFileClick={handleFileClick}
        onCreateFile={handleCreateFile}
        onCreateDir={handleCreateDir}
        onDeleteNode={handleDeleteNode}
        onRenameNode={handleRenameNode}
      />

      {/* 代码编辑器 */}
      <CodeEditor
        ref={editorRef}
        value={code}
        onChange={(val) => val !== undefined && setCode(val)}
        models={models}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        issues={analysisResult?.success ? analysisResult.issues : []}
        fileName={editorFileName}
        language={editorLanguage}
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