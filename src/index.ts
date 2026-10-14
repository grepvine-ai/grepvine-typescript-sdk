export * from "./generated/index.js";
export { createConfig } from "./generated/client/index.js";
export { createGrepvineClient, putObjects } from "./helpers.js";
export { createClient } from "./generated/client/index.js";
export type { Client, Config, Auth } from "./generated/client/index.js";

export {
  GrepvineClient,
  IndexHandle,
  ApiError,
  BatchError,
} from "./convenience.js";
export type {
  Document,
  Documents,
  Indexes,
  MetadataInput,
  SearchOptions,
} from "./convenience.js";
