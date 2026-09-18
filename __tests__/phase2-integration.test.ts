/**
 * 第二阶段端到端链路测试（Day 14）：
 * 修改 → 写前快照 → LCS diff/合并 → 回滚 → 回滚快照 → 再恢复。
 *
 * 存储用真实的 DeltaSnapshotStore(Memory)，VFS 用 Map 模拟，
 * 写入/回退流程与 hooks/useProject 的编排完全一致。
 */
import { describe, it, expect } from "vitest";
import { MemorySnapshotStore, DeltaSnapshotStore, SnapshotManager } from "@/lib/snapshots";
import type { SnapshotMeta } from "@/lib/snapshots";
import {
  computeChunks,
  getChangeChunks,
  mergeLines,
  splitLines,
} from "@/lib/diff/lines";

const PROJECT = "proj";
const PATH = "/src/app.ts";

/** 与 useProject 相同编排的最小 VFS + 快照联动 */
function createHarness(maxPerFile?: number) {
  const vfs = new Map<string, string>();
  const manager = new SnapshotManager(
    new DeltaSnapshotStore(new MemorySnapshotStore()),
    maxPerFile,
  );

  /** 覆盖写入：写前捕获旧内容（与 useProject.writeFile 一致） */
  async function write(content: string, meta?: SnapshotMeta) {
    const exists = vfs.has(PATH);
    if (exists) {
      const old = vfs.get(PATH)!;
      if (old !== content) {
        await manager.captureBeforeWrite(
          PROJECT,
          PATH,
          old,
          meta ?? { source: "manual-save", description: "保存前自动快照" },
        );
      }
    }
    vfs.set(PATH, content);
  }

  /** 回滚到指定快照（与 useProject.restoreFileSnapshot 一致，含已删除恢复） */
  async function restore(snapshotId: string) {
    const target = await manager.getSnapshot(snapshotId);
    if (!target) throw new Error("快照不存在");
    const current = vfs.has(PATH) ? vfs.get(PATH)! : null;
    if (current === target.content) return target;
    if (current !== null) {
      await manager.captureBeforeWrite(PROJECT, PATH, current, {
        source: "rollback",
        description: "回滚前自动快照",
      });
    }
    vfs.set(PATH, target.content);
    return target;
  }

  /** 模拟 DiffViewer 的 chunk 合并：接受指定序号的变更块，其余保留旧版 */
  function merge(oldText: string, newText: string, acceptedIds: number[]): string {
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);
    const chunks = computeChunks(oldLines, newLines);
    return mergeLines(oldLines, newLines, chunks, new Set(acceptedIds)).join("\n");
  }

  return { vfs, manager, write, restore, merge };
}

describe("第二阶段全链路：修改 → 快照 → diff → 回退 → 恢复", () => {
  it("完整往返：三次修改、部分接受合并、回滚后可再滚回", async () => {
    const { vfs, manager, write, restore, merge } = createHarness();

    // 1) 新建文件（不产生快照）→ 两次修改（各捕获一次写前快照）；改动行不相邻以产生两个 hunk
    await write("l1\nl2\nl3\nl4\nl5");
    await write("l1\nl2-v2\nl3\nl4\nl5");
    await write("l1\nl2-v2\nl3\nl4-v3\nl5");

    const history1 = await manager.listHistory(PROJECT, PATH);
    expect(history1.map((s) => s.content)).toEqual([
      "l1\nl2\nl3\nl4\nl5", // v1：第二次写入前捕获
      "l1\nl2-v2\nl3\nl4\nl5", // v2：第三次写入前捕获
    ]);
    expect(vfs.get(PATH)).toBe("l1\nl2-v2\nl3\nl4-v3\nl5"); // 当前 = v3

    // 2) diff：最旧快照 v1 vs 当前 v3，两处改动；只接受第一处（l2），拒绝第二处（l4）
    const v1 = history1[0].content;
    const v3 = vfs.get(PATH)!;
    const chunks = getChangeChunks(computeChunks(splitLines(v1), splitLines(v3)));
    expect(chunks).toHaveLength(2);
    const merged = merge(v1, v3, [chunks[0].id!]);
    expect(merged).toBe("l1\nl2-v2\nl3\nl4\nl5"); // l2 取新、l4 留旧

    // 3) 应用合并结果（走 diff-apply 写前快照）
    await write(merged, { source: "diff-apply", description: "Diff 合并应用前自动快照" });
    expect(vfs.get(PATH)).toBe("l1\nl2-v2\nl3\nl4\nl5");

    // 4) 回滚到 v1：当前合并结果被自动存为 rollback 快照，文件回到 v1
    const history2 = await manager.listHistory(PROJECT, PATH);
    const v1Snap = history2[0];
    await restore(v1Snap.id);
    expect(vfs.get(PATH)).toBe("l1\nl2\nl3\nl4\nl5");

    const history3 = await manager.listHistory(PROJECT, PATH);
    expect(history3[history3.length - 1].source).toBe("rollback");

    // 5) 再滚回来：最新一条 rollback 快照内容就是回滚前的合并结果
    const rollbackSnap = history3[history3.length - 1];
    await restore(rollbackSnap.id);
    expect(vfs.get(PATH)).toBe("l1\nl2-v2\nl3\nl4\nl5");
  });

  it("删除文件后可通过历史快照恢复（无当前状态时不产生多余快照）", async () => {
    const { vfs, manager, write, restore } = createHarness();

    await write("a\nb\nc");
    await write("a\nb2\nc");
    const snap = (await manager.listHistory(PROJECT, PATH))[0];
    const beforeCount = (await manager.listHistory(PROJECT, PATH)).length;

    // 模拟文件被删除
    vfs.delete(PATH);
    await restore(snap.id);

    expect(vfs.get(PATH)).toBe("a\nb\nc");
    // 恢复已删除文件：没有"当前内容"可存，快照数量不变
    const after = await manager.listHistory(PROJECT, PATH);
    expect(after).toHaveLength(beforeCount);
  });

  it("no-op 保存不产生垃圾快照；内容相同的回滚不写入不快照", async () => {
    const { manager, write } = createHarness();

    await write("v1"); // v1 落盘（新建，无快照）
    await write("v2"); // 捕获 v1
    await write("v2"); // 内容未变 → 跳过
    expect(await manager.listHistory(PROJECT, PATH)).toHaveLength(1);

    const snap = (await manager.listHistory(PROJECT, PATH))[0]; // 目标 v1
    // 当前是 v2 ≠ 目标 → 返回待写入内容，并自动存 rollback 快照
    const result = await manager.prepareRestore(PROJECT, snap.id, async () => "v2");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("v1");
    // 当前已经是目标内容 → null（不写入、不产生快照）
    const noop = await manager.prepareRestore(PROJECT, snap.id, async () => snap.content);
    expect(noop).toBeNull();
  });
});
