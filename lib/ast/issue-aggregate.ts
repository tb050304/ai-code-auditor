/**
 * 文件树问题聚合工具
 *
 * 根据批量分析结果，计算每个文件/目录的问题状态：
 * - 文件：直接读取分析结果中的最高严重程度
 * - 目录：递归聚合所有子节点的最严重状态
 *
 * 严重程度排序：error > warning > info > none
 */

import type { TreeNode } from "../storage/file-tree";
import type { FileAnalysisResult } from "./batch-types";
import type { Issue } from "../ast";

/** 节点问题严重程度 */
export type IssueSeverityLevel = "error" | "warning" | "info" | "none";

/** 单节点问题摘要 */
export interface NodeIssueSummary {
  /** 最高严重程度 */
  level: IssueSeverityLevel;
  /** error 数量 */
  errorCount: number;
  /** warning 数量 */
  warningCount: number;
  /** info 数量 */
  infoCount: number;
  /** 总问题数 */
  total: number;
}

const SEVERITY_RANK: Record<IssueSeverityLevel, number> = {
  error: 3,
  warning: 2,
  info: 1,
  none: 0,
};

function maxSeverity(a: IssueSeverityLevel, b: IssueSeverityLevel): IssueSeverityLevel {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

const EMPTY_SUMMARY: NodeIssueSummary = {
  level: "none",
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
  total: 0,
};

/** 根据问题列表计算单文件摘要 */
export function summarizeIssues(issues: Issue[]): NodeIssueSummary {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const issue of issues) {
    if (issue.severity === "error") errorCount++;
    else if (issue.severity === "warning") warningCount++;
    else infoCount++;
  }

  const total = errorCount + warningCount + infoCount;
  let level: IssueSeverityLevel = "none";
  if (errorCount > 0) level = "error";
  else if (warningCount > 0) level = "warning";
  else if (infoCount > 0) level = "info";

  return { level, errorCount, warningCount, infoCount, total };
}

/**
 * 构建文件树 -> 问题摘要的映射
 * 目录节点递归聚合并包含子级所有问题数
 *
 * @param root 文件树根节点
 * @param fileResults 批量分析结果（按文件路径索引）
 * @returns Map<path, NodeIssueSummary>
 */
export function buildTreeIssueMap(
  root: TreeNode,
  fileResults: Map<string, FileAnalysisResult>,
): Map<string, NodeIssueSummary> {
  const map = new Map<string, NodeIssueSummary>();

  function walk(node: TreeNode): NodeIssueSummary {
    if (node.type === "file") {
      const result = fileResults.get(node.path);
      const summary = result ? summarizeIssues(result.issues) : EMPTY_SUMMARY;
      map.set(node.path, summary);
      return summary;
    }

    // 目录：聚合所有子节点
    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    let level: IssueSeverityLevel = "none";

    if (node.children) {
      for (const child of node.children) {
        const childSummary = walk(child);
        errorCount += childSummary.errorCount;
        warningCount += childSummary.warningCount;
        infoCount += childSummary.infoCount;
        level = maxSeverity(level, childSummary.level);
      }
    }

    const total = errorCount + warningCount + infoCount;
    const summary: NodeIssueSummary = { level, errorCount, warningCount, infoCount, total };
    map.set(node.path, summary);
    return summary;
  }

  walk(root);
  return map;
}

/**
 * 获取按严重程度和类型分组的所有问题列表（用于问题面板）
 * 按文件路径分组，每组内按严重程度排序
 */
export function groupIssuesByFile(
  fileResults: Map<string, FileAnalysisResult>,
): Array<{ path: string; summary: NodeIssueSummary; issues: Issue[] }> {
  const groups: Array<{ path: string; summary: NodeIssueSummary; issues: Issue[] }> = [];

  for (const [path, result] of fileResults.entries()) {
    if (!result.success || result.issues.length === 0) continue;
    const summary = summarizeIssues(result.issues);

    // 按严重程度排序：error 在前，然后 warning，然后 info
    const sorted = [...result.issues].sort((a, b) => {
      const rank = (s: string) => (s === "error" ? 3 : s === "warning" ? 2 : 1);
      const diff = rank(b.severity) - rank(a.severity);
      if (diff !== 0) return diff;
      return a.startLine - b.startLine;
    });

    groups.push({ path, summary, issues: sorted });
  }

  // 按最高严重程度排序组：error 最多的在前
  groups.sort((a, b) => {
    const rank = (s: IssueSeverityLevel) => SEVERITY_RANK[s];
    const diff = rank(b.summary.level) - rank(a.summary.level);
    if (diff !== 0) return diff;
    return b.summary.total - a.summary.total;
  });

  return groups;
}
