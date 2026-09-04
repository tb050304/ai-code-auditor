import type { FileNode, FileNodeType } from "./types";
import { basename, dirname, extname, joinPath } from "./path";

/** 树结构中的目录节点 */
export interface TreeNode {
  path: string;
  name: string;
  type: FileNodeType;
  size: number;
  mtime: number;
  ctime: number;
  children?: TreeNode[];
}

/** 文件类型分类，用于图标着色 */
export type FileCategory =
  | "typescript"
  | "javascript"
  | "json"
  | "css"
  | "html"
  | "markdown"
  | "yaml"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "shell"
  | "sql"
  | "image"
  | "config"
  | "other";

/**
 * 根据扩展名判断文件分类。
 * 用于决定图标颜色和样式。
 */
export function getFileCategory(filePath: string): FileCategory {
  const ext = extname(filePath).toLowerCase();

  const categoryMap: Record<string, FileCategory> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".css": "css",
    ".scss": "css",
    ".less": "css",
    ".html": "html",
    ".htm": "html",
    ".vue": "html",
    ".svelte": "html",
    ".md": "markdown",
    ".markdown": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "c",
    ".hpp": "c",
    ".cs": "c",
    ".swift": "c",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".sql": "sql",
    ".svg": "image",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".webp": "image",
    ".ico": "image",
    ".toml": "config",
    ".ini": "config",
    ".env": "config",
    ".xml": "config",
  };

  return categoryMap[ext] ?? "other";
}

/** 每个分类对应的颜色（tailwind text-* 类） */
export const FILE_CATEGORY_COLORS: Record<FileCategory, string> = {
  typescript: "text-blue-400",
  javascript: "text-yellow-400",
  json: "text-amber-400",
  css: "text-pink-400",
  html: "text-orange-400",
  markdown: "text-slate-300",
  yaml: "text-purple-400",
  python: "text-green-400",
  go: "text-cyan-400",
  rust: "text-orange-500",
  java: "text-red-400",
  c: "text-blue-300",
  shell: "text-green-500",
  sql: "text-blue-500",
  image: "text-pink-500",
  config: "text-slate-400",
  other: "text-slate-400",
};

/** 每个分类对应的图标文字（简洁符号，不用 emoji 以便上色） */
export const FILE_CATEGORY_ICONS: Record<FileCategory, string> = {
  typescript: "TS",
  javascript: "JS",
  json: "{}",
  css: "#",
  html: "<>",
  markdown: "M↓",
  yaml: "Y:",
  python: "Py",
  go: "Go",
  rust: "Rs",
  java: "Jv",
  c: "C/",
  shell: "$_",
  sql: "SQ",
  image: "[]",
  config: "⚙",
  other: "·",
};

/**
 * 将扁平的 FileNode 列表构建为树结构。
 * 注意：input 必须包含所有祖先目录，否则缺失的目录会被自动补建。
 */
export function buildTree(nodes: FileNode[]): TreeNode {
  const root: TreeNode = {
    path: "/",
    name: "",
    type: "directory",
    size: 0,
    mtime: 0,
    ctime: 0,
    children: [],
  };

  // 用 map 加速查找
  const dirMap = new Map<string, TreeNode>();
  dirMap.set("/", root);

  // 确保所有节点按路径深度排序（先父后子）
  const sorted = [...nodes].sort((a, b) => a.path.localeCompare(b.path));

  for (const node of sorted) {
    // 确保父目录存在
    const parentPath = dirname(node.path);
    ensureAncestors(parentPath, dirMap, node.mtime, node.ctime);

    const treeNode: TreeNode = {
      path: node.path,
      name: basename(node.path),
      type: node.type,
      size: node.size,
      mtime: node.mtime,
      ctime: node.ctime,
    };

    if (node.type === "directory") {
      treeNode.children = [];
      dirMap.set(node.path, treeNode);
    }

    const parent = dirMap.get(parentPath)!;
    parent.children!.push(treeNode);
  }

  // 每个目录下的子节点排序：目录在前，文件在后，各按名字排
  sortTree(root);

  return root;
}

function ensureAncestors(
  path: string,
  dirMap: Map<string, TreeNode>,
  mtime: number,
  ctime: number,
): void {
  if (dirMap.has(path)) return;

  const parent = dirname(path);
  if (parent !== path) ensureAncestors(parent, dirMap, mtime, ctime);

  const node: TreeNode = {
    path,
    name: basename(path),
    type: "directory",
    size: 0,
    mtime,
    ctime,
    children: [],
  };
  dirMap.set(path, node);

  const parentNode = dirMap.get(parent);
  if (parentNode && parentNode.children) {
    parentNode.children.push(node);
  }
}

function sortTree(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (child.type === "directory") sortTree(child);
  }
}

/**
 * 从树中查找某个路径的节点。
 */
export function findNode(root: TreeNode, path: string): TreeNode | null {
  const normalized = joinPath(path);
  if (normalized === "/") return root;

  const parts = normalized.split("/").filter(Boolean);
  let current: TreeNode | undefined = root;

  for (const part of parts) {
    current = current.children?.find((c) => c.name === part);
    if (!current) return null;
  }

  return current;
}

/**
 * 按文件名在树中模糊搜索（简单的 includes 匹配）。
 */
export function searchTree(root: TreeNode, query: string): TreeNode[] {
  const results: TreeNode[] = [];
  const q = query.toLowerCase();

  function walk(node: TreeNode) {
    if (node.name.toLowerCase().includes(q) && node.path !== "/") {
      results.push(node);
    }
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  }

  walk(root);
  return results;
}
