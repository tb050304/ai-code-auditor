/**
 * 审计报告导出（Day 25）
 *
 * 把批量 AST 分析结果渲染为可分享的完整项目审计报告：
 *   - buildReportData：从 fileResults 构建统一报告数据模型（总览/类别/文件明细/失败文件）
 *   - renderMarkdown / renderHtml：两种格式渲染，均为纯函数，不依赖 React / DOM
 *   - downloadReport：浏览器端触发文件下载（Blob + a[download]）
 *
 * 分组口径与问题面板一致：文件分组复用 groupIssuesByFile；
 * 类别按 Issue.type（security / best-practice / performance / maintainability / typescript / react）。
 */

import type { Issue, IssueType } from "./ast";
import type { FileAnalysisResult } from "./ast/batch-types";
import { groupIssuesByFile } from "./ast/issue-aggregate";

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export type ReportFormat = "markdown" | "html";

export interface ReportMeta {
  projectName: string;
  /** ISO 时间字符串 */
  generatedAt: string;
  totalFiles: number;
  analyzedFiles: number;
  failedFiles: number;
  /** 分析耗时（ms） */
  duration: number;
}

export interface SeverityCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

export interface CategoryCounts extends SeverityCounts {
  type: IssueType;
  label: string;
}

export interface ReportFileGroup {
  path: string;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  total: number;
  issues: Issue[];
}

export interface FailedFile {
  path: string;
  error: string;
}

export interface ReportData {
  meta: ReportMeta;
  totals: SeverityCounts;
  byCategory: CategoryCounts[];
  files: ReportFileGroup[];
  failedFiles: FailedFile[];
}

/** 严重程度展示标签 */
export const SEVERITY_LABELS: Record<"error" | "warning" | "info", string> = {
  error: "错误",
  warning: "警告",
  info: "提示",
};

/** 问题类别展示标签（按固定顺序输出，报告结构稳定） */
export const CATEGORY_LABELS: Record<IssueType, string> = {
  security: "安全问题",
  "best-practice": "最佳实践",
  performance: "性能",
  maintainability: "可维护性",
  typescript: "TypeScript",
  react: "React",
};

const CATEGORY_ORDER: IssueType[] = [
  "security",
  "best-practice",
  "performance",
  "maintainability",
  "typescript",
  "react",
];

// ---------------------------------------------------------------------------
// 构建报告数据
// ---------------------------------------------------------------------------

export function buildReportData(
  fileResults: Map<string, FileAnalysisResult>,
  meta: ReportMeta,
): ReportData {
  const grouped = groupIssuesByFile(fileResults);

  const files: ReportFileGroup[] = grouped.map((g) => ({
    path: g.path,
    errorCount: g.summary.errorCount,
    warningCount: g.summary.warningCount,
    infoCount: g.summary.infoCount,
    total: g.summary.total,
    issues: g.issues,
  }));

  const totals: SeverityCounts = { error: 0, warning: 0, info: 0, total: 0 };
  const categoryMap = new Map<IssueType, CategoryCounts>();
  for (const type of CATEGORY_ORDER) {
    categoryMap.set(type, {
      type,
      label: CATEGORY_LABELS[type],
      error: 0,
      warning: 0,
      info: 0,
      total: 0,
    });
  }

  for (const group of files) {
    totals.error += group.errorCount;
    totals.warning += group.warningCount;
    totals.info += group.infoCount;
    for (const issue of group.issues) {
      const cat = categoryMap.get(issue.type);
      if (cat) {
        cat[issue.severity]++;
        cat.total++;
      }
    }
  }
  totals.total = totals.error + totals.warning + totals.info;

  const byCategory = [...categoryMap.values()].filter((c) => c.total > 0);

  const failedFiles: FailedFile[] = [];
  for (const [path, result] of fileResults.entries()) {
    if (!result.success && result.error) {
      failedFiles.push({ path, error: result.error });
    }
  }
  failedFiles.sort((a, b) => a.path.localeCompare(b.path));

  return { meta, totals, byCategory, files, failedFiles };
}

// ---------------------------------------------------------------------------
// 通用格式化
// ---------------------------------------------------------------------------

/** 毫秒耗时转人类可读 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** ISO 时间 → 本地可读时间（YYYY-MM-DD HH:mm:ss） */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Markdown 表格单元格转义（管道符 + 换行） */
function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// ---------------------------------------------------------------------------
// Markdown 渲染
// ---------------------------------------------------------------------------

export function renderMarkdown(data: ReportData): string {
  const { meta, totals, byCategory, files, failedFiles } = data;
  const lines: string[] = [];

  lines.push(`# 代码审计报告 — ${meta.projectName}`);
  lines.push("");
  lines.push(`- 生成时间：${formatTimestamp(meta.generatedAt)}`);
  lines.push(
    `- 分析文件：${meta.totalFiles} 个（成功 ${meta.analyzedFiles} / 失败 ${meta.failedFiles}），耗时 ${formatDuration(meta.duration)}`,
  );
  lines.push(
    `- 问题总计：**${totals.total}** 个（错误 ${totals.error} / 警告 ${totals.warning} / 提示 ${totals.info}）`,
  );
  lines.push("");

  // 总览
  lines.push("## 一、总览");
  lines.push("");
  lines.push("| 严重程度 | 数量 |");
  lines.push("| --- | ---: |");
  lines.push(`| 错误（error） | ${totals.error} |`);
  lines.push(`| 警告（warning） | ${totals.warning} |`);
  lines.push(`| 提示（info） | ${totals.info} |`);
  lines.push(`| **合计** | **${totals.total}** |`);
  lines.push("");
  lines.push(verdictMarkdown(totals));
  lines.push("");

  // 按类别
  lines.push("## 二、按类别统计");
  lines.push("");
  if (byCategory.length === 0) {
    lines.push("未发现任何问题。");
    lines.push("");
  } else {
    lines.push("| 类别 | 错误 | 警告 | 提示 | 合计 |");
    lines.push("| --- | ---: | ---: | ---: | ---: |");
    for (const c of byCategory) {
      lines.push(
        `| ${c.label} | ${c.error} | ${c.warning} | ${c.info} | ${c.total} |`,
      );
    }
    lines.push("");
  }

  // 按文件明细
  lines.push("## 三、问题明细（按文件）");
  lines.push("");
  if (files.length === 0) {
    lines.push("所有已分析文件均未发现问题。");
    lines.push("");
  } else {
    files.forEach((group, idx) => {
      lines.push(
        `### ${idx + 1}. \`${group.path.slice(1)}\`（${group.total} 个：错误 ${group.errorCount} / 警告 ${group.warningCount} / 提示 ${group.infoCount}）`,
      );
      lines.push("");
      group.issues.forEach((issue, i) => {
        lines.push(
          `${i + 1}. **[${SEVERITY_LABELS[issue.severity]} · ${CATEGORY_LABELS[issue.type]}] L${issue.startLine} ${mdCell(issue.name)}**`,
        );
        lines.push(`   - ${mdCell(issue.message)}`);
        if (issue.suggestion) {
          lines.push(`   - 建议：${mdCell(issue.suggestion)}`);
        }
      });
      lines.push("");
    });
  }

  // 分析失败的文件
  if (failedFiles.length > 0) {
    lines.push("## 四、分析失败的文件");
    lines.push("");
    for (const f of failedFiles) {
      lines.push(`- \`${f.path.slice(1)}\`：${mdCell(f.error)}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`*本报告由 AI Code Auditor 于 ${formatTimestamp(meta.generatedAt)} 自动生成。*`);

  return lines.join("\n");
}

function verdictMarkdown(totals: SeverityCounts): string {
  if (totals.error > 0) {
    return `> ⚠️ 发现 **${totals.error}** 个错误级问题，建议优先修复后再合入。`;
  }
  if (totals.warning > 0) {
    return "> ℹ️ 没有错误级问题，但存在警告级问题，建议安排时间处理。";
  }
  return "> ✅ 未发现错误或警告级问题。";
}

// ---------------------------------------------------------------------------
// HTML 渲染（浅色打印友好风格，样式全部内联，可直接用浏览器打开/打印为 PDF）
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SEVERITY_HTML_COLORS: Record<"error" | "warning" | "info", string> = {
  error: "#dc2626",
  warning: "#d97706",
  info: "#2563eb",
};

export function renderHtml(data: ReportData): string {
  const { meta, totals, byCategory, files, failedFiles } = data;

  const categoryRows =
    byCategory.length === 0
      ? `<tr><td colspan="5" style="color:#64748b">未发现任何问题</td></tr>`
      : byCategory
          .map(
            (c) =>
              `<tr><td>${escapeHtml(c.label)}</td><td>${c.error}</td><td>${c.warning}</td><td>${c.info}</td><td><strong>${c.total}</strong></td></tr>`,
          )
          .join("");

  const fileSections =
    files.length === 0
      ? `<p style="color:#64748b">所有已分析文件均未发现问题。</p>`
      : files
          .map((group, idx) => {
            const rows = group.issues
              .map((issue) => {
                const color = SEVERITY_HTML_COLORS[issue.severity];
                const suggestion = issue.suggestion
                  ? `<div style="color:#475569;margin-top:4px">建议：${escapeHtml(issue.suggestion)}</div>`
                  : "";
                return `<tr>
                  <td style="white-space:nowrap;color:${color};font-weight:600">[${SEVERITY_LABELS[issue.severity]}]</td>
                  <td style="white-space:nowrap;color:#64748b">L${issue.startLine}</td>
                  <td>
                    <div style="font-weight:600">${escapeHtml(issue.name)} <span style="color:#94a3b8;font-weight:400">· ${escapeHtml(CATEGORY_LABELS[issue.type])}</span></div>
                    <div style="color:#334155;margin-top:2px">${escapeHtml(issue.message)}</div>
                    ${suggestion}
                  </td>
                </tr>`;
              })
              .join("");
            return `<section class="file">
              <h3>${idx + 1}. ${escapeHtml(group.path.slice(1))}
                <span class="file-count">（${group.total} 个：错误 ${group.errorCount} / 警告 ${group.warningCount} / 提示 ${group.infoCount}）</span>
              </h3>
              <table><tbody>${rows}</tbody></table>
            </section>`;
          })
          .join("");

  const failedSection =
    failedFiles.length === 0
      ? ""
      : `<h2>四、分析失败的文件</h2><ul>${failedFiles
          .map((f) => `<li><code>${escapeHtml(f.path.slice(1))}</code>：${escapeHtml(f.error)}</li>`)
          .join("")}</ul>`;

  const verdict =
    totals.error > 0
      ? `<div class="verdict" style="background:#fef2f2;color:#b91c1c">发现 <strong>${totals.error}</strong> 个错误级问题，建议优先修复后再合入。</div>`
      : totals.warning > 0
        ? `<div class="verdict" style="background:#fffbeb;color:#b45309">没有错误级问题，但存在 ${totals.warning} 个警告级问题，建议安排时间处理。</div>`
        : `<div class="verdict" style="background:#f0fdf4;color:#15803d">未发现错误或警告级问题。</div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>代码审计报告 — ${escapeHtml(meta.projectName)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: #f8fafc; color: #1e293b; line-height: 1.6; }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  h2 { font-size: 18px; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #e2e8f0; }
  h3 { font-size: 14px; margin: 20px 0 8px; }
  .meta { color: #64748b; font-size: 13px; margin-bottom: 20px; }
  .verdict { padding: 12px 16px; border-radius: 8px; font-size: 14px; margin: 12px 0; }
  .cards { display: flex; gap: 12px; margin: 16px 0; }
  .card { flex: 1; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center; }
  .card .num { font-size: 28px; font-weight: 700; }
  .card .label { font-size: 12px; color: #64748b; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; }
  td:not(:last-child) { padding-right: 16px; }
  section.file table { margin-bottom: 8px; }
  .file-count { font-size: 12px; color: #64748b; font-weight: 400; }
  code { background: #f1f5f9; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  ul { font-size: 13px; }
  .footer { margin-top: 40px; color: #94a3b8; font-size: 12px; text-align: center; }
  @media print { body { background: #fff; } .container { padding: 0; } }
</style>
</head>
<body>
<div class="container">
  <h1>代码审计报告 — ${escapeHtml(meta.projectName)}</h1>
  <div class="meta">
    生成时间：${escapeHtml(formatTimestamp(meta.generatedAt))} ·
    分析文件 ${meta.totalFiles} 个（成功 ${meta.analyzedFiles} / 失败 ${meta.failedFiles}）·
    耗时 ${formatDuration(meta.duration)}
  </div>

  <h2>一、总览</h2>
  <div class="cards">
    <div class="card"><div class="num" style="color:#dc2626">${totals.error}</div><div class="label">错误</div></div>
    <div class="card"><div class="num" style="color:#d97706">${totals.warning}</div><div class="label">警告</div></div>
    <div class="card"><div class="num" style="color:#2563eb">${totals.info}</div><div class="label">提示</div></div>
    <div class="card"><div class="num">${totals.total}</div><div class="label">合计</div></div>
  </div>
  ${verdict}

  <h2>二、按类别统计</h2>
  <table>
    <thead><tr><th>类别</th><th>错误</th><th>警告</th><th>提示</th><th>合计</th></tr></thead>
    <tbody>${categoryRows}</tbody>
  </table>

  <h2>三、问题明细（按文件）</h2>
  ${fileSections}

  ${failedSection}

  <div class="footer">本报告由 AI Code Auditor 于 ${escapeHtml(formatTimestamp(meta.generatedAt))} 自动生成。</div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 浏览器下载
// ---------------------------------------------------------------------------

/** 报告文件扩展名 */
export const REPORT_EXTENSIONS: Record<ReportFormat, string> = {
  markdown: "md",
  html: "html",
};

/** 报告 MIME 类型 */
export const REPORT_MIME_TYPES: Record<ReportFormat, string> = {
  markdown: "text/markdown;charset=utf-8",
  html: "text/html;charset=utf-8",
};

/** 生成带时间戳的报告文件名，如 audit-report-myproj-20261007-153012.md */
export function buildReportFileName(projectName: string, format: ReportFormat, at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const safeName = projectName.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return `audit-report-${safeName}-${stamp}.${REPORT_EXTENSIONS[format]}`;
}

/**
 * 触发浏览器下载文本文件。
 * 注意：依赖 DOM（Blob / URL.createObjectURL），只能在浏览器事件中调用。
 */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 延迟回收，确保下载已开始
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 一键导出：构建文件名并下载 */
export function downloadReport(
  data: ReportData,
  format: ReportFormat,
): void {
  const content = format === "markdown" ? renderMarkdown(data) : renderHtml(data);
  const filename = buildReportFileName(data.meta.projectName, format, new Date(data.meta.generatedAt));
  downloadTextFile(filename, content, REPORT_MIME_TYPES[format]);
}
