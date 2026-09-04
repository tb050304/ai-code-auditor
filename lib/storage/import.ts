import { normalizePath, joinPath } from "./path";
import type { VfsBackend, FileEntry } from "./types";

/** 默认忽略的目录名（匹配整个目录段） */
export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  ".turbo",
  "coverage",
  ".idea",
  ".vscode",
  "__pycache__",
  ".venv",
  "venv",
  "target",
]);

/** 默认忽略的文件名（精确匹配） */
export const DEFAULT_IGNORE_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "npm-debug.log",
  "yarn-debug.log",
  "yarn-error.log",
]);

/** 默认的单文件大小上限（1 MB），超过直接跳过 */
export const DEFAULT_MAX_FILE_SIZE = 1 * 1024 * 1024;

/** 可直接作为文本读取的扩展名 */
export const TEXT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".htm",
  ".xml",
  ".svg",
  ".md",
  ".markdown",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".env",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".swift",
  ".sql",
  ".vue",
  ".svelte",
  ".astro",
]);

export interface ImportOptions {
  /** 要忽略的目录名（会合并到默认集） */
  extraIgnoreDirs?: string[];
  /** 要忽略的文件名（会合并到默认集） */
  extraIgnoreFiles?: string[];
  /** 单文件大小上限（字节），0 表示不限制 */
  maxFileSize?: number;
  /** 进度回调（已处理文件数，总文件数，当前正在处理的文件名） */
  onProgress?: (processed: number, total: number, currentFile: string) => void;
}

export interface ImportResult {
  projectId: string;
  totalFiles: number;
  importedFiles: number;
  skippedFiles: number;
  skippedReasons: { path: string; reason: string }[];
  totalSize: number;
}

/**
 * 从 DataTransfer（拖放事件）中收集所有文件条目。
 * 支持文件夹递归遍历。
 */
export async function collectFilesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<File[]> {
  const items = dataTransfer.items;
  if (!items || items.length === 0) return [];

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "file") {
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
  }

  if (entries.length === 0) {
    // 降级：直接拿 FileList
    const files = dataTransfer.files;
    const result: File[] = [];
    for (let i = 0; i < files.length; i++) result.push(files[i]);
    return result;
  }

  const files: File[] = [];
  await Promise.all(entries.map((e) => walkEntry(e, "", files)));
  return files;
}

function walkEntry(entry: FileSystemEntry, relativePath: string, out: File[]): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      fileEntry.file(
        (file) => {
          // 把相对路径挂到 File 上（用 Object.defineProperty 避免污染）
          const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
          Object.defineProperty(file, "__relativePath", {
            value: relPath,
            enumerable: false,
            writable: false,
          });
          out.push(file);
          resolve();
        },
        () => resolve(),
      );
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      const nextRel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const readAll = () => {
        reader.readEntries(
          (batch) => {
            if (batch.length === 0) {
              resolve();
              return;
            }
            Promise.all(batch.map((e) => walkEntry(e, nextRel, out))).then(() => {
              // 有些浏览器分批返回，继续读
              readAll();
            });
          },
          () => resolve(),
        );
      };
      readAll();
    } else {
      resolve();
    }
  });
}

/** 获取 File 的相对路径（由 collectFilesFromDataTransfer 注入） */
function getRelativePath(file: File): string {
  return (file as unknown as { __relativePath?: string }).__relativePath ?? file.name;
}

/**
 * 从 FileList（input[type=file] webkitdirectory）收集文件。
 */
export function collectFilesFromFileList(fileList: FileList): File[] {
  const result: File[] = [];
  for (let i = 0; i < fileList.length; i++) result.push(fileList[i]);
  return result;
}

/** 判断文件是否应该被忽略 */
export function shouldIgnoreFile(
  file: File,
  options: {
    ignoreDirs: Set<string>;
    ignoreFiles: Set<string>;
    maxFileSize: number;
  },
): { skip: boolean; reason?: string } {
  const relPath = getRelativePath(file);
  const parts = relPath.split("/");

  // 检查目录段
  for (let i = 0; i < parts.length - 1; i++) {
    if (options.ignoreDirs.has(parts[i])) {
      return { skip: true, reason: `忽略目录: ${parts[i]}` };
    }
  }

  const name = parts[parts.length - 1];
  if (options.ignoreFiles.has(name)) {
    return { skip: true, reason: `忽略文件: ${name}` };
  }

  // 隐藏文件（. 开头）也跳过，但 .eslintrc / .gitignore 这类配置文件保留
  if (name.startsWith(".") && !isUsefulDotfile(name)) {
    return { skip: true, reason: `隐藏文件` };
  }

  if (options.maxFileSize > 0 && file.size > options.maxFileSize) {
    return { skip: true, reason: `文件过大 (${formatSize(file.size)})` };
  }

  return { skip: false };
}

function isUsefulDotfile(name: string): boolean {
  const useful = new Set([
    ".gitignore",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.json",
    ".eslintrc.cjs",
    ".eslintrc.yaml",
    ".eslintrc.yml",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.yaml",
    ".prettierrc.yml",
    ".editorconfig",
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".babelrc",
    ".babelrc.js",
    ".npmrc",
    ".yarnrc",
    ".nvmrc",
  ]);
  return useful.has(name);
}

/** 判断文件是否是文本文件（可读取内容） */
export function isTextFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    // 无扩展名或点文件，根据 type 简单判断
    return file.type.startsWith("text/") || file.type === "application/json";
  }
  const ext = name.slice(dot);
  return TEXT_EXTENSIONS.has(ext);
}

/** 读取文件为文本（含简单的二进制检测） */
export async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "utf-8");
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 将一批文件导入到 VFS 项目中。
 * 会自动创建项目、过滤文件、批量写入。
 */
export async function importFilesToProject(
  backend: VfsBackend,
  files: File[],
  projectName: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...(options.extraIgnoreDirs ?? [])]);
  const ignoreFiles = new Set([...DEFAULT_IGNORE_FILES, ...(options.extraIgnoreFiles ?? [])]);
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const filterOpts = { ignoreDirs, ignoreFiles, maxFileSize };

  const total = files.length;
  const skipped: { path: string; reason: string }[] = [];
  const entries: { path: string; content: string; size: number }[] = [];

  let processed = 0;

  // 先过滤，再读取
  for (const file of files) {
    processed++;
    const relPath = normalizePath(getRelativePath(file));
    options.onProgress?.(processed, total, relPath);

    const check = shouldIgnoreFile(file, filterOpts);
    if (check.skip) {
      skipped.push({ path: relPath, reason: check.reason! });
      continue;
    }

    if (!isTextFile(file)) {
      skipped.push({ path: relPath, reason: "二进制文件" });
      continue;
    }

    try {
      const content = await readFileAsText(file);
      // 简单的二进制检测：包含 NUL 字节认为是二进制
      if (content.includes("\0")) {
        skipped.push({ path: relPath, reason: "检测为二进制" });
        continue;
      }
      entries.push({ path: relPath, content, size: file.size });
    } catch (e) {
      skipped.push({ path: relPath, reason: `读取失败: ${e}` });
    }
  }

  // 去重（同一路径保留最后一个）
  const seen = new Map<string, { path: string; content: string; size: number }>();
  for (const entry of entries) {
    seen.set(entry.path, entry);
  }
  const deduped = Array.from(seen.values());
  const dedupCount = entries.length - deduped.length;

  // 创建项目
  const project = await backend.createProject(projectName);

  // 批量写入
  if (deduped.length > 0) {
    await backend.batchWrite(
      project.id,
      deduped.map((e) => ({ path: e.path, content: e.content })),
    );
  }

  const totalSize = deduped.reduce((sum, e) => sum + e.size, 0);

  return {
    projectId: project.id,
    totalFiles: total,
    importedFiles: deduped.length,
    skippedFiles: skipped.length + dedupCount,
    skippedReasons: skipped,
    totalSize,
  };
}

/** 从一组文件推断项目名（取共同的顶层目录名，或文件所在文件夹名） */
export function inferProjectName(files: File[]): string {
  if (files.length === 0) return "untitled";

  const paths = files.map((f) => getRelativePath(f));
  const topDirs = new Set<string>();

  for (const p of paths) {
    const firstSlash = p.indexOf("/");
    if (firstSlash > 0) {
      topDirs.add(p.slice(0, firstSlash));
    } else {
      // 直接就是文件，没有公共父目录
      return "imported-project";
    }
  }

  if (topDirs.size === 1) {
    return Array.from(topDirs)[0];
  }
  return "imported-project";
}

export { formatSize };
