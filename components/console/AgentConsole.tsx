"use client";
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ASTAnalysisResult {
  success: boolean;
  totalIssues: number;
  highSeverity: number;
  duration: number;
  issues: Array<{
    id: string;
    type: string;
    severity: "error" | "warning" | "info";
    message: string;
    startLine: number;
    suggestion?: string;
  }>;
  report: string;
}

interface AgentConsoleProps {
  auditResult: string;
  isAuditing: boolean;
  isStopped?: boolean;
  onRunAudit: () => void;
  onStopAudit?: () => void;
  userPrompt?: string;
  onUserPromptChange?: (prompt: string) => void;
  astResult?: ASTAnalysisResult | null;
  width?: number;
  onIssueClick?: (line: number) => void;
}

export default function AgentConsole({
  auditResult,
  isAuditing,
  isStopped = false,
  onRunAudit,
  onStopAudit,
  userPrompt = "",
  onUserPromptChange,
  astResult,
  width = 450,
  onIssueClick,
}: AgentConsoleProps) {
  return (
    <section
      className="bg-slate-900 flex flex-col border-l border-slate-800"
      style={{ width: `${width}px`, flexShrink: 0 }}
    >
      <header className="px-4 py-3 bg-slate-800/50 border-b border-slate-800 shrink-0">
        <h2 className="text-sm font-bold text-rose-400 flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              isAuditing ? "bg-rose-500 animate-pulse" : "bg-slate-500"
            }`}
          ></span>
          Agent Console
        </h2>
      </header>

      <div className="flex-1 p-4 overflow-y-auto">
        {/* AST 分析结果 */}
        {astResult && astResult.success && (
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-bold text-slate-300 bg-slate-800 px-2 py-1 rounded">
                AST 静态分析
              </span>
              <span className="text-xs text-slate-500">
                {astResult.totalIssues} 个问题 · {astResult.duration}ms
              </span>
            </div>
            
            {/* 统计概览 */}
            {astResult.totalIssues > 0 && (
              <div className="flex gap-2 mb-3">
                {astResult.highSeverity > 0 && (
                  <span className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400">
                    ❌ {astResult.highSeverity} 错误
                  </span>
                )}
                {astResult.issues.filter(i => i.severity === "warning").length > 0 && (
                  <span className="text-xs px-2 py-1 rounded bg-yellow-500/20 text-yellow-400">
                    ⚠️ {astResult.issues.filter(i => i.severity === "warning").length} 警告
                  </span>
                )}
                {astResult.issues.filter(i => i.severity === "info").length > 0 && (
                  <span className="text-xs px-2 py-1 rounded bg-blue-500/20 text-blue-400">
                    ℹ️ {astResult.issues.filter(i => i.severity === "info").length} 提示
                  </span>
                )}
              </div>
            )}

            {/* 问题列表 */}
            {astResult.issues.length > 0 ? (
              <div className="space-y-2">
                {astResult.issues.map((issue, index) => (
                  <div
                    key={index}
                    onClick={() => onIssueClick?.(issue.startLine)}
                    className={`p-2 rounded text-xs border-l-2 cursor-pointer hover:opacity-80 transition-opacity ${
                      issue.severity === "error"
                        ? "bg-red-500/10 border-red-500"
                        : issue.severity === "warning"
                        ? "bg-yellow-500/10 border-yellow-500"
                        : "bg-blue-500/10 border-blue-500"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-cyan-400 shrink-0 hover:text-cyan-300">Line {issue.startLine}</span>
                      <span className="text-slate-300">{issue.message}</span>
                    </div>
                    {issue.suggestion && (
                      <div className="mt-1 text-slate-500 pl-8">
                        💡 {issue.suggestion}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-green-400 bg-green-500/10 p-3 rounded border border-green-500/30">
                ✅ 未检测到问题
              </div>
            )}
          </div>
        )}

        {/* 分隔线 */}
        {astResult && astResult.success && auditResult && auditResult !== "等待审计指令..." && (
          <div className="border-t border-slate-800 my-4" />
        )}

        {/* AI 审计结果 */}
        {auditResult && auditResult !== "等待审计指令..." && (
          <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 text-sm">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold text-cyan-400 bg-cyan-500/20 px-2 py-1 rounded">
                AI 审计结果
              </span>
            </div>
            <article className="prose prose-invert prose-sm max-w-none prose-pre:bg-slate-800 prose-pre:border prose-pre:border-slate-700">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {auditResult}
              </ReactMarkdown>
            </article>
          </div>
        )}

        {/* 等待状态 */}
        {!auditResult && !astResult && (
          <div className="text-center text-slate-500 py-8">
            <div className="text-4xl mb-4">🔍</div>
            <p>点击「Run Audit」开始审计</p>
            <p className="text-xs mt-2">将先进行 AST 静态分析，再进行 AI 审计</p>
          </div>
        )}
      </div>

      {/* 补充要求输入框 */}
      {onUserPromptChange && (
        <div className="px-4 pb-2 shrink-0">
          <label className="block text-xs text-slate-400 mb-1">
            补充要求（可选）
          </label>
          <textarea
            value={userPrompt}
            onChange={(e) => onUserPromptChange(e.target.value)}
            placeholder="例如：重点关注安全性、请用中文回答..."
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-300 placeholder-slate-500 focus:outline-none focus:border-cyan-500 resize-none"
            rows={2}
          />
        </div>
      )}

      <div className="p-4 border-t border-slate-800 shrink-0 bg-slate-900">
        {isAuditing ? (
          <button
            onClick={onStopAudit}
            className="w-full font-bold py-2 px-4 rounded transition-colors bg-rose-600 hover:bg-rose-500 text-white"
          >
            ⏹️ 停止输出
          </button>
        ) : (
          <button
            onClick={onRunAudit}
            className="w-full font-bold py-2 px-4 rounded transition-colors bg-cyan-600 hover:bg-cyan-500 text-white"
          >
            {isStopped ? "继续审计" : "Run Audit"}
          </button>
        )}
      </div>
    </section>
  );
}
