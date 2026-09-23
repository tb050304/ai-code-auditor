"use client";
/**
 * useAgentTools —— Agent 工具桥接层（Day 19）
 *
 * 职责：把 useProject（文件/快照）与 useBatchAnalysis（AST 分析）的宿主能力
 * 适配为 AgentToolContext，交给 lib/agent/tool-executor 的执行器执行。
 *
 * 设计要点：
 * 1. 本 Hook 不含任何工具语义（校验/包装/序列化都在 executor），只做"能力搬运"。
 * 2. Agent 写入文件用 source: "agent" 快照元数据，历史时间线可区分 Agent 改动。
 * 3. applyAutoFix 依赖"最近一次分析结果"；文件没有缓存结果时现场主线程分析兜底，
 *    避免模型没先调 runAnalysis 就拿到"没有可修复问题"的误导性答复。
 * 4. 修复落地后调用 reanalyzeFile 原地刷新结果 Map，问题面板与文件树标注同步更新。
 */

import { useCallback } from "react";
import { useProject } from "@/hooks/useProject";
import { useBatchAnalysis } from "@/hooks/useBatchAnalysis";
import { analyzeFileContent, isAnalyzableFile } from "@/lib/ast/batch-types";
import { isFixable, type IssueFix } from "@/lib/ast/fixer";
import { collectFilePaths } from "@/lib/storage/file-tree";
import {
  collectAnalysisTasks,
  createToolExecutor,
  type AgentToolContext,
  type ToolExecutor,
} from "@/lib/agent/tool-executor";
import type { ToolCall, ToolResult } from "@/lib/agent/tool-types";
import type { Issue } from "@/lib/ast";

export function useAgentTools(): {
  /** 执行一次工具调用（永远 resolve，失败以 ok=false 表达） */
  executeToolCall: ToolExecutor;
  /** 项目内是否没有任何文件（Agent 提示用） */
  isEmptyProject: boolean;
} {
  const {
    fileTree,
    readFile,
    writeFile,
    applyFileAutoFixes,
    createProjectSnapshot,
  } = useProject();
  const { startAnalysis, fileResults, reanalyzeFile } = useBatchAnalysis();

  const listFiles = useCallback(async () => {
    if (!fileTree) throw new Error("无活动项目或项目为空，请先导入项目");
    return collectFilePaths(fileTree);
  }, [fileTree]);

  const runAnalysis = useCallback(
    async (paths?: string[]) => {
      if (!fileTree) throw new Error("无活动项目或项目为空，请先导入项目");
      const targets = paths ?? collectFilePaths(fileTree, isAnalyzableFile);
      const tasks = await collectAnalysisTasks(targets, readFile);
      const result = await startAnalysis(tasks);
      if (!result) throw new Error("分析被取消或失败，请重试");

      const files: Array<{ path: string; issueCount: number; highSeverity: number }> = [];
      for (const r of result.results.values()) {
        if (r.issues.length === 0) continue;
        files.push({
          path: r.path,
          issueCount: r.issues.length,
          highSeverity: r.issues.filter((i) => i.severity === "error").length,
        });
      }
      files.sort((a, b) => b.issueCount - a.issueCount);
      return {
        totalFiles: result.analyzedFiles,
        totalIssues: result.totalIssues,
        highSeverity: result.highSeverity,
        files,
      };
    },
    [fileTree, readFile, startAnalysis],
  );

  const getFixableFixes = useCallback(
    async (path: string): Promise<IssueFix[]> => {
      const cached = fileResults.get(path);
      let issues: Issue[];
      if (cached) {
        issues = cached.issues;
      } else {
        // 没有缓存结果（尚未批量分析过该文件）：现场主线程分析兜底
        try {
          const content = await readFile(path);
          issues = analyzeFileContent(path, content).issues;
        } catch {
          return [];
        }
      }
      return issues.filter(isFixable).map((i) => i.fix as IssueFix);
    },
    [fileResults, readFile],
  );

  const applyAutoFixes = useCallback(
    async (path: string, fixes: IssueFix[]) => {
      const result = await applyFileAutoFixes(path, fixes);
      if (result.changed) {
        // 原地刷新分析结果，问题面板/文件树标注同步
        reanalyzeFile(path, result.after);
      }
      return {
        changed: result.changed,
        applied: result.applied.length,
        skipped: result.skipped.length,
      };
    },
    [applyFileAutoFixes, reanalyzeFile],
  );

  const createSnapshot = useCallback(
    async (name: string, description?: string) => {
      const snapshot = await createProjectSnapshot(name, description);
      return { id: snapshot.id, name: snapshot.name };
    },
    [createProjectSnapshot],
  );

  // 每次调用时用最新回调构造执行器（context 闭包依赖上述 memoized 回调）
  const executeToolCall = useCallback(
    async (call: ToolCall): Promise<ToolResult> => {
      const ctx: AgentToolContext = {
        readFile,
        writeFile: (path, content) =>
          writeFile(path, content, { source: "agent", description: "Agent 写入文件" }),
        listFiles,
        runAnalysis,
        getFixableFixes,
        applyAutoFixes,
        createSnapshot,
      };
      return createToolExecutor(ctx)(call);
    },
    [readFile, writeFile, listFiles, runAnalysis, getFixableFixes, applyAutoFixes, createSnapshot],
  );

  return { executeToolCall, isEmptyProject: !fileTree };
}
