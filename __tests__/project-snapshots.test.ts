import { describe, it, expect, beforeEach } from "vitest";
import { ProjectSnapshotManager, DEFAULT_MAX_PROJECT_SNAPSHOTS } from "@/lib/snapshots/project-history";
import { MemoryProjectSnapshotStore } from "@/lib/snapshots/project-memory-store";
import type { ProjectIo } from "@/lib/snapshots/project-types";

const PROJECT = "proj-1";

/** 模拟 VFS：Map<path, content>，用于测试 manager 的创建与恢复 */
function makeVfs(initial: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initial));
  const io: ProjectIo = {
    listFiles: async () => [...files.keys()].sort(),
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`NOT_FOUND: ${path}`);
      return content;
    },
    deleteFile: async (path) => {
      if (!files.delete(path)) throw new Error(`NOT_FOUND: ${path}`);
    },
    writeFiles: async (items) => {
      for (const item of items) files.set(item.path, item.content);
    },
  };
  return { files, io };
}

describe("ProjectSnapshotManager - 创建快照", () => {
  let store: MemoryProjectSnapshotStore;
  let manager: ProjectSnapshotManager;

  beforeEach(() => {
    store = new MemoryProjectSnapshotStore();
    manager = new ProjectSnapshotManager(store);
  });

  it("捕获项目全部文件内容 + 元数据 + 统计", async () => {
    const { io } = makeVfs({ "/a.ts": "aaa", "/src/b.ts": "bbbbb" });

    const snap = await manager.createSnapshot(PROJECT, { name: "v1", source: "manual" }, io);

    expect(snap.projectId).toBe(PROJECT);
    expect(snap.name).toBe("v1");
    expect(snap.source).toBe("manual");
    expect(snap.fileCount).toBe(2);
    expect(snap.totalSize).toBe(3 + 5);
    expect(snap.files).toHaveLength(2);
    expect(snap.files.find((f) => f.path === "/a.ts")?.content).toBe("aaa");
    expect(snap.files.find((f) => f.path === "/src/b.ts")?.content).toBe("bbbbb");
  });

  it("空项目可以创建快照", async () => {
    const { io } = makeVfs({});
    const snap = await manager.createSnapshot(PROJECT, { name: "空项目", source: "manual" }, io);

    expect(snap.fileCount).toBe(0);
    expect(snap.files).toHaveLength(0);
    expect(snap.totalSize).toBe(0);
  });

  it("列表按时间倒序（新 → 旧）", async () => {
    const { io } = makeVfs({ "/a.ts": "v" });
    await manager.createSnapshot(PROJECT, { name: "first", source: "manual" }, io);
    await manager.createSnapshot(PROJECT, { name: "second", source: "manual" }, io);

    const list = await manager.listSnapshots(PROJECT);
    expect(list.map((s) => s.name)).toEqual(["second", "first"]);
  });

  it("不同项目的快照互相隔离", async () => {
    const vfs1 = makeVfs({ "/a.ts": "1" });
    const vfs2 = makeVfs({ "/b.ts": "2" });
    await manager.createSnapshot(PROJECT, { name: "p1", source: "manual" }, vfs1.io);
    await manager.createSnapshot("proj-2", { name: "p2", source: "manual" }, vfs2.io);

    expect(await manager.listSnapshots(PROJECT)).toHaveLength(1);
    expect(await manager.listSnapshots("proj-2")).toHaveLength(1);
  });
});

describe("ProjectSnapshotManager - 恢复", () => {
  let store: MemoryProjectSnapshotStore;
  let manager: ProjectSnapshotManager;

  beforeEach(() => {
    store = new MemoryProjectSnapshotStore();
    manager = new ProjectSnapshotManager(store);
  });

  it("覆盖式恢复：删多余、改内容、补缺失", async () => {
    const original = makeVfs({ "/a.ts": "原始a", "/b.ts": "原始b" });
    const snap = await manager.createSnapshot(PROJECT, { name: "v1", source: "manual" }, original.io);

    // 当前状态：a 被改、b 被删、c 是新增
    const current = makeVfs({ "/a.ts": "被修改", "/c.ts": "新增" });
    const result = await manager.restore(PROJECT, snap.id, current.io);

    expect(result).not.toBeNull();
    expect(result!.deletedFiles).toBe(1); // /c.ts
    expect(result!.writtenFiles).toBe(2); // /a.ts /b.ts
    expect([...current.files.entries()].sort()).toEqual([
      ["/a.ts", "原始a"],
      ["/b.ts", "原始b"],
    ]);
  });

  it("恢复前自动生成 restore-backup 快照，内容是恢复前的当前状态", async () => {
    const original = makeVfs({ "/a.ts": "原始a" });
    const snap = await manager.createSnapshot(PROJECT, { name: "v1", source: "manual" }, original.io);

    const current = makeVfs({ "/a.ts": "被修改" });
    const result = await manager.restore(PROJECT, snap.id, current.io);

    expect(result!.backup).not.toBeNull();
    expect(result!.backup!.source).toBe("restore-backup");
    expect(result!.backup!.files[0].content).toBe("被修改");

    // 列表里有 backup，且可以恢复回去（分支思想：任何状态都能找回）
    const list = await manager.listSnapshots(PROJECT);
    expect(list.map((s) => s.source)).toContain("restore-backup");
  });

  it("内容无差异时不产生 backup、不执行删写", async () => {
    const original = makeVfs({ "/a.ts": "same" });
    const snap = await manager.createSnapshot(PROJECT, { name: "v1", source: "manual" }, original.io);

    const current = makeVfs({ "/a.ts": "same" });
    const result = await manager.restore(PROJECT, snap.id, current.io);

    expect(result).not.toBeNull();
    expect(result!.backup).toBeNull();
    expect(result!.deletedFiles).toBe(0);
    expect(result!.writtenFiles).toBe(0);
  });

  it("快照 ID 不存在返回 null", async () => {
    const { io } = makeVfs({});
    const result = await manager.restore(PROJECT, "no-such-id", io);
    expect(result).toBeNull();
  });

  it("恢复 backup 即撤销恢复（分支可来回滚）", async () => {
    const original = makeVfs({ "/a.ts": "v1" });
    const snap = await manager.createSnapshot(PROJECT, { name: "v1", source: "manual" }, original.io);

    const modified = makeVfs({ "/a.ts": "v2" });
    await manager.restore(PROJECT, snap.id, modified.io);
    expect(modified.files.get("/a.ts")).toBe("v1");

    // 再恢复到 backup（内容是 v2）
    const list = await manager.listSnapshots(PROJECT);
    const backup = list.find((s) => s.source === "restore-backup")!;
    await manager.restore(PROJECT, backup.id, modified.io);
    expect(modified.files.get("/a.ts")).toBe("v2");
  });
});

describe("ProjectSnapshotManager - 删除 / 清理 / 上限", () => {
  let store: MemoryProjectSnapshotStore;
  let manager: ProjectSnapshotManager;

  beforeEach(() => {
    store = new MemoryProjectSnapshotStore();
    manager = new ProjectSnapshotManager(store);
  });

  it("删除单条快照", async () => {
    const { io } = makeVfs({ "/a.ts": "x" });
    const snap = await manager.createSnapshot(PROJECT, { name: "v1", source: "manual" }, io);

    await manager.deleteSnapshot(snap.id);
    expect(await manager.listSnapshots(PROJECT)).toHaveLength(0);
  });

  it("purgeProject 清空项目快照，不影响其他项目", async () => {
    const vfs1 = makeVfs({ "/a.ts": "1" });
    const vfs2 = makeVfs({ "/b.ts": "2" });
    await manager.createSnapshot(PROJECT, { name: "p1", source: "manual" }, vfs1.io);
    await manager.createSnapshot("proj-2", { name: "p2", source: "manual" }, vfs2.io);

    await manager.purgeProject(PROJECT);

    expect(await manager.listSnapshots(PROJECT)).toHaveLength(0);
    expect(await manager.listSnapshots("proj-2")).toHaveLength(1);
  });

  it("默认上限 20，超出淘汰最旧的", async () => {
    const { io } = makeVfs({ "/a.ts": "x" });

    for (let i = 0; i < DEFAULT_MAX_PROJECT_SNAPSHOTS + 5; i++) {
      await manager.createSnapshot(PROJECT, { name: `v${i}`, source: "manual" }, io);
    }

    const list = await manager.listSnapshots(PROJECT);
    expect(list).toHaveLength(DEFAULT_MAX_PROJECT_SNAPSHOTS);
    // 最旧的 v0..v4 被淘汰
    expect(list[list.length - 1].name).toBe("v5");
    expect(list[0].name).toBe(`v${DEFAULT_MAX_PROJECT_SNAPSHOTS + 4}`);
  });
});
