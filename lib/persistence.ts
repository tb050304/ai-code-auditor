// ---------------------------------------------------------------------------
// 可序列化存储后端（存储抽象层）
// ---------------------------------------------------------------------------
// 设计目标：
//  1. 上层（useConversations）只依赖 StorageBackend<T> 接口，
//     因此将来可无缝替换为 IndexedDB / HTTP 服务端存储。
//  2. localStorage 实现内置三项健壮性保障：
//     a. 版本化 key —— 数据结构演进时可安全迁移，旧缓存自动失效。
//     b. 损坏容错 —— JSON 解析失败时备份原数据并返回 null，绝不抛异常崩溃。
//     c. 容量守卫 —— 写入前检查大小，超出或配额满载时返回 false，调用方可感知。
// ---------------------------------------------------------------------------

/** 任意可序列化的数据结构 */
/** 存储后端统一接口 */
export interface StorageBackend<T> {
  /** 读取并反序列化；数据缺失或损坏时返回 null（不抛异常） */
  load(): T | null;
  /** 序列化并写入；成功返回 true，失败（配额/容量）返回 false */
  save(data: T): boolean;
  /** 清除该 key 下的数据 */
  clear(): void;
}

export interface LocalStorageBackendOptions {
  /** 业务命名空间的 key 前缀，如 "ai-auditor" */
  key: string;
  /** 结构版本号；版本变化会让旧缓存失效，避免读到过时结构 */
  schemaVersion: number;
  /** 可选容量守卫（字节）；数据超过则拒绝写入 */
  maxBytes?: number;
}

const STORAGE_PREFIX = "ai-code-auditor";

/**
 * 创建一个基于 localStorage 的后端实例。
 * 所有读写都包裹在 try/catch 中，充分考虑到 localStorage 在
 * 隐私模式/配额限制下抛出异常的场景，保证上层状态永不被拖垮。
 */
export function createLocalStorageBackend<T>(
  options: LocalStorageBackendOptions
): StorageBackend<T> {
  const key = `${STORAGE_PREFIX}:${options.key}:v${options.schemaVersion}`;

  return {
    load(): T | null {
      if (typeof window === "undefined") return null;
      let raw: string | null = null;
      try {
        raw = window.localStorage.getItem(key);
      } catch (error) {
        // 某些隐私模式下读操作会被禁止
        console.error(`[persistence] 读取 ${key} 失败:`, error);
        return null;
      }
      if (!raw) return null;

      try {
        const parsed = JSON.parse(raw) as T;
        return parsed;
      } catch (error) {
        // 数据损坏：将原始内容降级备份，避免用户历史彻底丢失，并重置当前缓存
        console.error(`[persistence] ${key} 数据损坏，已备份并重置:`, error);
        try {
          const backupKey = `${key}:corrupt:${Date.now()}`;
          window.localStorage.setItem(backupKey, raw);
        } catch {
          /* 备份失败不影响主流程 */
        }
        window.localStorage.removeItem(key);
        return null;
      }
    },

    save(data: T): boolean {
      if (typeof window === "undefined") return false;
      let serialized: string;
      try {
        serialized = JSON.stringify(data);
      } catch (error) {
        console.error(`[persistence] ${key} 序列化失败:`, error);
        return false;
      }

      // 容量守卫：超过 maxBytes 直接拒绝，避免写入失败弹错
      if (typeof options.maxBytes === "number" && serialized.length > options.maxBytes) {
        console.warn(
          `[persistence] ${key} 数据大小 ${serialized.length} 超过上限 ${options.maxBytes}，已拒绝写入`
        );
        return false;
      }

      try {
        window.localStorage.setItem(key, serialized);
        return true;
      } catch (error) {
        console.error(`[persistence] ${key} 写入失败（可能超出配额）:`, error);
        return false;
      }
    },

    clear(): void {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.removeItem(key);
      } catch (error) {
        console.error(`[persistence] ${key} 清除失败:`, error);
      }
    },
  };
}