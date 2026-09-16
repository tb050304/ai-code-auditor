/** 快照来源：谁触发了这次快照 */
export type SnapshotSource =
  /** 用户手动保存（Ctrl+S / Tab 菜单保存），自动捕获覆盖前的旧内容 */
  | "manual-save"
  /** AST 自动修复（第三阶段） */
  | "auto-fix"
  /** Agent 修改（第三阶段） */
  | "agent"
  /** 回退操作：回退前把当前状态存一份，保证历史不丢 */
  | "rollback"
  /** Diff 对比中应用合并结果（部分接受/全部接受）前自动捕获当前内容 */
  | "diff-apply"
  /** 导入项目时的初始快照（预留，当前导入不建快照） */
  | "import"
  /** 其他未知来源的兜底 */
  | "external";

/** 单个文件的快照记录 */
export interface FileSnapshot {
  /** 唯一 ID：projectId::path::createdAt::seq */
  id: string;
  /** 所属项目 ID */
  projectId: string;
  /** 文件绝对路径（规范化，以 / 开头） */
  path: string;
  /** 快照时的完整文件内容（encoding=full 时有值；delta 时为空串，内容由 patch 还原） */
  content: string;
  /**
   * 内容编码方式：
   * - full：完整内容
   * - delta：相对 baseSnapshotId（时间线上更早的相邻快照）的行级补丁，
   *   还原时沿 chainLength 链向上找到 full 检查点逐级打补丁
   */
  encoding: "full" | "delta";
  /** delta 编码：基准快照 ID（必须是同文件、时间线上更早的相邻存活快照） */
  baseSnapshotId?: string;
  /** delta 编码：序列化补丁（JSON，见 lib/snapshots/encoding.ts） */
  patch?: string;
  /** 距最近 full 检查点的链长：full=0，delta 逐级 +1；用于决定下一条是否做检查点 */
  chainLength?: number;
  /** 实际占用存储的字节近似值（full=内容长度，delta=补丁长度），用于容量展示 */
  storedSize?: number;
  /** 快照时间戳（ms） */
  createdAt: number;
  /** 快照来源 */
  source: SnapshotSource;
  /** 人类可读的描述（如 "保存前自动快照"、"修复 no-eval 前"） */
  description?: string;
  /** 内容长度（字符数），用于时间线展示，避免为了显示而加载 content */
  size: number;
}

/** 创建快照时的元数据（不含存储层生成的字段） */
export interface SnapshotMeta {
  source: SnapshotSource;
  description?: string;
}

/**
 * 快照存储后端接口。
 * 与 VfsBackend 同样的设计思路：上层逻辑只依赖此接口，
 * 内存实现给测试 / SSR 用，IndexedDB 实现给浏览器持久化用。
 *
 * 列表接口统一按 createdAt 升序返回（旧 → 新）。
 */
export interface SnapshotStore {
  /** 后端名称，用于调试 */
  readonly name: string;

  /** 追加一条快照 */
  append(snapshot: FileSnapshot): Promise<void>;
  /** 按 ID 读取快照，不存在返回 null */
  get(id: string): Promise<FileSnapshot | null>;
  /** 列出某个文件的所有快照（升序） */
  listByFile(projectId: string, path: string): Promise<FileSnapshot[]>;
  /** 列出某个项目下所有快照（升序） */
  listByProject(projectId: string): Promise<FileSnapshot[]>;
  /** 统计某个文件的快照数量 */
  countByFile(projectId: string, path: string): Promise<number>;
  /** 按 ID 批量删除 */
  deleteSnapshots(ids: string[]): Promise<void>;
  /** 文件重命名时迁移历史（旧路径 → 新路径） */
  migratePath(projectId: string, oldPath: string, newPath: string): Promise<void>;
  /** 删除整个项目的所有快照（项目删除时清理） */
  purgeProject(projectId: string): Promise<void>;
}
