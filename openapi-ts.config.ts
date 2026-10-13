import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./spec/openapi.json",
  output: {
    path: "src/generated",
    postProcess: [
      {
        command: "prettier",
        args: ["{{path}}", "--write", "--ignore-path", "/dev/null"],
      },
    ],
  },
  plugins: ["@hey-api/typescript", "@hey-api/sdk", "@hey-api/client-fetch"],
});
