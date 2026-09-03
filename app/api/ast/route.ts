/**
 * AST 静态分析 API
 * 
 * 提供基于 AST 的代码静态分析功能
 */

import { NextResponse } from "next/server";
import { analyzeCode, generateReport, Issue } from "@/lib/ast";

export async function POST(req: Request) {
  try {
    const { code, filename = "code.js" } = await req.json();

    if (!code || typeof code !== "string") {
      return NextResponse.json(
        { error: "代码不能为空" },
        { status: 400 }
      );
    }

    // 执行 AST 分析
    const result = analyzeCode(code, filename);

    // 生成 Markdown 报告
    const report = generateReport(result);

    return NextResponse.json({
      success: true,
      result,
      report,
      // 返回用于高亮的 issues 列表
      issues: result.issues.map((issue: Issue) => ({
        id: issue.id,
        type: issue.type,
        severity: issue.severity,
        message: issue.message,
        startLine: issue.startLine,
        startColumn: issue.startColumn,
        endLine: issue.endLine,
        endColumn: issue.endColumn,
        suggestion: issue.suggestion,
      })),
    });
  } catch (error: unknown) {
    console.error("AST analysis error:", error);
    const message = error instanceof Error && error.message ? error.message : "分析失败";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

/**
 * GET 请求返回支持的规则列表
 */
export async function GET() {
  return NextResponse.json({
    rules: [
      // 安全类
      { id: "no-eval", name: "避免使用 eval", severity: "error", type: "security" },
      { id: "no-new-function", name: "避免使用 new Function", severity: "error", type: "security" },
      { id: "no-inner-html", name: "避免直接设置 innerHTML", severity: "warning", type: "security" },
      { id: "no-hardcoded-secret", name: "硬编码密钥/密码", severity: "error", type: "security" },
      { id: "no-sql-injection", name: "SQL 注入风险", severity: "error", type: "security" },
      { id: "no-command-injection", name: "命令注入风险", severity: "error", type: "security" },
      { id: "no-insecure-random", name: "不安全的随机数", severity: "warning", type: "security" },
      // React 类
      { id: "react-no-missing-key", name: "React 缺少 key prop", severity: "warning", type: "react" },
      { id: "react-no-inline-function", name: "内联函数作为 props", severity: "info", type: "react" },
      // 可维护性
      { id: "no-console-log", name: "移除 console.log", severity: "info", type: "maintainability" },
      { id: "no-debugger", name: "移除 debugger", severity: "warning", type: "maintainability" },
      { id: "no-long-function", name: "过长的函数", severity: "warning", type: "maintainability" },
      // 最佳实践
      { id: "no-var", name: "使用 let/const 代替 var", severity: "info", type: "best-practice" },
      { id: "eqeqeq", name: "使用严格相等", severity: "warning", type: "best-practice" },
      { id: "no-magic-number", name: "魔法数字", severity: "info", type: "best-practice" },
    ],
  });
}
