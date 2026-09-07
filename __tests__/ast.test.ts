import { describe, it, expect } from "vitest";
import { analyzeCode, parseCode, generateReport } from "@/lib/ast";

describe("AST 分析 - 安全规则", () => {
  it("no-eval: 检测 eval() 调用", () => {
    const code = `const result = eval("1 + 2");`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-eval")).toBe(true);
  });

  it("no-eval: 安全代码不报错", () => {
    const code = `const result = JSON.parse('{"a":1}');`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-eval")).toBe(false);
  });

  it("no-new-function: 检测 new Function()", () => {
    const code = `const fn = new Function("a", "b", "return a + b");`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-new-function")).toBe(true);
  });

  it("no-inner-html: 检测 innerHTML 赋值", () => {
    const code = `document.getElementById("app").innerHTML = "<b>hi</b>";`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-inner-html")).toBe(true);
  });

  it("no-hardcoded-secret: 检测硬编码密钥", () => {
    const code = `const apiKey = "sk-abc123def456ghi789jkl012mnopqrs";`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-hardcoded-secret")).toBe(true);
  });

  it("no-hardcoded-secret: 普通字符串不报错", () => {
    const code = `const greeting = "hello world";`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-hardcoded-secret")).toBe(false);
  });

  it("no-sql-injection: 检测 SQL 注入风险", () => {
    const code = `
      const query = "SELECT * FROM users WHERE id = " + userId;
      db.query(query);
    `;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-sql-injection")).toBe(true);
  });

  it("no-command-injection: 检测命令注入风险", () => {
    const code = `
      const child_process = require("child_process");
      child_process.exec("ls " + dir);
    `;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-command-injection")).toBe(true);
  });

  it("no-insecure-random: 检测不安全的随机数", () => {
    const code = `const token = Math.random().toString(36).slice(2);`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-insecure-random")).toBe(true);
  });
});

describe("AST 分析 - 最佳实践规则", () => {
  it("no-var: 检测 var 声明", () => {
    const code = `var x = 1;`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-var")).toBe(true);
  });

  it("no-var: let/const 不报错", () => {
    const code = `let x = 1; const y = 2;`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-var")).toBe(false);
  });

  it("eqeqeq: 检测 == 使用", () => {
    const code = `if (a == b) { console.log("equal"); }`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "eqeqeq")).toBe(true);
  });

  it("eqeqeq: === 不报错", () => {
    const code = `if (a === b) { console.log("equal"); }`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "eqeqeq")).toBe(false);
  });

  it("no-debugger: 检测 debugger 语句", () => {
    const code = `function foo() { debugger; return 1; }`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-debugger")).toBe(true);
  });

  it("no-console-log: 检测 console.log", () => {
    const code = `console.log("debug info");`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-console-log")).toBe(true);
  });
});

describe("AST 分析 - React 规则", () => {
  it("react-no-missing-key: 检测列表渲染缺少 key", () => {
    const code = `
      function List({ items }) {
        return <div>{items.map(item => <span>{item}</span>)}</div>;
      }
    `;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "react-no-missing-key")).toBe(true);
  });

  it("react-no-missing-key: 有 key 的不报错", () => {
    const code = `
      function List({ items }) {
        return <div>{items.map(item => <span key={item.id}>{item.name}</span>)}</div>;
      }
    `;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "react-no-missing-key")).toBe(false);
  });

  it("react-no-inline-function: 检测行内函数", () => {
    const code = `
      function Button() {
        return <button onClick={() => alert("hi")}>click</button>;
      }
    `;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "react-no-inline-function")).toBe(true);
  });
});

describe("AST 分析 - 可维护性规则", () => {
  it("no-magic-number: 检测魔法数字", () => {
    const code = `if (count > 42) { return true; }`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-magic-number")).toBe(true);
  });

  it("no-long-function: 检测过长函数", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const code = `function longFn() {\n${lines}\n}`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-long-function")).toBe(true);
  });
});

describe("AST 分析 - 代码级正则规则", () => {
  it("no-hardcoded-email: 检测硬编码邮箱", () => {
    const code = `const email = "test@example.com";`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-hardcoded-email")).toBe(true);
  });

  it("no-hardcoded-phone: 检测硬编码手机号", () => {
    const code = `const phone = "13812345678";`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-hardcoded-phone")).toBe(true);
  });

  it("no-todo-comment: 检测 TODO 注释", () => {
    const code = `// TODO: 修复这个问题
      function foo() { return 1; }`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-todo-comment")).toBe(true);
  });

  it("no-suspicious-comment: 检测可疑注释", () => {
    const code = `// hack: 临时绕过验证
      function check() { return true; }`;
    const result = analyzeCode(code);
    expect(result.issues.some(i => i.id === "no-suspicious-comment")).toBe(true);
  });
});

describe("AST 分析 - 解析与元数据", () => {
  it("解析成功的代码返回 success: true", () => {
    const code = `const a = 1;`;
    const result = parseCode(code);
    expect(result.success).toBe(true);
    expect(result.ast).toBeDefined();
    expect(result.lineCount).toBe(1);
  });

  it("语法错误的代码返回 success: false", () => {
    const code = `const a = ;`;
    const result = parseCode(code);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("analyzeCode 返回正确的统计数据", () => {
    const code = `var x = eval("1+1");`;
    const result = analyzeCode(code);
    expect(result.totalIssues).toBeGreaterThan(0);
    expect(result.highSeverity).toBeGreaterThan(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.filename).toBe("code.js");
  });

  it("语法错误时 analyzeCode 返回空问题列表", () => {
    const code = `const a = ;;;;`;
    const result = analyzeCode(code);
    expect(result.issues).toEqual([]);
    expect(result.totalIssues).toBe(0);
  });

  it("支持 TypeScript 语法", () => {
    const code = `const x: number = 1;`;
    const result = analyzeCode(code, "test.ts");
    expect(result.parseResult.success).toBe(true);
  });

  it("支持 JSX 语法", () => {
    const code = `const el = <div>hello</div>;`;
    const result = analyzeCode(code, "test.jsx");
    expect(result.parseResult.success).toBe(true);
  });
});

describe("generateReport - 报告生成", () => {
  it("无问题时显示通过消息", () => {
    const result = analyzeCode(`const a = 1;`);
    const report = generateReport(result);
    expect(report).toContain("未检测到问题");
  });

  it("有问题时包含问题分类", () => {
    const result = analyzeCode(`var x = eval("1"); debugger;`);
    const report = generateReport(result);
    expect(report).toContain("代码审计报告");
    expect(report).toContain("问题总数");
  });
});
