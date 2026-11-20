import http from "node:http";
import https from "node:https";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class HttpStatusError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

export async function requestJson<T>(
  baseUrl: URL,
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const url = new URL(path, baseUrl);
  const transport = url.protocol === "https:" ? https : http;
  const method = options.method ?? "GET";
  const serializedBody =
    options.body === undefined ? undefined : JSON.stringify(options.body);

  return new Promise<T>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method,
        headers:
          serializedBody === undefined
            ? { Accept: "application/json" }
            : {
                Accept: "application/json",
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(serializedBody),
              },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;

        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.length;

          if (receivedBytes > MAX_RESPONSE_BYTES) {
            request.destroy(
              new Error(`WLED response is larger than ${MAX_RESPONSE_BYTES} bytes`),
            );
            return;
          }

          chunks.push(buffer);
        });

        response.on("end", () => {
          const statusCode = response.statusCode ?? 0;
          const responseText = Buffer.concat(chunks).toString("utf8");

          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new HttpStatusError(
                statusCode,
                `WLED returned HTTP ${statusCode}`,
              ),
            );
            return;
          }

          if (responseText.length === 0) {
            resolve({} as T);
            return;
          }

          try {
            resolve(JSON.parse(responseText) as T);
          } catch {
            reject(new Error("WLED returned invalid JSON"));
          }
        });
      },
    );

    request.setTimeout(options.timeoutMs ?? 5_000, () => {
      request.destroy(new Error("WLED request timed out"));
    });
    request.on("error", reject);

    if (serializedBody !== undefined) {
      request.write(serializedBody);
    }
    request.end();
  });
}
