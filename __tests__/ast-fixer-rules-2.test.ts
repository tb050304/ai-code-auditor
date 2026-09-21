/**
 * Day 17 自动修复规则测试（第二批）
 * - react-no-missing-key：补 key={index}
 * - prefer-template：字符串拼接 → 模板字符串
 * - no-unused-imports：整理 import
 * 端到端：analyzeCode 产出 issue.fix → applyFixes 应用 → 断言结果代码。
 */
import { describe, it, expect } from "vitest";
import { analyzeCode } from "@/lib/ast";
import { applyFixes, isFixable } from "@/lib/ast/fixer";

function findFix(code: string, ruleId: string) {
  const issue = analyzeCode(code).issues.find((i) => i.id === ruleId);
  expect(issue, `应命中规则 ${ruleId}`).toBeDefined();
  expect(isFixable(issue!), `规则 ${ruleId} 应带自动修复`).toBe(true);
  return issue!.fix!;
}

describe("规则自动修复 — react-no-missing-key", () => {
  it("单参数无括号箭头函数：补 index 参数并插入 key", () => {
    const code = "const els = items.map(item => <li>{item}</li>);";
    const r = applyFixes(code, [findFix(code, "react-no-missing-key")]);
    expect(r.applied[0]).toMatchObject({ ruleId: "react-no-missing-key", risk: "review" });
    expect(r.code).toBe(
      "const els = items.map((item, index) => <li key={index}>{item}</li>);",
    );
  });

  it("已显式声明 index 形参时直接复用其名称", () => {
    const code = "const els = items.map((it, idx) => <li>{it}</li>);";
    const r = applyFixes(code, [findFix(code, "react-no-missing-key")]);
    expect(r.code).toBe("const els = items.map((it, idx) => <li key={idx}>{it}</li>);");
  });

  it("元素已有属性时 key 插在属性之前", () => {
    const code = 'items.map(item => <li className="x">{item}</li>);';
    const r = applyFixes(code, [findFix(code, "react-no-missing-key")]);
    expect(r.code).toBe(
      'items.map((item, index) => <li key={index} className="x">{item}</li>);',
    );
  });

  it("自闭合标签也能正确插入", () => {
    const code = "items.map(item => <Row data={item} />);";
    const r = applyFixes(code, [findFix(code, "react-no-missing-key")]);
    expect(r.code).toBe(
      "items.map((item, index) => <Row key={index} data={item} />);",
    );
  });

  it("已有 key 时不再命中", () => {
    const code = "const els = items.map(item => <li key={item.id}>{item}</li>);";
    const issue = analyzeCode(code).issues.find((i) => i.id === "react-no-missing-key");
    expect(issue).toBeUndefined();
  });
});

describe("规则自动修复 — prefer-template", () => {
  it("字符串 + 表达式 → 模板字符串", () => {
    const code = 'const x = "a" + b;';
    const r = applyFixes(code, [findFix(code, "prefer-template")]);
    expect(r.applied[0]).toMatchObject({ ruleId: "prefer-template", risk: "safe" });
    expect(r.code).toBe("const x = `a${b}`;");
  });

  it("前导连续非字符串段按左结合合并，保持数值加法语义", () => {
    // (1 + 2) + "x" === "3x"，不能变成 `${1}${2}x`（那会是 "12x"）
    const code = 'const x = 1 + 2 + "x";';
    const r = applyFixes(code, [findFix(code, "prefer-template")]);
    expect(r.code).toBe("const x = `${1 + 2}x`;");
  });

  it("字符串在前、多个表达式在后：表达式合并为一个插值", () => {
    const code = 'const x = "total: " + a + b;';
    const r = applyFixes(code, [findFix(code, "prefer-template")]);
    expect(r.code).toBe("const x = `total: ${a + b}`;");
  });

  it("转义反引号与 ${ 序列", () => {
    const code = 'const x = "`" + a + "${y}";';
    const r = applyFixes(code, [findFix(code, "prefer-template")]);
    expect(r.code).toBe("const x = `\\`${a}\\${y}`;");
  });

  it("纯字符串字面量相加不报告", () => {
    const code = 'const x = "a" + "b";';
    const issue = analyzeCode(code).issues.find((i) => i.id === "prefer-template");
    expect(issue).toBeUndefined();
  });

  it("纯数值相加不报告", () => {
    const code = "const x = 1 + 2;";
    const issue = analyzeCode(code).issues.find((i) => i.id === "prefer-template");
    expect(issue).toBeUndefined();
  });
});

describe("规则自动修复 — no-unused-imports", () => {
  it("删除部分未使用的命名导入（保留源码引号风格）", () => {
    const code = 'import { a, b } from "x";\nconsole.log(a);';
    const r = applyFixes(code, [findFix(code, "no-unused-imports")]);
    expect(r.applied[0]).toMatchObject({ ruleId: "no-unused-imports", risk: "review" });
    expect(r.code).toBe('import { a } from "x";\nconsole.log(a);');
  });

  it("整条导入全部未使用时删除声明", () => {
    const code = 'import { a, b } from "x";\nconsole.log(1);';
    const r = applyFixes(code, [findFix(code, "no-unused-imports")]);
    // 删除节点后留下空行（与其他删语句修复一致）
    expect(r.code.trim()).toBe("console.log(1);");
  });

  it("default + 命名混合，仅删未使用部分", () => {
    const code = 'import React, { useState, unused } from "react";\nconsole.log(React, useState);';
    const r = applyFixes(code, [findFix(code, "no-unused-imports")]);
    expect(r.code).toBe('import React, { useState } from "react";\nconsole.log(React, useState);');
  });

  it("保留别名导入的 as 重命名", () => {
    const code = 'import { x as y, z } from "m";\nconsole.log(y);';
    const r = applyFixes(code, [findFix(code, "no-unused-imports")]);
    expect(r.code).toBe('import { x as y } from "m";\nconsole.log(y);');
  });

  it("JSX 中使用的组件算作已引用", () => {
    const code = 'import Foo from "./Foo";\nconst el = <Foo />;';
    const issue = analyzeCode(code).issues.find((i) => i.id === "no-unused-imports");
    expect(issue).toBeUndefined();
  });

  it("TypeScript 类型位置使用的导入算作已引用", () => {
    const code = 'import { Foo } from "./m";\nconst v: Foo = null as unknown as Foo;';
    const issue = analyzeCode(code).issues.find((i) => i.id === "no-unused-imports");
    expect(issue).toBeUndefined();
  });

  it("namespace 导入未使用时整条删除", () => {
    const code = 'import * as utils from "u";\nconsole.log(1);';
    const r = applyFixes(code, [findFix(code, "no-unused-imports")]);
    expect(r.code.trim()).toBe("console.log(1);");
  });

  it("纯副作用导入（无 specifier）永不报告", () => {
    const code = 'import "./styles.css";\nconsole.log(1);';
    const issue = analyzeCode(code).issues.find((i) => i.id === "no-unused-imports");
    expect(issue).toBeUndefined();
  });
});

describe("Day 17 规则混合修复", () => {
  it("一个文件内三类问题同时修复", () => {
    const code =
      'import { used, unused } from "m";\n' +
      "const els = used.map(item => <li>{item}</li>);\n" +
      'const msg = "hi " + used;';
    const fixes = analyzeCode(code).issues.filter(isFixable).map((i) => i.fix!);
    const r = applyFixes(code, fixes);
    expect(r.applied.map((f) => f.ruleId).sort()).toEqual(
      ["no-unused-imports", "prefer-template", "react-no-missing-key"].sort(),
    );
    expect(r.code).toContain('import { used } from "m";');
    expect(r.code).toContain("(item, index) => <li key={index}>");
    expect(r.code).toContain("const msg = `hi ${used}`;");
  });
});
