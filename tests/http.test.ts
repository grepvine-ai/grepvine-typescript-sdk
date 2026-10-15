import { expect, it } from "vitest";
import { setup } from "./helpers.js";

it("sends any request with the client's endpoint, authentication and retries", async () => {
  const { client, fake } = setup();
  fake.addOrganization("acme");
  fake.failNext(503);
  const response = await client.http("/organizations/acme");
  expect(response.status).toBe(200);
  expect((await response.json()).name).toBe("acme");
  expect(fake.log).toHaveLength(2);
  expect(fake.log[1].headers.get("authorization")).toBe(
    `Bearer ${fake.apiKey}`,
  );
  const missing = await client.http("/organizations/none", { method: "GET" });
  expect(missing.status).toBe(404);
  await expect(client.http("https://elsewhere.test/x")).rejects.toThrow(
    'must start with "/"',
  );
});
