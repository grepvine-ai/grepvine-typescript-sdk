import { GrepvineClient, RetryPolicy } from "../src/index.js";
import { API_KEY, ENDPOINT, FakeGrepvine } from "./fake-server.js";

export { API_KEY, ENDPOINT, FakeGrepvine };

/** The internals of a client that tests reach into. */
export interface Internals {
  sleep: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  now: () => number;
  random: () => number;
  newId: () => string;
}

export function internals(client: GrepvineClient): Internals {
  return (client as unknown as { runtime: Internals }).runtime;
}

/**
 * A client of the fake service whose pauses return at once and are recorded
 * in `sleeps`, and whose clock advances by each pause.
 */
export function setup(options: { retry?: RetryPolicy; apiKey?: string } = {}) {
  const fake = new FakeGrepvine();
  const client = new GrepvineClient({
    apiKey: options.apiKey ?? API_KEY,
    endpoint: ENDPOINT,
    env: {},
    fetch: fake.fetch,
    retry: options.retry,
  });
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const runtime = internals(client);
  runtime.now = () => clock;
  runtime.sleep = async (ms, signal) => {
    signal?.throwIfAborted();
    if (ms > 0) {
      sleeps.push(ms);
      clock += ms;
    }
  };
  return { fake, client, sleeps, advance: (ms: number) => (clock += ms) };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
