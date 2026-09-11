import type {
  ProjectIo,
  ProjectSnapshot,
  ProjectSnapshotMeta,
  ProjectSnapshotStore,
} from "./project-types";

/** 每个项目默认保留的项目级快照上限（超出淘汰最旧的） */
export const DEFAULT_MAX_PROJECT_SNAPSHOTS = 20;

function makeId(seq: number): string {
  return `psnap-${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface RestoreResult {
  /** 恢复的快照 */
  snapshot: ProjectSnapshot;
  /** 恢复前自动备份当前状态生成的快照（分支可滚回） */
  backup: ProjectSnapshot | null;
  /** 本次删除的多余文件数 */
  deletedFiles: number;
  /** 本次写入的文件数 */
  writtenFiles: number;
}

/**
 * 项目快照管理器：整个项目打版本标签 + 分支思想。
 *
 * 分支模型（不是 git 树，是线性可回溯链）：
 * - 任何时候 createSnapshot = 给当前状态打一个可回退的标签
 * - restore = 工作区回到某个标签；恢复前当前状态自动存为 restore-backup 标签
 * - 因此任何时刻的任何状态都能找回，信息零丢失
 */
export class ProjectSnapshotManager {
  private seq = 0;
  /** 上一次分配的时间戳：保证同实例内严格递增，避免同一毫秒内多个快照排序不稳定 */
  private lastTs = 0;

  constructor(
    private store: ProjectSnapshotStore,
    private maxPerProject: number = DEFAULT_MAX_PROJECT_SNAPSHOTS,
  ) {}

  /**
   * 给项目当前状态打快照。
   * @param io 由调用方注入的 VFS 读取器
   */
  async createSnapshot(
    projectId: string,
    meta: ProjectSnapshotMeta,
    io: ProjectIo,
  ): Promise<ProjectSnapshot> {
    const paths = await io.listFiles();
    const files: ProjectSnapshot["files"] = [];
    let totalSize = 0;

    for (const path of paths) {
      const content = await io.readFile(path);
      files.push({ path, content });
      totalSize += content.length;
    }

    return this.persist(projectId, meta, files, totalSize);
  }

  /** 列出项目的所有快照（新 → 旧） */
  async listSnapshots(projectId: string): Promise<ProjectSnapshot[]> {
    return this.store.listByProject(projectId);
  }

  /** 读取单条快照 */
  async getSnapshot(id: string): Promise<ProjectSnapshot | null> {
    return this.store.get(id);
  }

  /** 删除单条快照 */
  async deleteSnapshot(id: string): Promise<void> {
    await this.store.deleteSnapshots([id]);
  }

  /**
   * 恢复项目到指定快照（覆盖式：项目变成快照时的样子）。
   *
   * 流程：
   * 1. 读目标快照
   * 2. 读当前全部文件内容，若有差异，先自动存一份 restore-backup 快照
   * 3. 删除快照中不存在的文件，写入快照中的所有文件
   *
   * @returns 恢复结果；快照不存在返回 null
   */
  async restore(projectId: string, snapshotId: string, io: ProjectIo): Promise<RestoreResult | null> {
    const target = await this.store.get(snapshotId);
    if (!target) return null;

    // 当前状态 → 用于对比和备份
    const currentPaths = await io.listFiles();
    const currentFiles = new Map<string, string>();
    for (const path of currentPaths) {
      currentFiles.set(path, await io.readFile(path));
    }

    const targetMap = new Map(target.files.map((f) => [f.path, f.content]));

    // 判断是否有差异（文件集合一致且内容全部相同 = 无需恢复）
    let hasDiff =
      currentFiles.size !== targetMap.size ||
      [...currentFiles.keys()].some((p) => !targetMap.has(p));
    if (!hasDiff) {
      for (const [path, content] of currentFiles) {
        if (targetMap.get(path) !== content) {
          hasDiff = true;
          break;
        }
      }
    }

    // 恢复前自动备份当前状态（无差异则跳过，避免产生空备份）
    let backup: ProjectSnapshot | null = null;
    if (hasDiff) {
      const backupFiles = [...currentFiles].map(([path, content]) => ({ path, content }));
      const totalSize = backupFiles.reduce((sum, f) => sum + f.content.length, 0);
      backup = await this.persist(projectId, {
        name: `恢复到「${target.name}」前`,
        description: "恢复前自动备份",
        source: "restore-backup",
      }, backupFiles, totalSize);
    }

    // 覆盖式恢复：删多余 → 写全部（无差异时跳过，不做无谓 IO）
    let deletedFiles = 0;
    let writtenFiles = 0;
    if (hasDiff) {
      for (const path of currentFiles.keys()) {
        if (!targetMap.has(path)) {
          await io.deleteFile(path);
          deletedFiles++;
        }
      }

      if (target.files.length > 0) {
        await io.writeFiles(target.files.map((f) => ({ path: f.path, content: f.content })));
        writtenFiles = target.files.length;
      }
    }

    return { snapshot: target, backup, deletedFiles, writtenFiles };
  }

  /** 项目删除时清空其全部快照 */
  async purgeProject(projectId: string): Promise<void> {
    await this.store.purgeProject(projectId);
  }

  /** 强制执行单项目快照上限，超出淘汰最旧的 */
  private async enforceCap(projectId: string): Promise<void> {
    const list = await this.store.listByProject(projectId);
    if (list.length <= this.maxPerProject) return;

    // list 是新 → 旧，淘汰尾部最旧的
    const excess = list.length - this.maxPerProject;
    const toDelete = list.slice(list.length - excess).map((s) => s.id);
    await this.store.deleteSnapshots(toDelete);
  }

  /** 构建快照并落库（含上限淘汰） */
  private async persist(
    projectId: string,
    meta: ProjectSnapshotMeta,
    files: ProjectSnapshot["files"],
    totalSize: number,
  ): Promise<ProjectSnapshot> {
    const ts = Math.max(Date.now(), this.lastTs + 1);
    this.lastTs = ts;

    const snapshot: ProjectSnapshot = {
      id: makeId(this.seq++),
      projectId,
      name: meta.name,
      description: meta.description,
      createdAt: ts,
      source: meta.source,
      files,
      fileCount: files.length,
      totalSize,
    };

    await this.store.append(snapshot);
    await this.enforceCap(projectId);
    return snapshot;
  }
}
