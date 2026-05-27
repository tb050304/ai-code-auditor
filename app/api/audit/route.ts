import { analyzeCodeStream } from "@/lib/modelService";

export async function POST(req: Request) {
  try {
    const { code, model, userPrompt } = await req.json();

    if (!code || code.trim() === "") {
      return new Response("代码不能为空", { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of analyzeCodeStream(code, model, userPrompt)) {
            if (chunk.done) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(chunk.content));
          }
        } catch (error: any) {
          console.error("Stream error:", error);
          controller.enqueue(
            encoder.encode(`\n\n**流式传输错误: ${error.message}**`)
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error: any) {
    console.error("API Error:", error);
    return new Response(`AI 审计服务出现异常: ${error.message}`, { status: 500 });
  }
}

export async function GET() {
  const models = await getAvailableModels();
  return Response.json(models);
}

async function getAvailableModels() {
  const { getAvailableModels: fetchModels } = await import("@/lib/models");
  return fetchModels();
}
