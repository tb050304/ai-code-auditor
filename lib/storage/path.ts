import { VfsError } from "./types";

/** 规范化路径：统一为 / 开头，无末尾 /，解析 . 和 .. */
export function normalizePath(path: string): string {
  if (!path) return "/";
  if (path[0] !== "/") path = "/" + path;

  const parts = path.split("/").filter(Boolean);
  const stack: string[] = [];

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }

  return "/" + stack.join("/");
}

/** 获取路径的父目录路径 */
export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  return idx === 0 ? "/" : normalized.slice(0, idx);
}

/** 获取路径的最后一段（文件名或目录名） */
export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "";
  const idx = normalized.lastIndexOf("/");
  return normalized.slice(idx + 1);
}

/** 获取文件扩展名（含点号），无扩展名返回空字符串 */
export function extname(path: string): string {
  const base = basename(path);
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx);
}

/** 判断路径是否是另一个路径的子路径 */
export function isChildOf(parent: string, child: string): boolean {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  if (p === "/") return c !== "/";
  return c.startsWith(p + "/");
}

/** 拼接路径片段 */
export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}

/** 校验路径合法性，不合法则抛错 */
export function validatePath(path: string): void {
  if (!path || typeof path !== "string") {
    throw new VfsError("INVALID_PATH", "路径不能为空");
  }
  // 包含 NUL 字节
  if (path.includes("\0")) {
    throw new VfsError("INVALID_PATH", "路径不能包含空字符");
  }
  // Windows 风格的盘符也不支持
  if (/^[a-zA-Z]:/.test(path)) {
    throw new VfsError("INVALID_PATH", "不支持 Windows 盘符路径");
  }
}

/** 根据路径按层级生成所有祖先目录（不包含根，不包含自身） */
export function ancestorPaths(path: string): string[] {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  const result: string[] = [];
  let current = "";
  // 去掉最后一段（自身），前面的逐个加
  for (let i = 0; i < parts.length - 1; i++) {
    current += "/" + parts[i];
    result.push(current);
  }
  return result;
}
