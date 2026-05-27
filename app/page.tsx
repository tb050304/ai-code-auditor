"use client";
import React, { useState, useRef, useEffect } from "react";
import CodeEditor, { Issue, CodeEditorHandle } from "@/components/editor/CodeEditor";
import AgentConsole from "@/components/console/AgentConsole";
import { useAuditor } from "@/hooks/useAuditor";
import { useASTAnalysis } from "@/hooks/useASTAnalysis";

export default function IDEPage() {
  const [code, setCode] = useState<string>(
    "// 请输入需要审计的 JavaScript/TypeScript 代码...\n\nfunction calculate(a, b) {\n  var result = a + b;\n  return result\n}",
  );

  const [userPrompt, setUserPrompt] = useState<string>("");
  const [consoleWidth, setConsoleWidth] = useState(450);
  const [issues, setIssues] = useState<Issue[]>([]);

  const {
    auditResult,
    isAuditing,
    isStopped,
    runAudit,
    stopAudit,
    models,
    selectedModel,
    setSelectedModel,
  } = useAuditor();

  const { isAnalyzing: isASTAnalyzing, analysisResult, analyzeCode } = useASTAnalysis();

  const dragState = useRef({ isDragging: false, startX: 0, startWidth: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CodeEditorHandle | null>(null);

  // 处理点击问题跳转到对应代码行
  const handleIssueClick = (line: number) => {
    if (editorRef.current) {
      editorRef.current.scrollToLine(line);
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.current.isDragging || !containerRef.current) return;

      const deltaX = dragState.current.startX - e.clientX;
      let newWidth = dragState.current.startWidth + deltaX;

      const minWidth = 300;
      const maxWidth = 800;
      newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
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
    
    dragState.current = {
      isDragging: true,
      startX: e.clientX,
      startWidth: consoleWidth,
    };
    
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const handleRunAudit = async () => {
    // 先进行 AST 分析
    await analyzeCode(code);
    
    // 然后运行 AI 审计
    runAudit(code, userPrompt);
  };

  // 当 AST 分析完成时更新 issues
  useEffect(() => {
    if (analysisResult && analysisResult.success) {
      setIssues(analysisResult.issues);
    }
  }, [analysisResult]);

  // 代码变化时自动重新进行 AST 分析（带防抖）
  useEffect(() => {
    const timer = setTimeout(() => {
      if (code.trim()) {
        analyzeCode(code);
      }
    }, 500); // 500ms 防抖

    return () => clearTimeout(timer);
  }, [code]);

  return (
    <main
      ref={containerRef}
      className="flex h-screen w-full overflow-hidden bg-slate-950 text-slate-300"
    >
      <CodeEditor
        ref={editorRef}
        value={code}
        onChange={(val) => val !== undefined && setCode(val)}
        models={models}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        issues={issues}
        onIssuesChange={setIssues}
      />

      <div
        className="w-1 cursor-col-resize bg-slate-700 hover:bg-cyan-500 transition-colors flex-shrink-0"
        onMouseDown={handleMouseDown}
      />

      <AgentConsole
        auditResult={auditResult}
        isAuditing={isAuditing}  // 只在真正 AI 审计时显示审计状态
        isStopped={isStopped}
        onRunAudit={handleRunAudit}
        onStopAudit={stopAudit}
        userPrompt={userPrompt}
        onUserPromptChange={setUserPrompt}
        astResult={analysisResult}
        width={consoleWidth}
        onIssueClick={handleIssueClick}
      />
    </main>
  );
}
