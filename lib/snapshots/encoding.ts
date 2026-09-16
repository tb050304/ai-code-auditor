/**
 * 快照增量编码（Day 13）：基于行级 LCS diff 的补丁格式。
 *
 * 方向约定：存储快照 S（较旧内容），基准 B（时间线上更早的相邻快照记录，
 * 其内容通常是上一版本）。补丁记录"如何从 B 还原出 S"：
 * - equal 块：直接从基准保留 n 行（两边相同，不存内容）
 * - change 块：基准的 base 行被替换为快照侧的字面值行
 *
 * 纯函数、零 DOM / IDB 依赖，可独立单测；与 UI 用的 lib/diff/lines.ts 同一引擎。
 */
import { computeChunks, splitLines } from "@/lib/diff/lines";

export type PatchOp =
  | { t: "e"; n: number }
  | { t: "c"; base: number; lines: string[] };

export interface SnapshotPatch {
  v: 1;
  ops: PatchOp[];
}

/** 小于该字符数的文件一律存全量（补丁的 JSON 开销可能反而更大） */
export const DELTA_MIN_FULL_LENGTH = 1024;
/** 增量链最大深度：每到第 N 条强制全量检查点，还原最多沿链走 N-1 步 */
export const DELTA_MAX_CHAIN = 8;
/** 补丁不小于全量体积的该比例时，直接存全量（改动太大没有增量收益） */
export const DELTA_SIZE_RATIO = 0.8;
/**
 * LCS dp 表单元格数上限（O(n×m) 内存保护）。
 * 400 万单元格 ≈ 32MB 双精度数组（函数返回后即释放）；
 * 超过则本次快照降级全量，Day 27 性能专项再换 Myers/限界算法。
 */
export const LCS_MAX_CELLS = 4_000_000;

/**
 * 生成从基准文本还原快照文本的补丁。
 * @param snapshotText 要存储的快照内容（旧版本）
 * @param baseText 基准快照内容（相邻的更早一条记录）
 */
export function createPatch(snapshotText: string, baseText: string): SnapshotPatch {
  const sLines = splitLines(snapshotText);
  const bLines = splitLines(baseText);
  const chunks = computeChunks(sLines, bLines);

  const ops: PatchOp[] = [];
  for (const chunk of chunks) {
    if (chunk.type === "equal") {
      ops.push({ t: "e", n: chunk.oldEnd - chunk.oldStart });
    } else {
      ops.push({
        t: "c",
        // 该块在基准侧消耗的行数（还原时需要跳过）
        base: chunk.newEnd - chunk.newStart,
        // 快照侧字面值行
        lines: sLines.slice(chunk.oldStart, chunk.oldEnd),
      });
    }
  }
  return { v: 1, ops };
}

/** 序列化补丁为可存储字符串 */
export function serializePatch(patch: SnapshotPatch): string {
  return JSON.stringify(patch);
}

/** 反序列化补丁（格式损坏时抛错，由调用方决定降级策略） */
export function deserializePatch(text: string): SnapshotPatch {
  const parsed = JSON.parse(text) as Partial<SnapshotPatch>;
  if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.ops)) {
    throw new Error("快照补丁格式无效");
  }
  return { v: 1, ops: parsed.ops as PatchOp[] };
}

/** 打补丁：基准文本 + 补丁 → 快照原文 */
export function applyPatch(baseText: string, patch: SnapshotPatch): string {
  const bLines = splitLines(baseText);
  const out: string[] = [];
  let ptr = 0;
  for (const op of patch.ops) {
    if (op.t === "e") {
      out.push(...bLines.slice(ptr, ptr + op.n));
      ptr += op.n;
    } else {
      out.push(...op.lines);
      ptr += op.base;
    }
  }
  return out.join("\n");
}

export interface EncodeDecisionInput {
  /** 待存储快照的完整内容长度 */
  fullSize: number;
  /** 基准快照（相邻更早记录）的 chainLength；无基准（首条）传 null */
  baseChainLength: number | null;
  snapshotText: string;
  baseText: string | null;
}

export interface EncodeDecision {
  mode: "full" | "delta";
  /** delta 时的序列化补丁 */
  patch?: string;
  /** 决策原因（调试/测试用） */
  reason: string;
}

/**
 * 决定一条快照存全量还是增量。纯函数，阈值全部常量可测。
 */
export function decideEncoding(input: EncodeDecisionInput): EncodeDecision {
  const { fullSize, baseChainLength, snapshotText, baseText } = input;

  if (baseText === null || baseChainLength === null) return { mode: "full", reason: "no-base" };
  if (fullSize < DELTA_MIN_FULL_LENGTH) return { mode: "full", reason: "below-min-size" };
  if (baseChainLength >= DELTA_MAX_CHAIN - 1) return { mode: "full", reason: "checkpoint" };

  const sLineCount = splitLines(snapshotText).length;
  const bLineCount = splitLines(baseText).length;
  if (sLineCount * bLineCount > LCS_MAX_CELLS) {
    return { mode: "full", reason: "lcs-too-large" };
  }

  const patchText = serializePatch(createPatch(snapshotText, baseText));
  if (patchText.length >= fullSize * DELTA_SIZE_RATIO) {
    return { mode: "full", reason: "patch-not-smaller" };
  }
  return { mode: "delta", patch: patchText, reason: "delta" };
}
