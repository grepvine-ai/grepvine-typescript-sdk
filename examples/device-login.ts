/**
 * Obtain an API key for this machine by device login: print a code, wait for
 * a person to approve it, then list the organizations the new key can see.
 * Run with Node.js 22.18+ after building the SDK.
 */
import { GrepvineClient } from "@grepvine/sdk";

async function main() {
  const endpoint = process.env.GREPVINE_API_ENDPOINT;
  const device = new GrepvineClient({ endpoint });
  const key = await device.deviceLogin.authorize({
    apiKeyName: "TypeScript SDK example",
    onCode: ({ verification_uri_complete, user_code }) => {
      console.log(`Open ${verification_uri_complete}`);
      console.log(`Enter code: ${user_code}`);
    },
  });
  console.log(`Received API key ${key.prefix}…`);

  const client = new GrepvineClient({ endpoint, apiKey: key.key });
  for await (const org of client.organizations.list()) {
    console.log(`${org.name} (${org.role})`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
