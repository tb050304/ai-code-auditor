/**
 * 错误分类与友好文案（Day 28）
 *
 * 把各种 unknown 错误归类为用户可理解的类型 + 中文提示，
 * 避免把 "fetch failed" "QuotaExceededError" 等技术消息直接甩给用户。
 */

export type ErrorKind =
  | "network"
  | "timeout"
  | "rate-limit"
  | "auth"
  | "quota"
  | "syntax"
  | "abort"
  | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  /** 给用户看的简短中文提示 */
  message: string;
  /** 原始错误消息（调试用） */
  raw: string;
  /** 是否可重试 */
  retryable: boolean;
}

const PATTERNS: Array<{ kind: ErrorKind; re: RegExp; message: string; retryable: boolean }> = [
  {
    kind: "abort",
    re: /abort|user.*cancel|手动停止|AbortError/i,
    message: "已取消",
    retryable: false,
  },
  {
    kind: "timeout",
    re: /timeout|timed?\s*out|ETIMEDOUT|超时/i,
    message: "请求超时，请检查网络后重试",
    retryable: true,
  },
  {
    kind: "rate-limit",
    re: /rate.?limit|429|too many request|频率/i,
    message: "请求过于频繁，请稍后再试",
    retryable: true,
  },
  {
    kind: "auth",
    re: /401|403|unauthor|forbidden|api\s*key|invalid.*key|认证|授权/i,
    message: "API Key 无效或已过期，请检查 .env.local 配置",
    retryable: false,
  },
  {
    kind: "quota",
    re: /quota|exceeded|storage|IDB|IndexedDB|磁盘|空间不足|QuotaExceeded/i,
    message: "浏览器存储空间不足，请清理旧项目或快照后重试",
    retryable: false,
  },
  {
    kind: "syntax",
    re: /syntax|parse|unexpected token|语法|解析/i,
    message: "代码存在语法错误，无法完成分析",
    retryable: false,
  },
  {
    kind: "network",
    re: /fetch|network|ECONNREFUSED|ENOTFOUND|ERR_INTERNET|SSL|socket|网络|连接/i,
    message: "网络连接失败，请检查网络后重试",
    retryable: true,
  },
];

/**
 * 把 unknown 错误归类为用户可理解的 ClassifiedError。
 * 纯函数，无副作用，可独立测试。
 */
export function classifyError(error: unknown): ClassifiedError {
  const raw = extractMessage(error);

  for (const p of PATTERNS) {
    if (p.re.test(raw)) {
      return { kind: p.kind, message: p.message, raw, retryable: p.retryable };
    }
  }

  return {
    kind: "unknown",
    message: raw || "发生未知错误",
    raw,
    retryable: false,
  };
}

function extractMessage(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.statusText === "string") return obj.statusText;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// 带超时的 fetch（Day 28）
// ---------------------------------------------------------------------------

/**
 * 包装 fetch，增加超时 + AbortSignal 支持。
 *
 * - timeoutMs 毫秒后自动 abort，抛出 `Error("timeout")`（默认 30s）
 * - 外部传入的 signal 触发 abort 时，原样透传 AbortError，**不**误报为超时
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = 30_000, signal: external, ...rest } = init ?? {};
  const controller = new AbortController();

  // 只有定时器触发的 abort 才算超时；外部 signal 的 abort 原样透传
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // 外部 signal 与内部 controller 联动
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    return await fetch(input, { ...rest, signal: controller.signal });
  } catch (error: unknown) {
    if (timedOut) throw new Error("timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// 指数退避重试（Day 28）
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** 最大重试次数（不含首次），默认 2 */
  maxRetries?: number;
  /** 基础延迟 ms，默认 1000 */
  baseDelayMs?: number;
  /** 最大延迟 ms，默认 8000 */
  maxDelayMs?: number;
  /** 判断错误是否可重试，默认用 classifyError().retryable */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** 可选回调：每次重试前通知调用方 */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * 对异步操作做指数退避重试。
 * 只对"可重试"类错误（网络/超时/限流）重试，其余直接抛出。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 2,
    baseDelayMs = 1000,
    maxDelayMs = 8000,
    shouldRetry = (err) => classifyError(err).retryable,
    onRetry,
  } = opts;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !shouldRetry(error, attempt)) {
        throw error;
      }
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
