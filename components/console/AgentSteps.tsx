"use client";
/**
 * AgentSteps —— Agent 工具执行面板（Day 20）
 *
 * 展示思考-执行循环的每一步：模型思考文本 + 工具调用卡片
 * （工具名 / 参数 / 执行状态 / 耗时 / 结果摘要）。流式时工具卡片
 * 先以"执行中…"出现，结果返回后原地更新；数据来自会话消息的
 * steps 字段（持久化，切换会话后仍可回看）。
 */

import type { AgentStep } from "@/lib/agent/loop";
import { TOOL_DEFINITIONS } from "@/lib/agent/tool-definitions";
import type { ToolResult } from "@/lib/agent/tool-types";

/** 工具卡片的单行结果摘要（读文件/分析/修复等各给一句） */
function resultSummary(result: ToolResult): string {
  const data = result.data as Record<string, unknown> | undefined;
  if (!data) return "";
  switch (result.name) {
    case "readFile":
      return `读取 ${data.lineCount} 行${data.truncated ? "（已截断展示）" : ""}`;
    case "writeFile":
      return `写入 ${data.charCount} 字符 / ${data.lineCount} 行`;
    case "listFiles":
      return `命中 ${Array.isArray(data.files) ? data.files.length : 0} 个文件（共 ${data.total}）`;
    case "runAnalysis":
      return `分析 ${data.totalFiles} 个文件：${data.totalIssues} 个问题（高危 ${data.highSeverity}）`;
    case "applyAutoFix":
      return String(data.message ?? "");
    case "createSnapshot":
      return `快照「${data.name}」已创建`;
    default:
      return "";
  }
}

export default function AgentSteps({ steps }: { steps: AgentStep[] | undefined }) {
  if (!steps || steps.length === 0) return null;

  return (
    <div className="mb-2 space-y-2">
      {steps.map((step) => (
        <div key={step.id} className="rounded border border-slate-800 bg-slate-900/70 text-xs">
          <div className="flex items-center justify-between border-b border-slate-800 px-2 py-1">
            <span className="font-bold text-cyan-400">步骤 {step.index}</span>
            {step.status === "running" && (
              <span className="animate-pulse text-slate-500">思考中…</span>
            )}
          </div>

          {step.text.trim() && (
            <p className="whitespace-pre-wrap break-words px-2 py-1.5 leading-relaxed text-slate-300">
              {step.text.trim()}
            </p>
          )}

          {step.calls.map(({ call, result }) => {
            const def = TOOL_DEFINITIONS[call.name];
            return (
              <div
                key={call.id}
                className="mx-2 mb-2 rounded border border-slate-800 bg-slate-950 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span aria-hidden>🔧</span>
                  <span className="font-semibold text-slate-200">
                    {def?.title ?? call.name}
                  </span>
                  <code className="text-[10px] text-slate-500">{call.name}</code>
                  {def?.mutating && (
                    <span className="rounded bg-yellow-500/20 px-1 text-[10px] text-yellow-400">
                      修改项目
                    </span>
                  )}
                  {result ? (
                    result.ok ? (
                      <span className="text-[10px] text-emerald-400">
                        ✓ {Math.round(result.duration)}ms
                      </span>
                    ) : (
                      <span className="text-[10px] text-rose-400">✗ 失败</span>
                    )
                  ) : (
                    <span className="animate-pulse text-[10px] text-slate-500">执行中…</span>
                  )}
                </div>

                <div className="mt-1 break-all text-[10px] text-slate-500">
                  参数：<code>{JSON.stringify(call.args)}</code>
                </div>
                {result && !result.ok && result.error && (
                  <div className="mt-1 text-[10px] text-rose-300">{result.error}</div>
                )}
                {result?.ok && resultSummary(result) && (
                  <div className="mt-1 text-[10px] text-slate-400">{resultSummary(result)}</div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
