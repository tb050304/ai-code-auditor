/**
 * AST 解析与静态分析模块
 * 
 * 功能：
 * 1. 解析 JavaScript/TypeScript 代码为 AST
 * 2. 静态分析检测常见漏洞模式
 * 3. 提供代码高亮位置信息
 */

import * as parser from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";

/**
 * 漏洞/问题信息
 */
export interface Issue {
  /** 问题 ID */
  id: string;
  /** 问题名称 */
  name: string;
  /** 问题类型 */
  type: IssueType;
  /** 严重程度 */
  severity: "error" | "warning" | "info";
  /** 描述 */
  message: string;
  /** 代码片段 */
  codeSnippet?: string;
  /** 开始行号 (1-based) */
  startLine: number;
  /** 开始列号 (1-based) */
  startColumn: number;
  /** 结束行号 (1-based) */
  endLine: number;
  /** 结束列号 (1-based) */
  endColumn: number;
  /** 建议修复方案 */
  suggestion?: string;
}

/**
 * 问题类型枚举
 */
export type IssueType = 
  | "security"
  | "best-practice"
  | "performance"
  | "maintainability"
  | "typescript"
  | "react";

/**
 * 解析结果
 */
export interface ParseResult {
  /** 是否解析成功 */
  success: boolean;
  /** AST（如果解析成功）*/
  ast?: t.File;
  /** 错误信息（如果解析失败）*/
  error?: string;
  /** 代码行数 */
  lineCount: number;
}

/**
 * 分析结果
 */
export interface AnalysisResult {
  /** 文件名 */
  filename: string;
  /** 检测到的问题列表 */
  issues: Issue[];
  /** 总问题数 */
  totalIssues: number;
  /** 高危问题数 */
  highSeverity: number;
  /** 解析结果 */
  parseResult: ParseResult;
  /** 分析耗时 (ms) */
  duration: number;
}

/**
 * 解析代码为 AST
 */
export function parseCode(code: string, sourceType: "module" | "script" = "module"): ParseResult {
  try {
    const ast = parser.parse(code, {
      sourceType,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      errorRecovery: true,
      plugins: ["jsx", "typescript"],
    });

    const lineCount = code.split("\n").length;

    return {
      success: true,
      ast,
      lineCount,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "解析失败",
      lineCount: code.split("\n").length,
    };
  }
}

/**
 * 获取节点的位置信息
 */
function getNodeLocation(node: t.Node): { startLine: number; startColumn: number; endLine: number; endColumn: number } {
  const loc = node.loc;
  if (loc) {
    return {
      startLine: loc.start.line,
      startColumn: loc.start.column + 1,
      endLine: loc.end.line,
      endColumn: loc.end.column + 1,
    };
  }
  return {
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

/**
 * 生成代码片段
 */
function getCodeSnippet(code: string, startLine: number, endLine: number): string {
  const lines = code.split("\n");
  return lines.slice(startLine - 1, endLine).join("\n");
}

// ==================== 静态分析规则 ====================

interface Rule {
  id: string;
  name: string;
  type: IssueType;
  severity: "error" | "warning" | "info";
  description: string;
  suggestion: string;
  check: (path: NodePath<any>, code: string) => Issue | null;
}

/**
 * 规则1: 检测 eval() 使用
 */
const ruleNoEval: Rule = {
  id: "no-eval",
  name: "避免使用 eval",
  type: "security",
  severity: "error",
  description: "eval() 可以执行任意代码，是潜在的安全风险",
  suggestion: "考虑使用其他方式实现相同功能，如 JSON.parse() 解析数据",
  check: (path) => {
    if (t.isCallExpression(path.node) && 
        t.isIdentifier(path.node.callee) && 
        path.node.callee.name === "eval") {
      const loc = getNodeLocation(path.node);
      return {
        id: "no-eval",
        name: "避免使用 eval",
        type: "security",
        severity: "error",
        message: "检测到 eval() 使用：eval() 可以执行任意代码，存在安全风险",
        codeSnippet: getCodeSnippet("", loc.startLine, loc.endLine),
        startLine: loc.startLine,
        startColumn: loc.startColumn,
        endLine: loc.endLine,
        endColumn: loc.endColumn,
        suggestion: "考虑使用 JSON.parse() 或其他安全的方式",
      };
    }
    return null;
  },
};

/**
 * 规则2: 检测 new Function()
 */
const ruleNoNewFunction: Rule = {
  id: "no-new-function",
  name: "避免使用 new Function",
  type: "security",
  severity: "error",
  description: "new Function() 类似于 eval()，存在安全风险",
  suggestion: "考虑重构代码避免动态代码生成",
  check: (path) => {
    if (t.isNewExpression(path.node) &&
        t.isIdentifier(path.node.callee) &&
        path.node.callee.name === "Function") {
      const loc = getNodeLocation(path.node);
      return {
        id: "no-new-function",
        name: "避免使用 new Function",
        type: "security",
        severity: "error",
        message: "检测到 new Function() 使用：动态创建函数存在安全风险",
        startLine: loc.startLine,
        startColumn: loc.startColumn,
        endLine: loc.endLine,
        endColumn: loc.endColumn,
        suggestion: "考虑重构代码避免动态代码生成",
      };
    }
    return null;
  },
};

/**
 * 规则3: 检测 innerHTML 设置
 */
const ruleNoInnerHTML: Rule = {
  id: "no-inner-html",
  name: "避免直接设置 innerHTML",
  type: "security",
  severity: "warning",
  description: "直接设置 innerHTML 可能导致 XSS 攻击",
  suggestion: "使用 textContent 或使用 DOMPurify 净化内容",
  check: (path) => {
    if (t.isAssignmentExpression(path.node) &&
        t.isMemberExpression(path.node.left) &&
        t.isIdentifier((path.node.left as t.MemberExpression).property, { name: "innerHTML" })) {
      const loc = getNodeLocation(path.node);
      return {
        id: "no-inner-html",
        name: "避免直接设置 innerHTML",
        type: "security",
        severity: "warning",
        message: "检测到 innerHTML 直接赋值：可能导致 XSS 攻击",
        startLine: loc.startLine,
        startColumn: loc.startColumn,
        endLine: loc.endLine,
        endColumn: loc.endColumn,
        suggestion: "使用 textContent 代替，或使用 DOMPurify 净化内容",
      };
    }
    return null;
  },
};

/**
 * 规则4: 检测 console.log 遗留
 */
const ruleNoConsoleLog: Rule = {
  id: "no-console-log",
  name: "移除 console.log",
  type: "maintainability",
  severity: "info",
  description: "生产代码中不应保留 console.log",
  suggestion: "移除 console.log 或使用专业的日志库",
  check: (path) => {
    if (t.isCallExpression(path.node) &&
        t.isMemberExpression(path.node.callee) &&
        t.isIdentifier((path.node.callee as t.MemberExpression).object, { name: "console" }) &&
        t.isIdentifier((path.node.callee as t.MemberExpression).property, { name: "log" })) {
      const loc = getNodeLocation(path.node);
      return {
        id: "no-console-log",
        name: "移除 console.log",
        type: "maintainability",
        severity: "info",
        message: "检测到 console.log：生产代码中应移除调试日志",
        startLine: loc.startLine,
        startColumn: loc.startColumn,
        endLine: loc.endLine,
        endColumn: loc.endColumn,
        suggestion: "移除 console.log 或使用专业的日志库",
      };
    }
    return null;
  },
};

/**
 * 规则5: 检测 debugger 断点
 */
const ruleNoDebugger: Rule = {
  id: "no-debugger",
  name: "移除 debugger",
  type: "maintainability",
  severity: "warning",
  description: "debugger 语句会阻塞执行",
  suggestion: "移除 debugger 语句",
  check: (path) => {
    if (t.isDebuggerStatement(path.node)) {
      const loc = getNodeLocation(path.node);
      return {
        id: "no-debugger",
        name: "移除 debugger",
        type: "maintainability",
        severity: "warning",
        message: "检测到 debugger 语句：会导致程序暂停",
        startLine: loc.startLine,
        startColumn: loc.startColumn,
        endLine: loc.endLine,
        endColumn: loc.endColumn,
        suggestion: "移除 debugger 语句",
      };
    }
    return null;
  },
};

/**
 * 规则6: 检测 var 声明
 */
const ruleNoVar: Rule = {
  id: "no-var",
  name: "使用 let/const 代替 var",
  type: "best-practice",
  severity: "info",
  description: "var 具有函数作用域而非块级作用域，可能导致意外行为",
  suggestion: "使用 let 或 const 声明变量",
  check: (path) => {
    if (t.isVariableDeclaration(path.node) && path.node.kind === "var") {
      const loc = getNodeLocation(path.node);
      return {
        id: "no-var",
        name: "使用 let/const 代替 var",
        type: "best-practice",
        severity: "info",
        message: "检测到 var 声明：建议使用 let 或 const 代替",
        startLine: loc.startLine,
        startColumn: loc.startColumn,
        endLine: loc.endLine,
        endColumn: loc.endColumn,
        suggestion: "将 var 改为 let 或 const",
      };
    }
    return null;
  },
};

/**
 * 规则7: 检测 == 而非 ===
 */
const ruleNoDoubleEquals: Rule = {
  id: "eqeqeq",
  name: "使用严格相等",
  type: "best-practice",
  severity: "warning",
  description: "== 会进行类型转换，可能导致意外比较结果",
  suggestion: "使用 === 或 !== 进行比较",
  check: (path) => {
    if (t.isBinaryExpression(path.node) &&
        (path.node.operator === "==" || path.node.operator === "!=")) {
      const loc = getNodeLocation(path.node);
      return {
        id: "eqeqeq",
        name: "使用严格相等",
        type: "best-practice",
        severity: "warning",
        message: `检测到 ${path.node.operator} 使用：建议使用 ${path.node.operator}=== || ${path.node.operator}!==`,
        startLine: loc.startLine,
        startColumn: loc.startColumn,
        endLine: loc.endLine,
        endColumn: loc.endColumn,
        suggestion: "使用严格相等进行比较",
      };
    }
    return null;
  },
};

/**
 * 规则8: 检测硬编码密钥/密码
 */
const ruleNoHardcodedSecret: Rule = {
  id: "no-hardcoded-secret",
  name: "硬编码密钥/密码",
  type: "security",
  severity: "error",
  description: "代码中包含硬编码的密钥、密码或 API Key，存在安全风险",
  suggestion: "使用环境变量或密钥管理服务存储敏感信息",
  check: (path) => {
    if (t.isVariableDeclarator(path.node) && t.isIdentifier(path.node.id)) {
      const varName = path.node.id.name.toLowerCase();
      const hasSecretPattern = 
        /password|passwd|pwd|secret|api_key|apikey|token|auth|bearer|credential|private_key|privatekey/i.test(varName);
      
      if (hasSecretPattern && path.node.init && t.isStringLiteral(path.node.init)) {
        const loc = getNodeLocation(path.node);
        return {
          id: "no-hardcoded-secret",
          name: "硬编码密钥/密码",
          type: "security",
          severity: "error",
          message: `检测到硬编码的敏感信息变量：${varName}`,
          startLine: loc.startLine,
          startColumn: loc.startColumn,
          endLine: loc.endLine,
          endColumn: loc.endColumn,
          suggestion: "使用环境变量 process.env.XXX 代替",
        };
      }
    }
    return null;
  },
};

/**
 * 规则9: 检测 SQL 注入风险
 */
const ruleNoSQLInjection: Rule = {
  id: "no-sql-injection",
  name: "SQL 注入风险",
  type: "security",
  severity: "error",
  description: "使用字符串拼接方式构建 SQL 查询，容易被 SQL 注入攻击",
  suggestion: "使用参数化查询或 ORM",
  check: (path, code) => {
    // 检测字符串拼接（operator 是 +）
    if (t.isBinaryExpression(path.node) && path.node.operator === "+") {
      // 获取代码片段进行检查
      const loc = getNodeLocation(path.node);
      const codeSnippet = getCodeSnippet(code, loc.startLine, loc.endLine);
      // 检查是否包含 SQL 关键词
      if (/sql|query|select|insert|update|delete|from|where/i.test(codeSnippet)) {
        return {
          id: "no-sql-injection",
          name: "SQL 注入风险",
          type: "security",
          severity: "error",
          message: "检测到可能的 SQL 注入风险：使用字符串拼接构建 SQL 查询",
          startLine: loc.startLine,
          startColumn: loc.startColumn,
          endLine: loc.endLine,
          endColumn: loc.endColumn,
          suggestion: "使用参数化查询（Prepared Statements）或 ORM 框架",
        };
      }
    }
    return null;
  },
};

/**
 * 规则10: 检测命令注入风险
 */
const ruleNoCommandInjection: Rule = {
  id: "no-command-injection",
  name: "命令注入风险",
  type: "security",
  severity: "error",
  description: "使用用户输入执行系统命令，可能导致命令注入攻击",
  suggestion: "避免使用 exec/execSync/spawn 等执行用户输入",
  check: (path) => {
    if (t.isCallExpression(path.node) && t.isMemberExpression(path.node.callee)) {
      const callee = path.node.callee;
      if (t.isIdentifier(callee.object) && t.isIdentifier(callee.property)) {
        const obj = callee.object.name;
        const method = callee.property.name;
        
        // 检测 child_process 的危险方法
        if ((obj === "child_process" || obj === "require") && 
            /exec|execSync|spawn|spawnSync|execFile|execFileSync/i.test(method)) {
          const loc = getNodeLocation(path.node);
          return {
            id: "no-command-injection",
            name: "命令注入风险",
            type: "security",
            severity: "error",
            message: "检测到可能的命令注入风险：使用 exec 类方法执行系统命令",
            startLine: loc.startLine,
            startColumn: loc.startColumn,
            endLine: loc.endLine,
            endColumn: loc.endColumn,
            suggestion: "避免执行用户输入，或对输入进行严格验证",
          };
        }
      }
    }
    return null;
  },
};

/**
 * 规则11: 检测不安全的随机数
 */
const ruleNoInsecureRandom: Rule = {
  id: "no-insecure-random",
  name: "不安全的随机数",
  type: "security",
  severity: "warning",
  description: "Math.random() 不是密码学安全的随机数生成器",
  suggestion: "使用 crypto.getRandomValues() 或 crypto.randomBytes() 代替",
  check: (path) => {
    if (t.isCallExpression(path.node) &&
        t.isMemberExpression(path.node.callee) &&
        t.isIdentifier(path.node.callee.object, { name: "Math" }) &&
        t.isIdentifier(path.node.callee.property, { name: "random" })) {
      const loc = getNodeLocation(path.node);
      return {
        id: "no-insecure-random",
        name: "不安全的随机数",
        type: "security",
        severity: "warning",
        message: "检测到 Math.random() 使用：这不是密码学安全的随机数",
        startLine: loc.startLine,
        startColumn: loc.startColumn,
        endLine: loc.endLine,
        endColumn: loc.endColumn,
        suggestion: "使用 crypto.getRandomValues() 代替 Math.random()",
      };
    }
    return null;
  },
};

/**
 * 规则12: React 缺少 key prop
 */
const ruleNoMissingKey: Rule = {
  id: "react-no-missing-key",
  name: "React 缺少 key prop",
  type: "react",
  severity: "warning",
  description: "在 map/render 中渲染数组元素时需要唯一的 key prop",
  suggestion: "为数组元素添加唯一且稳定的 key prop",
  check: (path) => {
    // 检测 JSX Element
    if (t.isJSXElement(path.node)) {
      // 获取 JSX 属性列表
      const attributes = path.node.openingElement.attributes;
      const hasKey = attributes.some(attr => 
        t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name, { name: "key" })
      );
      
      if (!hasKey) {
        // 检查 JSX 元素的父级是否是 ArrowFunctionExpression，
        // 并且该 ArrowFunctionExpression 是 CallExpression 的参数（map 调用）
        const parent = path.parent;
        if (t.isArrowFunctionExpression(parent) || t.isFunctionExpression(parent)) {
          const grandParent = path.parentPath?.parent;
          if (t.isCallExpression(grandParent)) {
            const callee = grandParent.callee;
            if (t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: "map" })) {
              const loc = getNodeLocation(path.node);
              return {
                id: "react-no-missing-key",
                name: "React 缺少 key prop",
                type: "react",
                severity: "warning",
                message: "检测到 map 渲染的 JSX 元素缺少 key prop",
                startLine: loc.startLine,
                startColumn: loc.startColumn,
                endLine: loc.endLine,
                endColumn: loc.endColumn,
                suggestion: "添加 key={item.id} 或 key={index}（尽量使用唯一 ID）",
              };
            }
          }
        }
      }
    }
    return null;
  },
};

/**
 * 规则13: React 内联函数作为 props
 */
const ruleNoInlineFunction: Rule = {
  id: "react-no-inline-function",
  name: "内联函数作为 props",
  type: "react",
  severity: "info",
  description: "在 render 中内联定义函数会导致子组件不必要的重渲染",
  suggestion: "使用 useCallback 包裹内联函数，或将函数定义移到组件外部",
  check: (path) => {
    if (t.isArrowFunctionExpression(path.node) || t.isFunctionExpression(path.node)) {
      const parent = path.parent;
      // JSX 属性值通常包裹在 JSXExpressionContainer 中
      const isInJSXAttr =
        (parent && t.isJSXAttribute(parent)) ||
        (parent && t.isJSXExpressionContainer(parent) && t.isJSXAttribute(path.parentPath?.parent));
      if (isInJSXAttr) {
        const loc = getNodeLocation(path.node);
        return {
          id: "react-no-inline-function",
          name: "内联函数作为 props",
          type: "react",
          severity: "info",
          message: "检测到内联函数作为 JSX 属性，可能导致性能问题",
          startLine: loc.startLine,
          startColumn: loc.startColumn,
          endLine: loc.endLine,
          endColumn: loc.endColumn,
          suggestion: "使用 useCallback 包裹，或将函数提取为组件方法",
        };
      }
    }
    return null;
  },
};

/**
 * 规则14: 检测魔法数字
 */
const ruleNoMagicNumber: Rule = {
  id: "no-magic-number",
  name: "魔法数字",
  type: "best-practice",
  severity: "info",
  description: "代码中包含未命名的数字常量（魔法数字），影响可读性和维护性",
  suggestion: "将数字定义为有意义的常量",
  check: (path) => {
    // 检测在二元比较或赋值中使用的数字字面量
    if (t.isNumericLiteral(path.node)) {
      const parentNode = path.parent;
      // 检查是否在比较操作或赋值中使用（排除索引使用）
      if (parentNode && (
        (t.isBinaryExpression(parentNode) && parentNode.operator !== "+" && parentNode.operator !== "-") ||
        (t.isAssignmentExpression(parentNode) && !t.isArrayExpression(path.parentPath?.parent as any))
      )) {
        const value = path.node.value;
        // 排除 0, 1, -1 等常见值，以及小数
        if (![0, 1, -1, 0.1, 0.5].includes(value) && value > 1) {
          const loc = getNodeLocation(path.node);
          return {
            id: "no-magic-number",
            name: "魔法数字",
            type: "best-practice",
            severity: "info",
            message: `检测到魔法数字：${value}，建议定义为常量`,
            startLine: loc.startLine,
            startColumn: loc.startColumn,
            endLine: loc.endLine,
            endColumn: loc.endColumn,
            suggestion: `定义为 const ${value > 100 ? 'MAX' : 'SIZE'} = ${value}; 然后使用常量名`,
          };
        }
      }
    }
    return null;
  },
};

/**
 * 规则15: 检测过长的函数（超过 30 条语句）
 */
const ruleNoLongFunction: Rule = {
  id: "no-long-function",
  name: "过长的函数",
  type: "maintainability",
  severity: "warning",
  description: "函数体超过 30 条语句，建议拆分为多个职责单一的小函数",
  suggestion: "将函数拆分为多个小函数，每个函数不超过 20 条语句",
  check: (path) => {
    if (t.isFunctionDeclaration(path.node) || t.isArrowFunctionExpression(path.node) || t.isFunctionExpression(path.node)) {
      const body = path.node.body;
      if (t.isBlockStatement(body)) {
        const stmtCount = body.body.length;
        if (stmtCount > 30) {
          const loc = getNodeLocation(path.node);
          const funcName = t.isFunctionDeclaration(path.node) ? path.node.id?.name : "匿名函数";
          return {
            id: "no-long-function",
            name: "过长的函数",
            type: "maintainability",
            severity: "warning",
            message: `函数 ${funcName} 过长（${stmtCount} 条语句），建议拆分`,
            startLine: loc.startLine,
            startColumn: loc.startColumn,
            endLine: loc.endLine,
            endColumn: loc.endColumn,
            suggestion: "将函数拆分为多个职责单一的小函数，每个函数不超过 20 条语句",
          };
        }
      }
    }
    return null;
  },
};

/**
 * 规则16: 检测硬编码邮箱地址
 */
const ruleNoHardcodedEmail: Rule = {
  id: "no-hardcoded-email",
  name: "硬编码邮箱地址",
  type: "security",
  severity: "warning",
  description: "代码中包含硬编码的邮箱地址，可能被用于垃圾邮件或钓鱼攻击",
  suggestion: "使用环境变量或配置文件存储邮箱地址",
  check: (path) => {
    // 这个规则在 analyzeCode 中统一处理
    return null;
  },
};

/**
 * 规则17: 检测电话号码
 */
const ruleNoHardcodedPhone: Rule = {
  id: "no-hardcoded-phone",
  name: "硬编码电话号码",
  type: "security",
  severity: "warning",
  description: "代码中包含硬编码的电话号码，可能被用于营销或诈骗",
  suggestion: "使用环境变量或配置文件存储电话号码",
  check: (path) => {
    // 这个规则在 analyzeCode 中统一处理
    return null;
  },
};

/**
 * 规则18: 检测可疑注释
 */
const ruleNoSuspiciousComment: Rule = {
  id: "no-suspicious-comment",
  name: "可疑注释",
  type: "security",
  severity: "warning",
  description: "检测代码中包含的可疑关键词，可能存在安全风险或隐藏的后门",
  suggestion: "检查注释内容，确保没有泄露敏感信息或隐藏恶意代码",
  check: (path) => {
    // 这个规则在 analyzeCode 中统一处理
    return null;
  },
};

/**
 * 规则19: 检测 TODO/FIXME 注释
 */
const ruleNoTodoComment: Rule = {
  id: "no-todo-comment",
  name: "TODO/FIXME 注释",
  type: "maintainability",
  severity: "info",
  description: "代码中包含未完成的 TODO 或 FIXME 注释",
  suggestion: "完成注释中提到的任务，或使用项目管理工具跟踪",
  check: (path) => {
    // 这个规则在 analyzeCode 中统一处理
    return null;
  },
};

// 规则列表
const rules: Rule[] = [
  ruleNoEval,
  ruleNoNewFunction,
  ruleNoInnerHTML,
  ruleNoConsoleLog,
  ruleNoDebugger,
  ruleNoVar,
  ruleNoDoubleEquals,
  ruleNoHardcodedSecret,
  ruleNoSQLInjection,
  ruleNoCommandInjection,
  ruleNoInsecureRandom,
  ruleNoMissingKey,
  ruleNoInlineFunction,
  ruleNoMagicNumber,
  ruleNoLongFunction,
  ruleNoHardcodedEmail,
  ruleNoHardcodedPhone,
  ruleNoSuspiciousComment,
  ruleNoTodoComment,
];

/**
 * 基于整个代码的正则分析（检测邮箱、电话、注释等）
 */
function performCodeLevelAnalysis(code: string): Issue[] {
  const issues: Issue[] = [];
  if (!code || code.length === 0) return issues;

  // 规则16: 检测硬编码邮箱（限制最多检测5个）
  let emailCount = 0;
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  let emailMatch;
  while ((emailMatch = emailRegex.exec(code)) !== null && emailCount < 5) {
    const lineInfo = findLineForPosition(code, emailMatch.index);
    issues.push({
      id: "no-hardcoded-email",
      name: "硬编码邮箱地址",
      type: "security",
      severity: "warning",
      message: `检测到硬编码邮箱地址：${emailMatch[0]}`,
      startLine: lineInfo.line,
      startColumn: lineInfo.column,
      endLine: lineInfo.line,
      endColumn: lineInfo.column + emailMatch[0].length,
      suggestion: "使用环境变量存储邮箱地址",
    });
    emailCount++;
  }

  // 规则17: 检测电话号码（限制最多检测5个）
  let phoneCount = 0;
  const phoneRegex = /(\+?86)?[-.\s]?1[3-9]\d[-.\s]?\d{4}[-.\s]?\d{4}/g;
  let phoneMatch;
  while ((phoneMatch = phoneRegex.exec(code)) !== null && phoneCount < 5) {
    const lineInfo = findLineForPosition(code, phoneMatch.index);
    issues.push({
      id: "no-hardcoded-phone",
      name: "硬编码电话号码",
      type: "security",
      severity: "warning",
      message: `检测到硬编码电话号码：${phoneMatch[0]}`,
      startLine: lineInfo.line,
      startColumn: lineInfo.column,
      endLine: lineInfo.line,
      endColumn: lineInfo.column + phoneMatch[0].length,
      suggestion: "使用环境变量存储电话号码",
    });
    phoneCount++;
  }

  // 规则18: 检测可疑注释（限制最多检测5个）
  let suspiciousCount = 0;
  const suspiciousPatterns = [
    /hack|backdoor|bypass|exploit|cheat|crack/i,
    /password\s*[:=]|secret\s*[:=]|api\s*key\s*[:=]/i,
    /\badmin\b.*\bpass\b/i,
  ];
  for (const pattern of suspiciousPatterns) {
    if (suspiciousCount >= 5) break;
    const regex = new RegExp(pattern.source, "gi");
    let match;
    while ((match = regex.exec(code)) !== null && suspiciousCount < 5) {
      const lineInfo = findLineForPosition(code, match.index);
      issues.push({
        id: "no-suspicious-comment",
        name: "可疑注释",
        type: "security",
        severity: "warning",
        message: `检测到可疑内容：${match[0]}`,
        startLine: lineInfo.line,
        startColumn: lineInfo.column,
        endLine: lineInfo.line,
        endColumn: lineInfo.column + Math.min(match[0].length, 50),
        suggestion: "检查这段内容是否包含敏感信息",
      });
      suspiciousCount++;
    }
  }

  // 规则19: 检测 TODO/FIXME（限制最多检测10个）
  let todoCount = 0;
  const todoRegex = /\/\/\s*(TODO|FIXME|HACK|XXX):?\s*(.+)?/gi;
  let todoMatch;
  while ((todoMatch = todoRegex.exec(code)) !== null && todoCount < 10) {
    const lineInfo = findLineForPosition(code, todoMatch.index);
    issues.push({
      id: "no-todo-comment",
      name: "TODO/FIXME 注释",
      type: "maintainability",
      severity: "info",
      message: `检测到未完成注释：${todoMatch[0]}`,
      startLine: lineInfo.line,
      startColumn: lineInfo.column,
      endLine: lineInfo.line,
      endColumn: lineInfo.column + todoMatch[0].length,
      suggestion: "完成注释中提到的任务",
    });
    todoCount++;
  }

  return issues;
}

/**
 * 根据字符位置找到对应的行号和列号
 */
function findLineForPosition(code: string, position: number): { line: number; column: number } {
  const lines = code.substring(0, position).split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

/**
 * 分析代码
 */
export function analyzeCode(code: string, filename: string = "code.js"): AnalysisResult {
  const startTime = performance.now();
  
  const issues: Issue[] = [];
  
  const parseResult = parseCode(code);

  if (!parseResult.ast) {
    return {
      filename,
      issues: [],
      totalIssues: 0,
      highSeverity: 0,
      parseResult,
      duration: Math.round(performance.now() - startTime),
    };
  }

  traverse(parseResult.ast, {
    enter(path) {
      for (const rule of rules) {
        try {
          const issue = rule.check(path, code);
          if (issue) {
            issue.codeSnippet = getCodeSnippet(code, issue.startLine, issue.endLine);
            issues.push(issue);
            break;
          }
        } catch (e) {
          // 单个规则出错不影响整体分析
        }
      }
    },
  });

  // 基于整个代码的正则检测
  try {
    const codeIssues = performCodeLevelAnalysis(code);
    issues.push(...codeIssues);
  } catch {
    // 整码级分析失败不阻断结果返回
  }
  
  const highSeverity = issues.filter(i => i.severity === "error").length;
  
  return {
    filename,
    issues,
    totalIssues: issues.length,
    highSeverity,
    parseResult,
    duration: Math.round(performance.now() - startTime),
  };
}

/**
 * 将分析结果转换为 Markdown 报告
 */
export function generateReport(result: AnalysisResult): string {
  const { filename, issues, totalIssues, highSeverity, duration } = result;
  
  let report = `# 🔍 代码审计报告\n\n`;
  report += `**文件**: ${filename}\n`;
  report += `**问题总数**: ${totalIssues}\n`;
  report += `**高危问题**: ${highSeverity}\n`;
  report += `**分析耗时**: ${duration}ms\n\n`;
  
  if (issues.length === 0) {
    report += `✅ **未检测到问题**\n`;
    return report;
  }
  
  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");
  const infos = issues.filter(i => i.severity === "info");
  
  if (errors.length > 0) {
    report += `## ❌ 错误 (${errors.length})\n\n`;
    for (const issue of errors) {
      report += `### ${issue.name}\n`;
      report += `**位置**: 第 ${issue.startLine} 行\n\n`;
      report += `**描述**: ${issue.message}\n\n`;
      if (issue.suggestion) {
        report += `**建议**: ${issue.suggestion}\n\n`;
      }
      report += `---\n\n`;
    }
  }
  
  if (warnings.length > 0) {
    report += `## ⚠️ 警告 (${warnings.length})\n\n`;
    for (const issue of warnings) {
      report += `### ${issue.name}\n`;
      report += `**位置**: 第 ${issue.startLine} 行\n\n`;
      report += `**描述**: ${issue.message}\n\n`;
      if (issue.suggestion) {
        report += `**建议**: ${issue.suggestion}\n\n`;
      }
      report += `---\n\n`;
    }
  }
  
  if (infos.length > 0) {
    report += `## ℹ️ 提示 (${infos.length})\n\n`;
    for (const issue of infos) {
      report += `### ${issue.name}\n`;
      report += `**位置**: 第 ${issue.startLine} 行\n\n`;
      report += `**描述**: ${issue.message}\n\n`;
      if (issue.suggestion) {
        report += `**建议**: ${issue.suggestion}\n\n`;
      }
      report += `---\n\n`;
    }
  }
  
  return report;
}

export default {
  parseCode,
  analyzeCode,
  generateReport,
  types: t,
};
