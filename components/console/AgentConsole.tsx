"use client";
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface AgentConsoleProps {
  auditResult: string;
  isAuditing: boolean;
  onRunAudit: () => void;
}

export default function AgentConsole({
  auditResult,
  isAuditing,
  onRunAudit,
}: AgentConsoleProps) {
  return (
    <section className="w-[450px] bg-slate-900 flex flex-col border-l border-slate-800">
      <header className="px-4 py-3 bg-slate-800/50 border-b border-slate-800 shrink-0">
        <h2 className="text-sm font-bold text-rose-400 flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${isAuditing ? "bg-rose-500 animate-pulse" : "bg-slate-500"}`}
          ></span>
          Agent Console
        </h2>
      </header>

      {/* 中间信息展示区：增加了 prose 类名来进行 Markdown 美化 */}
      <div className="flex-1 p-4 overflow-y-auto">
        <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 text-sm">
          {/* 这里是见证奇迹的时刻 */}
          <article className="prose prose-invert prose-sm max-w-none prose-pre:bg-slate-800 prose-pre:border prose-pre:border-slate-700">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {auditResult}
            </ReactMarkdown>
          </article>
        </div>
      </div>

      <div className="p-4 border-t border-slate-800 shrink-0 bg-slate-900">
        <button
          onClick={onRunAudit}
          disabled={isAuditing}
          className={`w-full font-bold py-2 px-4 rounded transition-colors ${
            isAuditing
              ? "bg-slate-700 text-slate-500 cursor-not-allowed"
              : "bg-cyan-600 hover:bg-cyan-500 text-white"
          }`}
        >
          {isAuditing ? "Auditing..." : "Run Audit"}
        </button>
      </div>
    </section>
  );
}
