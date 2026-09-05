import { extname } from "./storage/path";

/**
 * 根据文件路径推断 Monaco Editor 的语言标识。
 * 抽成公共函数，供多 Tab、文件树等多处使用。
 */
export function inferMonacoLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".html": "html",
    ".htm": "html",
    ".xml": "xml",
    ".svg": "xml",
    ".md": "markdown",
    ".markdown": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".sql": "sql",
    ".vue": "html",
    ".svelte": "html",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".toml": "ini",
    ".ini": "ini",
  };
  return map[ext] || "plaintext";
}
