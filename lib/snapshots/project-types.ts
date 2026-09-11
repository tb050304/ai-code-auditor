/** 项目级快照来源 */
export type ProjectSnapshotSource =
  /** 用户手动创建的标签 */
  | "manual"
  /** 恢复前自动备份当前状态（分支思想：恢复不丢分支） */
  | "restore-backup"
  /** 第三阶段预留：批量自动修复前 */
  | "auto-fix-batch"
  /** 第三阶段预留：Agent 修改前 */
  | "agent";

/** 项目快照中的单个文件（全量内容） */
export interface ProjectSnapshotFile {
  path: string;
  content: string;
}

/** 项目级快照：整个项目某一时刻的完整状态（打标签） */
export interface ProjectSnapshot {
  id: string;
  projectId: string;
  /** 标签名，如 "修复前"、"v1-原始版本" */
  name: string;
  description?: string;
  createdAt: number;
  source: ProjectSnapshotSource;
  /** 快照包含的全部文件 */
  files: ProjectSnapshotFile[];
  /** 统计信息，列表展示不用加载 files */
  fileCount: number;
  /** 总字符数 */
  totalSize: number;
}

/** 创建项目快照的元数据 */
export interface ProjectSnapshotMeta {
  name: string;
  description?: string;
  source: ProjectSnapshotSource;
}

/**
 * 项目快照存储接口。
 * 与文件快照同一数据库（不同 object store），列表按 createdAt 倒序（新 → 旧）。
 */
export interface ProjectSnapshotStore {
  readonly name: string;

  append(snapshot: ProjectSnapshot): Promise<void>;
  get(id: string): Promise<ProjectSnapshot | null>;
  listByProject(projectId: string): Promise<ProjectSnapshot[]>;
  deleteSnapshots(ids: string[]): Promise<void>;
  /** 删除项目全部快照 */
  purgeProject(projectId: string): Promise<void>;
}

/**
 * 项目快照管理器访问 VFS 的最小接口（依赖倒置，不直接依赖 VfsBackend）。
 * 由调用方注入实现，保持核心逻辑可独立测试。
 */
export interface ProjectIo {
  /** 项目下所有文件路径 */
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** 删除单个文件 */
  deleteFile(path: string): Promise<void>;
  /** 批量写入文件 */
  writeFiles(items: Array<{ path: string; content: string }>): Promise<void>;
}
