import { describe, it, expect, beforeEach } from "vitest";
import { MemorySnapshotStore } from "@/lib/snapshots/memory-store";
import { SnapshotManager, DEFAULT_MAX_SNAPSHOTS_PER_FILE } from "@/lib/snapshots/history";
import type { SnapshotMeta } from "@/lib/snapshots/types";

const PROJECT = "proj-1";
const PATH = "/src/a.ts";

const META: SnapshotMeta = { source: "manual-save", description: "测试快照" };

describe("SnapshotManager - 捕获快照", () => {
  let store: MemorySnapshotStore;
  let manager: SnapshotManager;

  beforeEach(() => {
    store = new MemorySnapshotStore();
    manager = new SnapshotManager(store);
  });

  it("覆盖前捕获旧内容，元数据完整", async () => {
    const snap = await manager.captureBeforeWrite(PROJECT, PATH, "old content", META);

    expect(snap).not.toBeNull();
    expect(snap!.projectId).toBe(PROJECT);
    expect(snap!.path).toBe(PATH);
    expect(snap!.content).toBe("old content");
    expect(snap!.encoding).toBe("full");
    expect(snap!.source).toBe("manual-save");
    expect(snap!.description).toBe("测试快照");
    expect(snap!.size).toBe("old content".length);
    expect(snap!.createdAt).toBeGreaterThan(0);
  });

  it("新建文件（oldContent=null）不建快照", async () => {
    const snap = await manager.captureBeforeWrite(PROJECT, PATH, null, META);
    expect(snap).toBeNull();
    expect(await manager.listHistory(PROJECT, PATH)).toHaveLength(0);
  });

  it("内容与最近一次快照相同时跳过（no-op 保存不产生垃圾快照）", async () => {
    await manager.captureBeforeWrite(PROJECT, PATH, "v1", META);
    await manager.captureBeforeWrite(PROJECT, PATH, "v2", META);
    // 再次以 v2 为旧内容保存（内容没变）→ 跳过，历史仍是 [v1, v2]
    const snap = await manager.captureBeforeWrite(PROJECT, PATH, "v2", META);
    expect(snap).toBeNull();
    expect(await manager.listHistory(PROJECT, PATH)).toHaveLength(2);
  });

  it("多次修改产生按时间升序的历史栈", async () => {
    await manager.captureBeforeWrite(PROJECT, PATH, "v1", META);
    await manager.captureBeforeWrite(PROJECT, PATH, "v2", META);
    await manager.captureBeforeWrite(PROJECT, PATH, "v3", META);

    const history = await manager.listHistory(PROJECT, PATH);
    expect(history.map((s) => s.content)).toEqual(["v1", "v2", "v3"]);
  });

  it("不同文件的快照互相隔离", async () => {
    await manager.captureBeforeWrite(PROJECT, PATH, "a", META);
    await manager.captureBeforeWrite(PROJECT, "/src/b.ts", "b", META);

    expect(await manager.listHistory(PROJECT, PATH)).toHaveLength(1);
    expect(await manager.listHistory(PROJECT, "/src/b.ts")).toHaveLength(1);
  });
});

describe("SnapshotManager - 数量上限", () => {
  it("默认上限 50，超出淘汰最旧的", async () => {
    const store = new MemorySnapshotStore();
    const manager = new SnapshotManager(store); // 默认上限

    for (let i = 0; i < DEFAULT_MAX_SNAPSHOTS_PER_FILE + 10; i++) {
      await manager.captureBeforeWrite(PROJECT, PATH, `v${i}`, META);
    }

    const history = await manager.listHistory(PROJECT, PATH);
    expect(history).toHaveLength(DEFAULT_MAX_SNAPSHOTS_PER_FILE);
    // 最旧的 v0..v9 被淘汰，剩下 v10..v59
    expect(history[0].content).toBe("v10");
    expect(history[history.length - 1].content).toBe(`v${DEFAULT_MAX_SNAPSHOTS_PER_FILE + 9}`);
  });

  it("自定义上限生效", async () => {
    const store = new MemorySnapshotStore();
    const manager = new SnapshotManager(store, 3);

    for (let i = 0; i < 5; i++) {
      await manager.captureBeforeWrite(PROJECT, PATH, `v${i}`, META);
    }

    const history = await manager.listHistory(PROJECT, PATH);
    expect(history.map((s) => s.content)).toEqual(["v2", "v3", "v4"]);
  });
});

describe("SnapshotManager - 回退", () => {
  let store: MemorySnapshotStore;
  let manager: SnapshotManager;

  beforeEach(() => {
    store = new MemorySnapshotStore();
    manager = new SnapshotManager(store);
  });

  it("prepareRestore 返回快照内容，并把当前状态存为 rollback 快照", async () => {
    await manager.captureBeforeWrite(PROJECT, PATH, "v1", META);
    const target = (await manager.listHistory(PROJECT, PATH))[0];

    const result = await manager.prepareRestore(PROJECT, target.id, async () => "current");

    expect(result).not.toBeNull();
    expect(result!.content).toBe("v1");
    expect(result!.snapshot.id).toBe(target.id);

    // 回退本身也产生了一条 rollback 快照（内容是回退前的 current）
    const history = await manager.listHistory(PROJECT, PATH);
    expect(history).toHaveLength(2);
    expect(history[1].source).toBe("rollback");
    expect(history[1].content).toBe("current");
  });

  it("当前内容与目标一致时返回 null，不产生 rollback 快照", async () => {
    await manager.captureBeforeWrite(PROJECT, PATH, "v1", META);
    const target = (await manager.listHistory(PROJECT, PATH))[0];

    const result = await manager.prepareRestore(PROJECT, target.id, async () => "v1");

    expect(result).toBeNull();
    expect(await manager.listHistory(PROJECT, PATH)).toHaveLength(1);
  });

  it("快照 ID 不存在时返回 null", async () => {
    const result = await manager.prepareRestore(PROJECT, "no-such-id", async () => "current");
    expect(result).toBeNull();
  });

  it("rollback 快照也计入数量上限", async () => {
    const store = new MemorySnapshotStore();
    const manager = new SnapshotManager(store, 2);

    await manager.captureBeforeWrite(PROJECT, PATH, "v1", META);
    const target = (await manager.listHistory(PROJECT, PATH))[0];
    await manager.prepareRestore(PROJECT, target.id, async () => "current");
    await manager.captureBeforeWrite(PROJECT, PATH, "extra", META);

    const history = await manager.listHistory(PROJECT, PATH);
    expect(history.length).toBeLessThanOrEqual(2);
  });
});

describe("SnapshotManager - 迁移与清理", () => {
  let store: MemorySnapshotStore;
  let manager: SnapshotManager;

  beforeEach(() => {
    store = new MemorySnapshotStore();
    manager = new SnapshotManager(store);
  });

  it("migratePath 把历史迁移到新路径", async () => {
    await manager.captureBeforeWrite(PROJECT, PATH, "v1", META);

    await manager.migratePath(PROJECT, PATH, "/src/renamed.ts");

    expect(await manager.listHistory(PROJECT, PATH)).toHaveLength(0);
    const migrated = await manager.listHistory(PROJECT, "/src/renamed.ts");
    expect(migrated).toHaveLength(1);
    expect(migrated[0].content).toBe("v1");
  });

  it("purgeProject 清空项目全部快照，不影响其他项目", async () => {
    await manager.captureBeforeWrite(PROJECT, PATH, "v1", META);
    await manager.captureBeforeWrite("proj-2", "/x.ts", "v2", META);

    await manager.purgeProject(PROJECT);

    expect(await store.listByProject(PROJECT)).toHaveLength(0);
    expect(await store.listByProject("proj-2")).toHaveLength(1);
  });
});
