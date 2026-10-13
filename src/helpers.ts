import { createClient, type Config } from "./generated/client/index.js";
import {
  putObjects as generatedPutObjects,
  type Options,
} from "./generated/sdk.gen.js";
import type { PutObjectsData } from "./generated/types.gen.js";

/** Create an independent client. baseUrl includes /v1. */
export const createGrepvineClient = ({
  apiKey,
  ...config
}: Omit<Config, "auth"> & { apiKey?: string } = {}) =>
  createClient({
    baseUrl: "https://api.grepvine.ai/v1",
    ...config,
    // Cookie and bearer authentication are alternatives. Never send the key as a cookie.
    auth: (scheme) => (scheme.scheme === "bearer" ? apiKey : undefined),
  });

/** Send the NDJSON string verbatim rather than JSON-encoding it a second time. */
export const putObjects = <ThrowOnError extends boolean = false>(
  options: Options<PutObjectsData, ThrowOnError>,
) =>
  generatedPutObjects({
    ...options,
    bodySerializer: (body) => body,
  });
