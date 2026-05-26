import { analyzeCode } from "@/lib/deepseek";

export async function POST(req: Request) {
  try {
    const { code } = await req.json();

    if (!code || code.trim() === "") {
      return new Response("代码不能为空", { status: 400 });
    }

    // 1. 等待 AI 返回完整的结果（实际开发中，这里可以替换为原生流式 API）
    const fullResult = await analyzeCode(code);

    // 2. 创建一个可读流
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // 3. 将完整的 Markdown 字符串，按块（甚至按字）拆分发送
        // 为了演示打字机效果，我们每次发送几个字符，并稍微暂停
        const chunkSize = 5;
        for (let i = 0; i < fullResult.length; i += chunkSize) {
          const chunk = fullResult.slice(i, i + chunkSize);
          controller.enqueue(encoder.encode(chunk));

          // 模拟网络延迟和打字速度 (每次暂停 20 毫秒)
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        controller.close();
      },
    });

    // 4. 返回流式响应，注意 headers 的设置非常关键
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error: any) {
    console.error("API Error:", error);
    return new Response("AI 审计服务出现异常", { status: 500 });
  }
}
