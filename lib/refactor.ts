/**
 * 跨文件重构（Day 24）
 *
 * 核心能力：moveFile 时自动重写项目内所有指向被移动文件的 import。
 *
 * 设计要点：
 * 1. 纯函数，不依赖 React / IndexedDB；只依赖 @babel/parser 解析 import 语句。
 * 2. 最小修改：不重排格式，只替换 import 字符串字面量的内容（保留原引号风格）。
 * 3. 支持：import / export ... from / require() / 动态 import()。
 * 4. 解析规则：相对路径按项目内绝对路径解析；尝试补全扩展名与 /index 后缀。
 * 5. 被移动文件自身的相对 import 也会按新位置重新计算。
 *
 * 边界：裸模块（react、lodash）与别名（@/x、~/x）无法解析，保持原样。
 */

import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import type * as t from "@babel/types";
import { normalizePath, dirname } from "./storage/path";

// ---------------------------------------------------------------------------
// 路径工具（项目内统一以 "/" 开头的绝对路径，normalizePath/dirname 复用 VFS 实现）
// ---------------------------------------------------------------------------

const dirnameOf = dirname;

function joinPath(base: string, rel: string): string {
  return normalizePath(`${base}/${rel}`);
}

/** 已知的可解析扩展名（按优先级尝试） */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

function stripKnownExtension(p: string): string {
  for (const ext of RESOLVE_EXTENSIONS) {
    if (p.endsWith(ext)) return p.slice(0, -ext.length);
  }
  return p;
}

/**
 * 把 fromFile 中的相对 import 说明符解析为项目内绝对路径。
 * 无法解析（裸模块/别名/目标不存在）返回 null。
 */
export function resolveImportPath(
  fromFile: string,
  specifier: string,
  exists: (absPath: string) => boolean,
): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const base = joinPath(dirnameOf(fromFile), specifier);
  // 精确命中（说明符本身带扩展名）
  if (exists(base)) return base;
  // 补扩展名
  for (const ext of RESOLVE_EXTENSIONS) {
    if (exists(base + ext)) return base + ext;
  }
  // 目录 index
  for (const ext of RESOLVE_EXTENSIONS) {
    const idx = `${base}/index${ext}`;
    if (exists(idx)) return idx;
  }
  return null;
}

/**
 * 计算从 importerFile 指向 targetAbs（项目内绝对路径）的相对说明符。
 * 默认去掉已知扩展名；keepExtension=true 时保留目标文件的扩展名。
 * dropIndex=true 时，目标为 index 文件则去掉末尾 "/index"（import './lib' 风格）。
 */
export function computeImportSpecifier(
  importerFile: string,
  targetAbs: string,
  keepExtension = false,
  dropIndex = false,
): string {
  let target = keepExtension ? normalizePath(targetAbs) : stripKnownExtension(normalizePath(targetAbs));
  if (dropIndex && /\/index$/.test(target)) {
    target = target.slice(0, -"/index".length);
  }
  const fromDir = dirnameOf(importerFile);
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = target.split("/").filter(Boolean);

  // 找公共前缀
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }
  const ups = fromParts.length - common;
  const downs = toParts.slice(common);
  const rel = [...Array<string>(ups).fill(".."), ...downs].join("/");
  if (rel.startsWith("..")) return rel;
  return rel ? `./${rel}` : ".";
}

// ---------------------------------------------------------------------------
// import 重写
// ---------------------------------------------------------------------------

interface SourceEdit {
  /** 字符串字面量起点（含引号） */
  start: number;
  /** 字符串字面量终点（含引号） */
  end: number;
  /** 新文本（含引号，引号风格与原一致） */
  text: string;
}

/** 解析代码，收集所有"指向 targetAbs 的模块说明符"的替换编辑 */
function collectSourceEdits(
  code: string,
  filePath: string,
  mapSpecifier: (spec: string, hadExtension: boolean) => string | null,
): SourceEdit[] {
  let ast: t.File;
  try {
    ast = parser.parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      allowImportExportEverywhere: true,
      errorRecovery: true,
    });
  } catch {
    return [];
  }

  const edits: SourceEdit[] = [];
  const consider = (node: t.StringLiteral | null | undefined) => {
    if (!node || node.start == null || node.end == null) return;
    const spec = node.value;
    const hadExtension = RESOLVE_EXTENSIONS.some((ext) => spec.endsWith(ext));
    const next = mapSpecifier(spec, hadExtension);
    if (next === null || next === spec) return;
    const raw = code.slice(node.start, node.end);
    const quote = raw.startsWith("'") ? "'" : '"';
    edits.push({ start: node.start, end: node.end, text: `${quote}${next}${quote}` });
  };

  traverse(ast, {
    ImportDeclaration(path) {
      consider(path.node.source);
    },
    ExportNamedDeclaration(path) {
      consider(path.node.source);
    },
    ExportAllDeclaration(path) {
      consider(path.node.source);
    },
    CallExpression(path) {
      const callee = path.node.callee;
      const arg = path.node.arguments[0];
      // require("...")
      if (callee.type === "Identifier" && callee.name === "require" && arg?.type === "StringLiteral") {
        consider(arg);
      }
      // import("...")
      if (callee.type === "Import" && arg?.type === "StringLiteral") {
        consider(arg);
      }
    },
  });
  return edits;
}

/** 按逆序应用编辑（避免偏移累积） */
function applyEdits(code: string, edits: SourceEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = code;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// moveFile 主入口
// ---------------------------------------------------------------------------

export interface MoveRewriteResult {
  /** 需要写回的引用方文件：path → 新内容（不含被移动文件自身） */
  changes: Map<string, string>;
  /** 被移动文件重写后的内容（其内部相对 import 已按新位置重算） */
  movedContent: string;
}

/**
 * 计算 moveFile(from, to) 所需的全项目 import 重写。
 *
 * @param files   项目全部文件内容（路径以 "/" 开头；至少包含所有可能引用 from 的可分析文件与 from 自身）
 * @param from    源路径（移动前）
 * @param to      目标路径（移动后）
 */
export function rewriteImportsForMove(
  files: ReadonlyMap<string, string>,
  from: string,
  to: string,
): MoveRewriteResult {
  const fromAbs = normalizePath(from);
  const toAbs = normalizePath(to);
  const exists = (p: string) => files.has(p);

  const changes = new Map<string, string>();
  let movedContent = "";

  for (const [path, content] of files) {
    const isMovedFile = path === fromAbs;
    // 被移动文件：import 解析基准仍是旧位置（文件还没动），但说明符要按新位置重算
    const resolveBase = path;
    const edits = collectSourceEdits(content, resolveBase, (spec, hadExtension) => {
      const resolved = resolveImportPath(resolveBase, spec, exists);
      if (!resolved) return null;

      if (!isMovedFile) {
        // 引用方：仅当解析结果恰好是被移动文件时，改指到新位置
        if (resolved !== fromAbs) return null;
        // 原说明符未显式带 /index 时，目标为 index 文件就折叠成目录风格
        const dropIndex = !/\/index(\.[^/]*)?$/.test(spec);
        return computeImportSpecifier(path, toAbs, hadExtension, dropIndex);
      }

      // 被移动文件自身：所有相对 import 都按新位置重算（目标文件不移动，解析结果不变）
      if (resolved === fromAbs) return null; // 病态自引用，保持原样
      return computeImportSpecifier(toAbs, resolved, hadExtension);
    });

    if (edits.length === 0) {
      if (isMovedFile) movedContent = content;
      continue;
    }
    const next = applyEdits(content, edits);
    if (isMovedFile) movedContent = next;
    else changes.set(path, next);
  }

  return { changes, movedContent };
}
