import { ConfigurationError } from "./errors.js";

export const DEFAULT_ENDPOINT = "https://api.grepvine.ai";
const API_VERSION_SUFFIX = "/v1";

export const NOT_LOGGED_IN_MESSAGE = "no API key; pass apiKey to the client";

/** Whether the code runs in Node.js (or a runtime that provides its modules). */
export function isNode(): boolean {
  const versions = (
    globalThis as { process?: { versions?: { node?: string } } }
  ).process?.versions;
  return typeof versions?.node === "string";
}

export function normalizeEndpoint(raw: string): string {
  const endpoint = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigurationError(
      `endpoint ${JSON.stringify(raw)} must be an http or https URL such as ${DEFAULT_ENDPOINT}`,
    );
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.host) {
    throw new ConfigurationError(
      `endpoint ${JSON.stringify(raw)} must be an http or https URL such as ${DEFAULT_ENDPOINT}`,
    );
  }
  if (
    url.search ||
    url.hash ||
    endpoint.includes("?") ||
    endpoint.includes("#")
  ) {
    throw new ConfigurationError(
      `endpoint ${JSON.stringify(raw)} must not carry a query or fragment`,
    );
  }
  return endpoint.endsWith(API_VERSION_SUFFIX)
    ? endpoint
    : endpoint + API_VERSION_SUFFIX;
}

/** Where requests go and how they authenticate. */
export interface Credentials {
  endpoint: string;
  apiKey: string | undefined;
}

/**
 * Normalize the given endpoint, or use the default one, and keep the API key.
 *
 * The client reads no environment variables or configuration files.
 */
export async function resolveCredentials(options: {
  endpoint?: string;
  apiKey?: string;
}): Promise<Credentials> {
  return {
    endpoint: normalizeEndpoint(options.endpoint || DEFAULT_ENDPOINT),
    apiKey: options.apiKey || undefined,
  };
}
