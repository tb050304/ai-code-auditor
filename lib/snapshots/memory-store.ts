import type { FileSnapshot, SnapshotStore } from "./types";

/**
 * 内存快照存储。
 * 测试 / SSR 环境用；数据存进程内存，刷新即失。
 */
export class MemorySnapshotStore implements SnapshotStore {
  readonly name = "memory";

  private snapshots = new Map<string, FileSnapshot>();

  async append(snapshot: FileSnapshot): Promise<void> {
    this.snapshots.set(snapshot.id, { ...snapshot });
  }

  async get(id: string): Promise<FileSnapshot | null> {
    const snap = this.snapshots.get(id);
    return snap ? { ...snap } : null;
  }

  async listByFile(projectId: string, path: string): Promise<FileSnapshot[]> {
    return this.listBy((s) => s.projectId === projectId && s.path === path);
  }

  async listByProject(projectId: string): Promise<FileSnapshot[]> {
    return this.listBy((s) => s.projectId === projectId);
  }

  async countByFile(projectId: string, path: string): Promise<number> {
    let count = 0;
    for (const s of this.snapshots.values()) {
      if (s.projectId === projectId && s.path === path) count++;
    }
    return count;
  }

  async deleteSnapshots(ids: string[]): Promise<void> {
    for (const id of ids) this.snapshots.delete(id);
  }

  async migratePath(projectId: string, oldPath: string, newPath: string): Promise<void> {
    for (const s of this.snapshots.values()) {
      if (s.projectId === projectId && s.path === oldPath) {
        this.snapshots.set(s.id, { ...s, path: newPath });
      }
    }
  }

  async purgeProject(projectId: string): Promise<void> {
    for (const [id, s] of this.snapshots) {
      if (s.projectId === projectId) this.snapshots.delete(id);
    }
  }

  /** 通用列表：过滤 + 按 createdAt 升序 */
  private listBy(predicate: (s: FileSnapshot) => boolean): FileSnapshot[] {
    return [...this.snapshots.values()].filter(predicate).sort((a, b) => a.createdAt - b.createdAt);
  }
}
