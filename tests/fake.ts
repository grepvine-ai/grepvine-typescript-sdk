import {
  GrepvineClient,
  RetryPolicy,
  type GrepvineClientOptions,
} from "../src/index.js";

export type Handler = (request: Request) => Response | Promise<Response>;

/** A client whose requests go to `handler`; `requests` records each attempt. */
export function fakeClient(
  handler: Handler,
  options: GrepvineClientOptions = {},
) {
  const requests: Request[] = [];
  const client = new GrepvineClient({
    apiKey: "gvk_test",
    endpoint: "http://grepvine.test",
    retry: new RetryPolicy({ backoff: [0] }),
    ...options,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return handler(request);
    },
  });
  return { client, requests };
}

/** Answer each request with the next response of the list. */
export function sequence(
  ...responses: (Response | (() => Response))[]
): Handler {
  return () => {
    const next = responses.shift();
    if (!next) throw new Error("no response left");
    return typeof next === "function" ? next() : next;
  };
}

export const json = (body: unknown, init?: ResponseInit) =>
  Response.json(body, init);

export const apiError = (
  status: number,
  code: string,
  headers: Record<string, string> = {},
) =>
  Response.json(
    { code, reason: "test", error: `failed with ${code}` },
    { status, headers },
  );

export const page = <T>(results: T[], next = "") => ({
  results,
  pagination: { has_next: Boolean(next), next_page_id: next },
});
