import type {
  ProjectSnapshot,
  ProjectSnapshotStore,
} from "./project-types";

/** 内存项目快照存储。测试 / SSR 用。 */
export class MemoryProjectSnapshotStore implements ProjectSnapshotStore {
  readonly name = "memory";

  private snapshots = new Map<string, ProjectSnapshot>();

  async append(snapshot: ProjectSnapshot): Promise<void> {
    this.snapshots.set(snapshot.id, { ...snapshot, files: snapshot.files.map((f) => ({ ...f })) });
  }

  async get(id: string): Promise<ProjectSnapshot | null> {
    const snap = this.snapshots.get(id);
    return snap ? { ...snap, files: snap.files.map((f) => ({ ...f })) } : null;
  }

  async listByProject(projectId: string): Promise<ProjectSnapshot[]> {
    return [...this.snapshots.values()]
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({ ...s, files: s.files.map((f) => ({ ...f })) }));
  }

  async deleteSnapshots(ids: string[]): Promise<void> {
    for (const id of ids) this.snapshots.delete(id);
  }

  async purgeProject(projectId: string): Promise<void> {
    for (const [id, s] of this.snapshots) {
      if (s.projectId === projectId) this.snapshots.delete(id);
    }
  }
}
