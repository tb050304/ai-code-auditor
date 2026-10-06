/**
 * Day 24 跨文件重构测试
 * - resolveImportPath：相对说明符 → 项目内绝对路径（扩展名/index 补全、裸模块跳过）
 * - computeImportSpecifier：绝对路径 → 相对说明符（同级/子级/上级、扩展名保留）
 * - rewriteImportsForMove：moveFile 的全项目 import 重写（引用方改写、自身重算、别名不动）
 */
import { describe, it, expect } from "vitest";
import {
  resolveImportPath,
  computeImportSpecifier,
  rewriteImportsForMove,
} from "@/lib/refactor";

describe("resolveImportPath", () => {
  const files = new Set([
    "/src/utils.ts",
    "/src/lib/index.ts",
    "/src/lib/helper.tsx",
    "/src/data.json",
  ]);
  const exists = (p: string) => files.has(p);

  it("无扩展名说明符按优先级补全", () => {
    expect(resolveImportPath("/src/a.ts", "./utils", exists)).toBe("/src/utils.ts");
    expect(resolveImportPath("/src/a.ts", "./lib/helper", exists)).toBe("/src/lib/helper.tsx");
  });

  it("目录解析到 index 文件", () => {
    expect(resolveImportPath("/src/a.ts", "./lib", exists)).toBe("/src/lib/index.ts");
  });

  it("说明符自带扩展名时精确命中", () => {
    expect(resolveImportPath("/src/a.ts", "./data.json", exists)).toBe("/src/data.json");
  });

  it("上级目录 ../ 正确归一化", () => {
    expect(resolveImportPath("/src/lib/x.ts", "../utils", exists)).toBe("/src/utils.ts");
  });

  it("裸模块与别名返回 null", () => {
    expect(resolveImportPath("/src/a.ts", "react", exists)).toBeNull();
    expect(resolveImportPath("/src/a.ts", "@/utils", exists)).toBeNull();
  });

  it("目标不存在返回 null", () => {
    expect(resolveImportPath("/src/a.ts", "./ghost", exists)).toBeNull();
  });
});

describe("computeImportSpecifier", () => {
  it("同级文件 → ./x（去扩展名）", () => {
    expect(computeImportSpecifier("/src/a.ts", "/src/utils.ts")).toBe("./utils");
  });

  it("子目录 → ./lib/x", () => {
    expect(computeImportSpecifier("/src/a.ts", "/src/lib/helper.ts")).toBe("./lib/helper");
  });

  it("上级目录 → ../x", () => {
    expect(computeImportSpecifier("/src/lib/a.ts", "/src/utils.ts")).toBe("../utils");
  });

  it("跨多级目录", () => {
    expect(computeImportSpecifier("/src/lib/deep/a.ts", "/src/utils.ts")).toBe("../../utils");
    expect(computeImportSpecifier("/a.ts", "/src/lib/helper.ts")).toBe("./src/lib/helper");
  });

  it("keepExtension=true 保留扩展名", () => {
    expect(computeImportSpecifier("/src/a.ts", "/src/utils.ts", true)).toBe("./utils.ts");
  });

  it("dropIndex=true 折叠 /index 为目录风格", () => {
    expect(computeImportSpecifier("/src/a.ts", "/src/lib/index.ts", false, true)).toBe("./lib");
    expect(computeImportSpecifier("/src/a.ts", "/src/lib/index.ts", false, false)).toBe("./lib/index");
  });
});

describe("rewriteImportsForMove", () => {
  it("引用方的 import 被改写到新位置（同级 → 子目录）", () => {
    const files = new Map([
      ["/src/utils.ts", "export const u = 1;\n"],
      ["/src/a.ts", 'import { u } from "./utils";\nconsole.log(u);\n'],
    ]);
    const { changes, movedContent } = rewriteImportsForMove(files, "/src/utils.ts", "/src/lib/utils.ts");
    expect(movedContent).toBe("export const u = 1;\n");
    expect(changes.get("/src/a.ts")).toBe('import { u } from "./lib/utils";\nconsole.log(u);\n');
  });

  it("子目录 → 根：从 /src 指向根的说明符升级为 ../", () => {
    const files = new Map([
      ["/src/lib/helper.ts", "export const h = 1;\n"],
      ["/src/app.ts", 'import { h } from "./lib/helper";\n'],
    ]);
    const { changes } = rewriteImportsForMove(files, "/src/lib/helper.ts", "/helper.ts");
    // /src/app.ts 到 /helper.ts 的正确相对路径是 ../helper
    expect(changes.get("/src/app.ts")).toBe('import { h } from "../helper";\n');
  });

  it("被移动文件自身的相对 import 按新位置重算", () => {
    const files = new Map([
      ["/src/lib/helper.ts", 'import { u } from "../utils";\nexport const h = u;\n'],
      ["/src/utils.ts", "export const u = 1;\n"],
    ]);
    // helper 从 /src/lib 移到 /src/deep/lib：../utils → ../../utils
    const { movedContent } = rewriteImportsForMove(files, "/src/lib/helper.ts", "/src/deep/lib/helper.ts");
    expect(movedContent).toBe('import { u } from "../../utils";\nexport const h = u;\n');
  });

  it("保留原引号风格（单引号）与显式扩展名", () => {
    const files = new Map([
      ["/src/utils.ts", "export const u = 1;\n"],
      ["/src/a.ts", "import { u } from './utils.ts';\n"],
    ]);
    const { changes } = rewriteImportsForMove(files, "/src/utils.ts", "/src/lib/utils.ts");
    expect(changes.get("/src/a.ts")).toBe("import { u } from './lib/utils.ts';\n");
  });

  it("export from / require / 动态 import 一并重写", () => {
    const files = new Map([
      ["/src/utils.ts", "export const u = 1;\n"],
      [
        "/src/a.ts",
        [
          'export { u } from "./utils";',
          'const m = require("./utils");',
          'const p = import("./utils");',
        ].join("\n"),
      ],
    ]);
    const { changes } = rewriteImportsForMove(files, "/src/utils.ts", "/src/lib/utils.ts");
    const out = changes.get("/src/a.ts") ?? "";
    expect(out).toContain('from "./lib/utils"');
    expect(out).toContain('require("./lib/utils")');
    expect(out).toContain('import("./lib/utils")');
  });

  it("index 文件引用：import './lib' 解析到 /src/lib/index.ts 并正确改写", () => {
    const files = new Map([
      ["/src/lib/index.ts", "export const x = 1;\n"],
      ["/src/a.ts", 'import { x } from "./lib";\n'],
    ]);
    const { changes } = rewriteImportsForMove(files, "/src/lib/index.ts", "/src/core/index.ts");
    expect(changes.get("/src/a.ts")).toBe('import { x } from "./core";\n');
  });

  it("不指向被移动文件的 import 不动；裸模块与别名不动", () => {
    const files = new Map([
      ["/src/utils.ts", "export const u = 1;\n"],
      ["/src/other.ts", "export const o = 2;\n"],
      [
        "/src/a.ts",
        ['import { u } from "./utils";', 'import { o } from "./other";', 'import React from "react";', 'import { q } from "@/lib/q";'].join("\n"),
      ],
    ]);
    const { changes } = rewriteImportsForMove(files, "/src/utils.ts", "/src/lib/utils.ts");
    const out = changes.get("/src/a.ts") ?? "";
    expect(out).toContain('from "./lib/utils"');
    expect(out).toContain('from "./other"');
    expect(out).toContain('from "react"');
    expect(out).toContain('from "@/lib/q"');
  });

  it("解析失败的文件跳过，不阻塞其他文件", () => {
    const files = new Map([
      ["/src/utils.ts", "export const u = 1;\n"],
      ["/src/broken.ts", "import { u } from './utils';\nconst = 语法错误\n"],
      ["/src/a.ts", 'import { u } from "./utils";\n'],
    ]);
    const { changes } = rewriteImportsForMove(files, "/src/utils.ts", "/src/lib/utils.ts");
    expect(changes.has("/src/broken.ts")).toBe(false);
    expect(changes.get("/src/a.ts")).toContain("./lib/utils");
  });

  it("同一文件多处指向被移动文件时全部改写", () => {
    const files = new Map([
      ["/src/u.ts", "export const u = 1;\nexport default u;\n"],
      ["/src/a.ts", 'import u from "./u";\nimport { u as u2 } from "./u";\n'],
    ]);
    const { changes } = rewriteImportsForMove(files, "/src/u.ts", "/src/lib/u.ts");
    const out = changes.get("/src/a.ts") ?? "";
    expect(out.match(/\.\/lib\/u/g)).toHaveLength(2);
  });
});
