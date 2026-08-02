import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Minimal Server-Sent-Events writer: one `data:` frame per event. */
export class SseWriter {
  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
  }

  send(data: unknown, event?: string): void {
    if (event) this.res.write(`event: ${event}\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  /** Write a literal `data: <text>` frame, unencoded — needed for the OpenAI
   * streaming convention of a final unquoted `data: [DONE]` sentinel. */
  sendRaw(text: string): void {
    this.res.write(`data: ${text}\n\n`);
  }

  close(): void {
    this.res.end();
  }
}
