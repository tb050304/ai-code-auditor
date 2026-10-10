/**
 * Day 28 错误分类 + 重试 + 超时 测试
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classifyError,
  fetchWithTimeout,
  withRetry,
} from "@/lib/errors";

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe("classifyError", () => {
  it("网络错误：fetch failed → network", () => {
    const r = classifyError(new Error("fetch failed"));
    expect(r.kind).toBe("network");
    expect(r.retryable).toBe(true);
  });

  it("超时：timeout → timeout", () => {
    const r = classifyError(new Error("timeout"));
    expect(r.kind).toBe("timeout");
    expect(r.retryable).toBe(true);
  });

  it("限流：429 → rate-limit", () => {
    const r = classifyError("429 Too Many Requests");
    expect(r.kind).toBe("rate-limit");
    expect(r.retryable).toBe(true);
  });

  it("认证：401 Unauthorized → auth", () => {
    const r = classifyError("401 Unauthorized: invalid api key");
    expect(r.kind).toBe("auth");
    expect(r.retryable).toBe(false);
  });

  it("存储：QuotaExceededError → quota", () => {
    const r = classifyError(new Error("QuotaExceededError: storage full"));
    expect(r.kind).toBe("quota");
    expect(r.retryable).toBe(false);
  });

  it("语法：unexpected token → syntax", () => {
    const r = classifyError("SyntaxError: unexpected token");
    expect(r.kind).toBe("syntax");
    expect(r.retryable).toBe(false);
  });

  it("abort：AbortError → abort", () => {
    const r = classifyError(new Error("AbortError"));
    expect(r.kind).toBe("abort");
    expect(r.retryable).toBe(false);
  });

  it("unknown：无匹配 → unknown", () => {
    const r = classifyError(new Error("something weird"));
    expect(r.kind).toBe("unknown");
    expect(r.retryable).toBe(false);
  });

  it("null/undefined → unknown + 空消息", () => {
    expect(classifyError(null).kind).toBe("unknown");
    expect(classifyError(undefined).kind).toBe("unknown");
    expect(classifyError(null).raw).toBe("");
  });

  it("字符串直接匹配", () => {
    const r = classifyError("network error");
    expect(r.kind).toBe("network");
  });

  it("对象含 message 字段", () => {
    const r = classifyError({ message: "timeout exceeded" });
    expect(r.kind).toBe("timeout");
  });

  it("优先匹配 abort 再 timeout（abort 在前）", () => {
    // "AbortError" 包含 "abort"，匹配 abort 模式
    const r = classifyError("AbortError: timeout");
    expect(r.kind).toBe("abort");
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  // 用极短延迟 + 真实定时器，避免 fake timer 的异步交互问题
  it("首次成功不重试", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("可重试错误重试到成功", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 5 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("不可重试错误立即抛出不重试", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("401 Unauthorized"));
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow("401");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("超过最大重试次数后抛出最后错误", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("network"));
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 })
    ).rejects.toThrow("network");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("onRetry 回调被调用", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue("ok");

    await withRetry(fn, { onRetry, baseDelayMs: 1 });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 0, 1);
  });

  it("自定义 shouldRetry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("custom"));
    const shouldRetry = vi.fn().mockReturnValue(false);
    await expect(withRetry(fn, { shouldRetry, baseDelayMs: 1 })).rejects.toThrow("custom");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// fetchWithTimeout
// ---------------------------------------------------------------------------

/**
 * 造一个「尊重 AbortSignal」的 fetch mock：signal abort 时 reject AbortError。
 * 真实 fetch 就是这个行为，早期的 `new Promise(() => {})` 式 mock 不响应 abort，
 * 会让 promise 永远挂起 → vitest 超时误报。
 */
function stubFetchHonoringSignal() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () =>
            reject(new DOMException("The operation was aborted.", "AbortError"));
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        }),
    ),
  );
}

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("成功请求正常返回", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));
    const res = await fetchWithTimeout("https://example.com");
    expect(res.status).toBe(200);
  });

  it("超时后抛出 timeout 错误", async () => {
    stubFetchHonoringSignal();
    await expect(
      fetchWithTimeout("https://example.com", { timeoutMs: 50 })
    ).rejects.toThrow("timeout");
  });

  it("外部 signal 已 abort 时立即抛出，且不误报为 timeout", async () => {
    stubFetchHonoringSignal();
    const controller = new AbortController();
    controller.abort();

    const error = await fetchWithTimeout("https://example.com", {
      signal: controller.signal,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect((error as Error).message).not.toBe("timeout");
  });

  it("外部 signal 中途 abort 时透传 AbortError，不误报为 timeout", async () => {
    stubFetchHonoringSignal();
    const controller = new AbortController();
    // timeoutMs 给足，确保是外部 abort 先触发
    const promise = fetchWithTimeout("https://example.com", {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();

    const error = await promise.catch((e: unknown) => e);
    expect((error as DOMException).name).toBe("AbortError");
  });
});
