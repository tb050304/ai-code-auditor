/**
 * 增量快照存储装饰器（Day 13）。
 *
 * 包裹任意 SnapshotStore（内存 / IndexedDB），对上层 SnapshotManager 完全透明：
 * - append：按 decideEncoding 把全量快照转成 full / delta 记录落盘
 * - get / list*：沿 baseSnapshotId 链把 delta 还原成完整内容返回
 * - deleteSnapshots：淘汰旧快照前修复增量链——
 *   delta 的基准是时间线上更早的相邻记录，而淘汰从最旧开始，
 *   删除前先把"基准即将消失"的存活后继记录重写为 full，链永远不断
 *
 * 不变式：
 * - 还原深度 ≤ DELTA_MAX_CHAIN（周期检查点；淘汰修复只会让链更短）
 * - 淘汰后数量上限精确保持（修复是重写不是新增）
 */
import type { FileSnapshot, SnapshotStore } from "./types";
import {
  applyPatch,
  decideEncoding,
  deserializePatch,
  DELTA_MAX_CHAIN,
} from "./encoding";

export class DeltaSnapshotStore implements SnapshotStore {
  readonly name: string;

  constructor(private readonly inner: SnapshotStore) {
    this.name = `${inner.name}+delta`;
  }

  // ---------- 写入：全量 → full/delta ----------

  async append(snapshot: FileSnapshot): Promise<void> {
    // 幂等保护：理论上 manager 只传 full；已编码记录直接落盘（如修链重写）
    if (snapshot.encoding === "delta") {
      await this.inner.append(snapshot);
      return;
    }

    const rawList = await this.inner.listByFile(snapshot.projectId, snapshot.path);
    const newest = rawList[rawList.length - 1];

    let record: FileSnapshot;
    if (!newest) {
      // 该文件首条快照：全量起点
      record = { ...snapshot, encoding: "full", chainLength: 0, storedSize: snapshot.content.length };
    } else {
      const baseChainLength = newest.chainLength ?? 0;
      // 基准内容也可能是 delta，先还原（单条深度 ≤ DELTA_MAX_CHAIN）
      const baseText = await this.resolveContent(newest);
      const decision = decideEncoding({
        fullSize: snapshot.content.length,
        baseChainLength,
        snapshotText: snapshot.content,
        baseText,
      });

      if (decision.mode === "delta" && decision.patch) {
        record = {
          ...snapshot,
          content: "", // 原文不入库
          encoding: "delta",
          baseSnapshotId: newest.id,
          patch: decision.patch,
          chainLength: baseChainLength + 1,
          storedSize: decision.patch.length,
        };
      } else {
        // 全量检查点
        record = {
          ...snapshot,
          encoding: "full",
          chainLength: 0,
          storedSize: snapshot.content.length,
        };
      }
    }

    await this.inner.append(record);
  }

  // ---------- 读取：delta → 完整内容（透明） ----------

  async get(id: string): Promise<FileSnapshot | null> {
    const raw = await this.inner.get(id);
    if (!raw) return null;
    return this.decodeRecord(raw);
  }

  async listByFile(projectId: string, path: string): Promise<FileSnapshot[]> {
    const rawList = await this.inner.listByFile(projectId, path);
    return this.decodeList(rawList);
  }

  async listByProject(projectId: string): Promise<FileSnapshot[]> {
    const rawList = await this.inner.listByProject(projectId);
    return this.decodeList(rawList);
  }

  // ---------- 其余接口委托 ----------

  countByFile(projectId: string, path: string): Promise<number> {
    return this.inner.countByFile(projectId, path);
  }

  async deleteSnapshots(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.repairChains(ids);
    await this.inner.deleteSnapshots(ids);
  }

  migratePath(projectId: string, oldPath: string, newPath: string): Promise<void> {
    // baseSnapshotId 是记录自身 ID，不随路径变化，直接迁移即可
    return this.inner.migratePath(projectId, oldPath, newPath);
  }

  purgeProject(projectId: string): Promise<void> {
    return this.inner.purgeProject(projectId);
  }

  // ---------- 内部实现 ----------

  /**
   * 删除前修链：对每个受影响文件，找到"基准在删除集合中、但自身存活"的记录，
   * 在删除真正发生前把它的完整内容解析出来并重写为 full（同 ID put）。
   */
  private async repairChains(ids: string[]): Promise<void> {
    const deleting = new Set(ids);

    // 收集受影响的 (projectId, path) 分组（被删记录可能跨文件）
    const groups = new Map<string, { projectId: string; path: string }>();
    for (const id of ids) {
      const raw = await this.inner.get(id);
      if (raw) groups.set(JSON.stringify([raw.projectId, raw.path]), { projectId: raw.projectId, path: raw.path });
    }

    for (const { projectId, path } of groups.values()) {
      const rawList = await this.inner.listByFile(projectId, path);
      for (const raw of rawList) {
        if (
          raw.encoding === "delta" &&
          raw.baseSnapshotId &&
          deleting.has(raw.baseSnapshotId) &&
          !deleting.has(raw.id)
        ) {
          // 此刻基准记录物理上还在，可以正常沿链解析
          const content = await this.resolveContent(raw);
          await this.inner.append({
            ...raw,
            content,
            encoding: "full",
            baseSnapshotId: undefined,
            patch: undefined,
            chainLength: 0,
            storedSize: content.length,
          });
        }
      }
    }
  }

  /** 批量解码：同一批内按 ID 缓存基准内容，避免长链重复解析 O(k²) */
  private async decodeList(rawList: FileSnapshot[]): Promise<FileSnapshot[]> {
    const cache = new Map<string, Promise<string>>();
    return Promise.all(rawList.map((raw) => this.decodeRecord(raw, cache)));
  }

  private async decodeRecord(
    raw: FileSnapshot,
    cache?: Map<string, Promise<string>>,
  ): Promise<FileSnapshot> {
    if (raw.encoding === "full") return raw;
    const content = await this.resolveContent(raw, cache, 0);
    // 保留 encoding/patch 等元数据（UI 需要展示"增量"与实际占用），仅填充完整内容
    return { ...raw, content };
  }

  /**
   * 沿基准链解析完整内容。
   * depth 仅用于防御异常数据（正常链长 ≤ DELTA_MAX_CHAIN）。
   */
  private resolveContent(
    raw: FileSnapshot,
    cache?: Map<string, Promise<string>>,
    depth = 0,
  ): Promise<string> {
    if (raw.encoding === "full") return Promise.resolve(raw.content);
    if (depth > DELTA_MAX_CHAIN + 2) {
      return Promise.reject(new Error(`快照增量链过长（id=${raw.id}），数据可能损坏`));
    }
    if (!raw.baseSnapshotId || !raw.patch) {
      return Promise.reject(new Error(`增量快照缺少基准或补丁（id=${raw.id}）`));
    }

    const existing = cache?.get(raw.id);
    if (existing) return existing;

    const promise = (async () => {
      const base = await this.inner.get(raw.baseSnapshotId!);
      if (!base) throw new Error(`增量快照基准丢失（id=${raw.id}，base=${raw.baseSnapshotId}）`);
      const baseText = await this.resolveContent(base, cache, depth + 1);
      return applyPatch(baseText, deserializePatch(raw.patch!));
    })();
    cache?.set(raw.id, promise);
    return promise;
  }
}
