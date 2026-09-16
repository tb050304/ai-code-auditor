import { describe, it, expect } from "vitest";
import {
  createPatch,
  applyPatch,
  serializePatch,
  deserializePatch,
  decideEncoding,
  DELTA_MIN_FULL_LENGTH,
  DELTA_MAX_CHAIN,
} from "@/lib/snapshots/encoding";
import { MemorySnapshotStore } from "@/lib/snapshots/memory-store";
import { DeltaSnapshotStore } from "@/lib/snapshots/delta-store";
import { SnapshotManager } from "@/lib/snapshots/history";
import type { SnapshotMeta } from "@/lib/snapshots/types";

const PROJECT = "proj-1";
const PATH = "/src/big.ts";
const META: SnapshotMeta = { source: "manual-save" };

/** 60 行、约 3KB 的版本；相邻版本只改一行（典型的小步编辑） */
function makeVersion(mutatedLine: number, marker: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 60; i++) {
    lines.push(
      i === mutatedLine
        ? `export const value_${i} = "${marker}"; // 这一行在版本之间变化 padding padding`
        : `export const value_${i} = ${i}; // 保持不变的稳定内容 padding padding padding`,
    );
  }
  return lines.join("\n");
}

function capture(manager: SnapshotManager, content: string) {
  return manager.captureBeforeWrite(PROJECT, PATH, content, META);
}

// ---------- 纯函数：补丁编解码 ----------

describe("encoding - 补丁往返", () => {
  it("完全相同的文本：补丁只有 equal 操作，往返一致", () => {
    const text = "a\nb\nc";
    const patch = createPatch(text, text);
    expect(applyPatch(text, patch)).toBe(text);
    expect(patch.ops.every((op) => op.t === "e")).toBe(true);
  });

  it("修改中间一行：往返还原快照原文", () => {
    const base = ["l0", "l1", "l2", "l3", "l4"].join("\n");
    const snapshot = ["l0", "l1-CHANGED", "l2", "l3", "l4"].join("\n");
    const patch = createPatch(snapshot, base);
    expect(applyPatch(base, patch)).toBe(snapshot);
  });

  it("纯插入与纯删除都能往返", () => {
    const base = ["a", "b", "c"].join("\n");
    const inserted = ["a", "b", "b2", "c"].join("\n");
    expect(applyPatch(base, createPatch(inserted, base))).toBe(inserted);

    const deleted = ["a", "c"].join("\n");
    expect(applyPatch(base, createPatch(deleted, base))).toBe(deleted);
  });

  it("补丁序列化/反序列化后仍可正确应用（含 CRLF 归一化）", () => {
    const base = "line1\nline2\nline3";
    const snapshot = "line1\r\nline2-CHANGED\r\nline3";
    const json = serializePatch(createPatch(snapshot, base));
    const restored = applyPatch(base, deserializePatch(json));
    // 输出按 Monaco 约定归一化为 \n
    expect(restored).toBe("line1\nline2-CHANGED\nline3");
  });

  it("损坏的补丁 JSON 抛错", () => {
    expect(() => deserializePatch("{not json")).toThrow();
    expect(() => deserializePatch(JSON.stringify({ v: 2, ops: [] }))).toThrow();
  });
});

// ---------- 纯函数：编码决策 ----------

describe("decideEncoding", () => {
  it("无基准（首条快照）→ full", () => {
    expect(
      decideEncoding({ fullSize: 99999, baseChainLength: null, snapshotText: "x", baseText: null }).mode,
    ).toBe("full");
  });

  it("小于阈值的小文件 → full", () => {
    const text = "x".repeat(DELTA_MIN_FULL_LENGTH - 1);
    const d = decideEncoding({
      fullSize: text.length,
      baseChainLength: 0,
      snapshotText: text + "y",
      baseText: text,
    });
    expect(d.mode).toBe("full");
    expect(d.reason).toBe("below-min-size");
  });

  it("大文件小改动 → delta，且补丁远小于全量", () => {
    const base = makeVersion(0, "v0");
    const snap = makeVersion(1, "v1");
    const d = decideEncoding({
      fullSize: snap.length,
      baseChainLength: 0,
      snapshotText: snap,
      baseText: base,
    });
    expect(d.mode).toBe("delta");
    expect(d.patch!.length).toBeLessThan(snap.length * 0.2);
  });

  it("整文件重写（补丁不划算）→ full", () => {
    const base = makeVersion(0, "v0");
    // 内容完全不同、等长
    const snap = Array.from({ length: 60 }, (_, i) => `完全不同的第 ${i} 行内容 padding padding padding padding`).join("\n");
    const d = decideEncoding({
      fullSize: snap.length,
      baseChainLength: 0,
      snapshotText: snap,
      baseText: base,
    });
    expect(d.mode).toBe("full");
    expect(d.reason).toBe("patch-not-smaller");
  });

  it("到达检查点链长 → full", () => {
    const base = makeVersion(0, "v0");
    const snap = makeVersion(1, "v1");
    const d = decideEncoding({
      fullSize: snap.length,
      baseChainLength: DELTA_MAX_CHAIN - 1,
      snapshotText: snap,
      baseText: base,
    });
    expect(d.mode).toBe("full");
    expect(d.reason).toBe("checkpoint");
  });
});

// ---------- DeltaSnapshotStore 装饰器 ----------

describe("DeltaSnapshotStore - 透明编码与还原", () => {
  function setup() {
    const inner = new MemorySnapshotStore();
    const store = new DeltaSnapshotStore(inner);
    const manager = new SnapshotManager(store);
    return { inner, store, manager };
  }

  it("首条存全量；相邻大版本以 delta 落盘，但读取时透明还原", async () => {
    const { inner, manager } = setup();
    const v0 = makeVersion(0, "v0");
    const v1 = makeVersion(1, "v1");

    await capture(manager, v0);
    await capture(manager, v1);

    // 底层物理记录：第二条是 delta，原文不入库
    const raw = await inner.listByFile(PROJECT, PATH);
    expect(raw[0].encoding).toBe("full");
    expect(raw[1].encoding).toBe("delta");
    expect(raw[1].content).toBe("");
    expect(raw[1].baseSnapshotId).toBe(raw[0].id);
    expect(raw[1].chainLength).toBe(1);
    expect(raw[1].storedSize).toBeLessThan(v1.length * 0.2);

    // 上层通过装饰器读到的仍是完整内容
    const history = await manager.listHistory(PROJECT, PATH);
    expect(history.map((s) => s.content)).toEqual([v0, v1]);

    const byId = await manager.getSnapshot(raw[1].id);
    expect(byId!.content).toBe(v1);
  });

  it("每 8 条产生一个全量检查点（链不无限增长）", async () => {
    const { inner, manager } = setup();
    for (let i = 0; i < 9; i++) {
      await capture(manager, makeVersion(i % 60, `v${i}`));
    }
    const raw = await inner.listByFile(PROJECT, PATH);
    // v0=full(0)，v1..v7=delta(1..7)，v8 触发 checkpoint=full
    expect(raw.map((r) => r.encoding)).toEqual([
      "full",
      "delta", "delta", "delta", "delta", "delta", "delta", "delta",
      "full",
    ]);
    // 每条都能透明还原
    for (let i = 0; i < 9; i++) {
      expect((await manager.getSnapshot(raw[i].id))!.content).toBe(makeVersion(i % 60, `v${i}`));
    }
  });
});

describe("DeltaSnapshotStore - 数量上限与修链", () => {
  it("淘汰最旧快照时自动修复增量链，数量精确且内容不丢", async () => {
    const inner = new MemorySnapshotStore();
    const manager = new SnapshotManager(new DeltaSnapshotStore(inner), 3);
    const versions = Array.from({ length: 5 }, (_, i) => makeVersion(i % 60, `v${i}`));
    for (const v of versions) await capture(manager, v);

    // 上限精确为 3
    const history = await manager.listHistory(PROJECT, PATH);
    expect(history).toHaveLength(3);
    expect(history.map((s) => s.content)).toEqual(versions.slice(2));

    // 底层链也已修复：幸存的最旧记录被重写为 full（其基准已被淘汰）
    const raw = await inner.listByFile(PROJECT, PATH);
    expect(raw).toHaveLength(3);
    expect(raw[0].encoding).toBe("full");
    expect(raw[0].baseSnapshotId).toBeUndefined();
    expect(raw[0].content).toBe(versions[2]);
    // 后两条仍是 delta 且基准在幸存集合内
    expect(raw[1].encoding).toBe("delta");
    expect(raw[1].baseSnapshotId).toBe(raw[0].id);
    expect(raw[2].baseSnapshotId).toBe(raw[1].id);
  });
});

describe("DeltaSnapshotStore - 迁移与清理", () => {
  it("重命名迁移后增量快照仍可还原", async () => {
    const inner = new MemorySnapshotStore();
    const store = new DeltaSnapshotStore(inner);
    const manager = new SnapshotManager(store);
    const v0 = makeVersion(0, "v0");
    const v1 = makeVersion(1, "v1");
    await capture(manager, v0);
    await capture(manager, v1);

    await manager.migratePath(PROJECT, PATH, "/src/renamed.ts");

    const moved = await store.listByFile(PROJECT, "/src/renamed.ts");
    expect(moved.map((s) => s.content)).toEqual([v0, v1]);
    // delta 的基准 ID 不随路径改变
    expect(moved[1].baseSnapshotId).toBe(moved[0].id);
  });

  it("purgeProject 清空全部记录（含增量链）", async () => {
    const inner = new MemorySnapshotStore();
    const store = new DeltaSnapshotStore(inner);
    const manager = new SnapshotManager(store);
    await capture(manager, makeVersion(0, "v0"));
    await capture(manager, makeVersion(1, "v1"));

    await manager.purgeProject(PROJECT);
    expect(await inner.listByProject(PROJECT)).toHaveLength(0);
  });
});
