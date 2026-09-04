/** 虚拟文件系统中节点的类型 */
export type FileNodeType = "file" | "directory";

/** 文件系统中的单个节点（文件或目录） */
export interface FileNode {
  /** 绝对路径，以 / 开头，如 /src/app/page.tsx */
  path: string;
  type: FileNodeType;
  /** 文件大小（字节），目录为 0 */
  size: number;
  /** 最后修改时间戳（ms） */
  mtime: number;
  /** 创建时间戳（ms） */
  ctime: number;
}

/** 文件节点 + 文件内容（仅文件有） */
export interface FileEntry extends FileNode {
  type: "file";
  content: string;
}

/** 目录节点 + 子节点列表 */
export interface DirectoryEntry extends FileNode {
  type: "directory";
  children: FileNode[];
}

/** 一个完整的项目 */
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
}

/** 文件系统操作的通用错误类型 */
export class VfsError extends Error {
  constructor(
    public code: VfsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VfsError";
  }
}

export type VfsErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "NOT_DIRECTORY"
  | "NOT_FILE"
  | "INVALID_PATH"
  | "QUOTA_EXCEEDED"
  | "BACKEND_ERROR";

/**
 * 虚拟文件系统后端接口。
 * 所有实现都必须支持这组基础操作，上层业务逻辑只依赖此接口。
 */
export interface VfsBackend {
  /** 后端名称，用于调试 */
  readonly name: string;

  // ---- 项目级 ----
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(name: string, rootPath?: string): Promise<Project>;
  deleteProject(id: string): Promise<void>;

  // ---- 读操作 ----
  /** 判断路径是否存在 */
  exists(projectId: string, path: string): Promise<boolean>;
  /** 读取单个文件内容 */
  readFile(projectId: string, path: string): Promise<string>;
  /** 读取某个目录下的直接子节点 */
  readDir(projectId: string, path: string): Promise<FileNode[]>;
  /** 获取单个节点信息 */
  stat(projectId: string, path: string): Promise<FileNode | null>;
  /** 递归获取项目下所有文件（扁平列表） */
  listAllFiles(projectId: string): Promise<FileNode[]>;

  // ---- 写操作 ----
  /** 写入文件，不存在则创建，存在则覆盖 */
  writeFile(projectId: string, path: string, content: string): Promise<FileNode>;
  /** 创建目录（递归创建父目录） */
  mkdir(projectId: string, path: string): Promise<FileNode>;
  /** 删除文件或目录（目录递归删除） */
  delete(projectId: string, path: string): Promise<void>;
  /** 重命名 / 移动 */
  rename(projectId: string, oldPath: string, newPath: string): Promise<FileNode>;
  /** 批量写入多个文件（原子操作，要么全成功要么全失败） */
  batchWrite(
    projectId: string,
    items: Array<{ path: string; content: string }>,
  ): Promise<FileNode[]>;
}
