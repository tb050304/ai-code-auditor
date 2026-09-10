import type { FileSnapshot, SnapshotMeta, SnapshotStore } from "./types";

/** 每个文件默认保留的快照上限（超出淘汰最旧的） */
export const DEFAULT_MAX_SNAPSHOTS_PER_FILE = 50;

/** 生成快照 ID：同一路径同一毫秒内也用 seq 保证唯一 */
function makeId(seq: number): string {
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 快照管理器：文件历史栈的核心逻辑。
 *
 * 设计要点：
 * - 捕获时机是「覆盖写入之前」保存旧内容。这样时间线 = 所有历史状态，
 *   当前 VFS 内容 = 最新状态，两个来源拼起来正好是完整历史，没有缺口。
 * - 内容与上一次快照相同则跳过（no-op 保存不产生垃圾快照）。
 * - 每个文件最多保留 maxPerFile 份，超出淘汰最旧的。
 * - 回退 = 用快照内容覆盖 VFS；回退前自动把当前状态存为 rollback 快照，可再滚回来。
 */
export class SnapshotManager {
  private seq = 0;

  constructor(
    private store: SnapshotStore,
    private maxPerFile: number = DEFAULT_MAX_SNAPSHOTS_PER_FILE,
  ) {}

  /**
   * 捕获一次「覆盖前」的快照。
   * @param oldContent 即将被覆盖的内容；传 null 表示文件是新建的（无历史可存，跳过）
   * @returns 创建的快照；无需快照时返回 null
   */
  async captureBeforeWrite(
    projectId: string,
    path: string,
    oldContent: string | null,
    meta: SnapshotMeta,
  ): Promise<FileSnapshot | null> {
    // 新建文件没有旧内容，不建快照
    if (oldContent === null) return null;

    // 与该文件最近一次快照内容相同则跳过（no-op 保存）
    const existing = await this.store.listByFile(projectId, path);
    const newest = existing[existing.length - 1];
    if (newest && newest.content === oldContent) return null;

    const snapshot: FileSnapshot = {
      id: makeId(this.seq++),
      projectId,
      path,
      content: oldContent,
      encoding: "full",
      createdAt: Date.now(),
      source: meta.source,
      description: meta.description,
      size: oldContent.length,
    };

    await this.store.append(snapshot);
    await this.enforceCap(projectId, path);
    return snapshot;
  }

  /** 某个文件的完整历史（旧 → 新），不含 VFS 当前内容 */
  async listHistory(projectId: string, path: string): Promise<FileSnapshot[]> {
    return this.store.listByFile(projectId, path);
  }

  /** 读取单条快照 */
  async getSnapshot(id: string): Promise<FileSnapshot | null> {
    return this.store.get(id);
  }

  /**
   * 回退到指定快照。
   * 由调用方提供当前内容的读取器和写入器（回看 VfsBackend），本模块不直接依赖 VFS：
   * 1. 读取当前内容 → 若与目标快照不同，先存一份 rollback 快照（保证可滚回）
   * 2. 返回应当写入 VFS 的内容，由调用方执行写入
   *
   * @returns 实际写入 VFS 的内容；当前内容已与目标一致时返回 null（无需写入）
   */
  async prepareRestore(
    projectId: string,
    snapshotId: string,
    readCurrent: () => Promise<string>,
  ): Promise<{ content: string; snapshot: FileSnapshot } | null> {
    const target = await this.store.get(snapshotId);
    if (!target) return null;

    const current = await readCurrent();
    if (current === target.content) return null;

    // 回退也是一次修改：先把当前状态存起来，用户可以再滚回来
    await this.captureBeforeWrite(projectId, target.path, current, {
      source: "rollback",
      description: `回退前自动快照（目标：${new Date(target.createdAt).toLocaleString()}）`,
    });

    return { content: target.content, snapshot: target };
  }

  /** 文件重命名时迁移全部历史 */
  async migratePath(projectId: string, oldPath: string, newPath: string): Promise<void> {
    await this.store.migratePath(projectId, oldPath, newPath);
  }

  /** 项目删除时清空其全部快照 */
  async purgeProject(projectId: string): Promise<void> {
    await this.store.purgeProject(projectId);
  }

  /** 强制执行单文件快照上限，超出淘汰最旧的 */
  private async enforceCap(projectId: string, path: string): Promise<void> {
    const list = await this.store.listByFile(projectId, path);
    if (list.length <= this.maxPerFile) return;

    const excess = list.length - this.maxPerFile;
    const toDelete = list.slice(0, excess).map((s) => s.id);
    await this.store.deleteSnapshots(toDelete);
  }
}
