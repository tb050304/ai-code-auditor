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
  /** 过滤阶段进度回调（已过滤 / 总数） */
  onFilterProgress?: (processed: number, total: number) => void;
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

/** 获取 File 的相对路径 */
function getRelativePath(file: File): string {
  // 1. input[type=file webkitdirectory] 方式：使用标准的 webkitRelativePath
  const webkitPath = (file as unknown as { webkitRelativePath?: string }).webkitRelativePath;
  if (webkitPath) return webkitPath;
  // 2. 拖拽方式（collectFilesFromDataTransfer 注入）
  const injectedPath = (file as unknown as { __relativePath?: string }).__relativePath;
  if (injectedPath) return injectedPath;
  // 3. 单文件导入：只有文件名
  return file.name;
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

/** 读取文件为文本，自动检测编码：BOM → UTF-16 → UTF-8 / GBK 启发式 */
export async function readFileAsText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // 1) BOM 识别 —— 最可靠的编码信号
  //    UTF-8 BOM: EF BB BF
  //    UTF-16 LE BOM: FF FE
  //    UTF-16 BE BOM: FE FF
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    return decoder.decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const decoder = new TextDecoder("utf-16le", { fatal: false });
    return decoder.decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const decoder = new TextDecoder("utf-16be", { fatal: false });
    return decoder.decode(bytes.subarray(2));
  }

  // 2) 无 BOM 的 UTF-16 启发式检测
  //    ASCII 文本在 UTF-16LE 里会呈现「字母 \0 字母 \0」的模式
  if (bytes.length >= 32 && looksLikeUtf16Le(bytes)) {
    try {
      const decoder = new TextDecoder("utf-16le", { fatal: true });
      return decoder.decode(bytes);
    } catch {
      // 不是真的 UTF-16LE，走下面的流程
    }
  }
  if (bytes.length >= 32 && looksLikeUtf16Be(bytes)) {
    try {
      const decoder = new TextDecoder("utf-16be", { fatal: true });
      return decoder.decode(bytes);
    } catch {
      // 不是真的 UTF-16BE，走下面的流程
    }
  }

  // 3) 二进制检测：包含 NUL 字节 → 当作非文本跳过
  if (bytes.includes(0)) {
    throw new Error("binary file");
  }

  // 4) UTF-8 / GBK 启发式
  const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
  const utf8Text = utf8Decoder.decode(bytes);

  // 统计替换字符（U+FFFD）数量，如果太多说明不是 UTF-8
  const replacementCount = (utf8Text.match(/\uFFFD/g) || []).length;
  const totalChars = utf8Text.length;
  const badRatio = totalChars > 0 ? replacementCount / totalChars : 0;

  // UTF-8 替换字符比例超过 0.5%，尝试 GBK
  if (badRatio > 0.005) {
    try {
      const gbkDecoder = new TextDecoder("gbk", { fatal: false });
      const gbkText = gbkDecoder.decode(bytes);
      // 如果 GBK 的替换字符更少，用 GBK 的结果
      const gbkBad = (gbkText.match(/\uFFFD/g) || []).length;
      if (gbkBad < replacementCount) {
        return gbkText;
      }
    } catch {
      // 浏览器不支持 GBK 时回退到 UTF-8
    }
  }

  return utf8Text;
}

/** 启发式：是否像 UTF-16LE（奇数位即高字节大量为 0，说明是 ASCII 字符） */
function looksLikeUtf16Le(bytes: Uint8Array): boolean {
  const sample = Math.min(bytes.length - 1, 512);
  let zeroAtOdd = 0;
  let checked = 0;
  for (let i = 1; i < sample; i += 2) {
    checked++;
    if (bytes[i] === 0) zeroAtOdd++;
  }
  return checked > 0 && zeroAtOdd / checked > 0.7;
}

/** 启发式：是否像 UTF-16BE（偶数位即高字节大量为 0） */
function looksLikeUtf16Be(bytes: Uint8Array): boolean {
  const sample = Math.min(bytes.length - 1, 512);
  let zeroAtEven = 0;
  let checked = 0;
  for (let i = 0; i < sample; i += 2) {
    checked++;
    if (bytes[i] === 0) zeroAtEven++;
  }
  return checked > 0 && zeroAtEven / checked > 0.7;
}

/**
 * 批量并行读取文件，控制并发数，避免主线程阻塞
 * @param files 文件列表
 * @param concurrency 并发数，默认 20
 * @param onProgress 每批完成后的进度回调
 */
export async function readFilesInBatches(
  files: Array<{ file: File; path: string }>,
  concurrency: number = 20,
  onProgress?: (done: number, total: number) => void,
): Promise<Array<{ path: string; content: string; size: number; error?: string }>> {
  const results: Array<{ path: string; content: string; size: number; error?: string }> = [];
  const total = files.length;
  let done = 0;
  let index = 0;

  async function worker() {
    while (index < total) {
      const i = index++;
      const { file, path } = files[i];
      try {
        const content = await readFileAsText(file);
        results.push({ path, content, size: file.size });
      } catch (e) {
        results.push({ path, content: "", size: file.size, error: String(e) });
      }
      done++;
      if (done % concurrency === 0 || done === total) {
        onProgress?.(done, total);
        // 让出主线程，避免 UI 卡死
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, total) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 将一批文件导入到 VFS 项目中。
 * 会自动创建项目、过滤文件、流式读取+写入（边读边写，不全量进内存）。
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
  const toRead: Array<{ file: File; path: string }> = [];

  // 第一步：快速过滤 —— 分批异步，每处理一批让出主线程
  // 避免大项目（如 2w+ 文件）的同步字符串操作卡死 UI 好几秒
  const FILTER_BATCH = 500;
  for (let i = 0; i < files.length; i += FILTER_BATCH) {
    const end = Math.min(i + FILTER_BATCH, files.length);
    for (let j = i; j < end; j++) {
      const file = files[j];
      const relPath = normalizePath(getRelativePath(file));

      const check = shouldIgnoreFile(file, filterOpts);
      if (check.skip) {
        skipped.push({ path: relPath, reason: check.reason! });
        continue;
      }

      if (!isTextFile(file)) {
        skipped.push({ path: relPath, reason: "非文本文件" });
        continue;
      }

      toRead.push({ file, path: relPath });
    }
    // 过滤阶段进度回调
    options.onFilterProgress?.(end, total);
    // 让出主线程，让 UI 有机会渲染进度
    if (end < files.length) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // 先创建项目，后续边读边写
  const project = await backend.createProject(projectName);

  // 第二步：流式分批 —— 读一批、写一批、报进度、让出主线程
  // 这样大项目导入不会一次性占满内存，也不会长时间卡死 UI
  const BATCH_SIZE = 50;
  const seenPaths = new Set<string>();
  let importedFiles = 0;
  let totalSize = 0;

  for (let i = 0; i < toRead.length; i += BATCH_SIZE) {
    const batch = toRead.slice(i, i + BATCH_SIZE);

    // 并发读这一批（并发度受 BATCH_SIZE 限制，20 左右就够）
    const readResults = await Promise.all(
      batch.map(async ({ file, path }) => {
        try {
          const content = await readFileAsText(file);
          return { path, content, size: file.size, ok: true as const };
        } catch (e) {
          return {
            path,
            content: "",
            size: file.size,
            ok: false as const,
            error: String(e),
          };
        }
      }),
    );

    // 去重 + 收集要写入的条目
    const itemsToWrite: Array<{ path: string; content: string }> = [];
    for (const r of readResults) {
      if (!r.ok) {
        skipped.push({
          path: r.path,
          reason: r.error.includes("binary") ? "检测为二进制" : `读取失败: ${r.error}`,
        });
        continue;
      }
      if (seenPaths.has(r.path)) continue;
      seenPaths.add(r.path);
      itemsToWrite.push({ path: r.path, content: r.content });
      importedFiles++;
      totalSize += r.size;
    }

    // 写这一批
    if (itemsToWrite.length > 0) {
      await backend.batchWrite(project.id, itemsToWrite);
    }

    // 汇报进度（已处理数 = 过滤后剩余中的已读数）
    const processed = Math.min(i + BATCH_SIZE, toRead.length);
    // 传当前批次最后一个文件名作为「正在处理」的提示
    const currentFile = batch.length > 0 ? batch[batch.length - 1].path : "";
    options.onProgress?.(processed, toRead.length, currentFile);
    // 让出主线程，UI 有机会更新进度条
    await new Promise((r) => setTimeout(r, 0));
  }

  return {
    projectId: project.id,
    totalFiles: total,
    importedFiles,
    skippedFiles: skipped.length,
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
