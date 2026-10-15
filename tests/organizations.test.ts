import { describe, expect, it } from "vitest";
import { NotFoundError } from "../src/index.js";
import { collect, setup } from "./helpers.js";

describe("organizations", () => {
  it("gets one organization", async () => {
    const { fake, client } = setup();
    fake.addOrganization("acme", "admin");
    const org = await client.organizations.get("acme");
    expect(org.name).toBe("acme");
    expect(org.role).toBe("admin");
    expect(fake.log[0].headers.get("authorization")).toBe(
      `Bearer ${fake.apiKey}`,
    );
  });

  it("throws NotFoundError for a missing organization", async () => {
    const { client } = setup();
    const error = await client.organizations.get("nope").catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("not_found");
    expect(error.requestId).toBe("req-test");
  });

  it("lists every organization across pages", async () => {
    const { fake, client } = setup();
    for (let i = 0; i < 5; i++) fake.addOrganization(`org-${i}`);
    const orgs = await collect(client.organizations.list({ pageSize: 2 }));
    expect(orgs.map((o) => o.name)).toEqual([
      "org-0",
      "org-1",
      "org-2",
      "org-3",
      "org-4",
    ]);
    expect(fake.log.map((r) => r.query.get("amount"))).toEqual(["2", "2", "2"]);
  });

  it("honours limit", async () => {
    const { fake, client } = setup();
    for (let i = 0; i < 5; i++) fake.addOrganization(`org-${i}`);
    const orgs = await collect(client.organizations.list({ limit: 3 }));
    expect(orgs).toHaveLength(3);
    expect(fake.log).toHaveLength(1);
    expect(fake.log[0].query.get("amount")).toBe("3");
  });

  it("exposes continuation tokens on pages", async () => {
    const { fake, client } = setup();
    for (let i = 0; i < 3; i++) fake.addOrganization(`org-${i}`);
    const pages = client.organizations.list({ pageSize: 2 }).pages();
    const first = (await pages.next()).value!;
    expect(first.has_next).toBe(true);
    expect(first.page_size).toBe(2);
    const rest = await collect(
      client.organizations.list({ page: first.next_page_id, pageSize: 2 }),
    );
    expect(rest.map((o) => o.name)).toEqual(["org-2"]);
  });

  it("creates, deletes and transfers organizations", async () => {
    const { fake, client } = setup();
    const created = await client.organizations.create("newco");
    expect(created.name).toBe("newco");
    await client.organizations.transferOwnership("newco", "bob");
    expect(JSON.parse(fake.log.at(-1)!.body)).toEqual({ user: "bob" });
    expect(fake.log.at(-1)!.method).toBe("PUT");
    expect(fake.log.at(-1)!.path).toBe("/organizations/newco/owner");
    await client.organizations.delete("newco");
    await expect(client.organizations.get("newco")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("manages members", async () => {
    const { fake, client } = setup();
    fake.addOrganization("acme");
    const members = client.organizations.members("acme");
    const added = await members.add("bob", { role: "developer" });
    expect(added.user.name).toBe("bob");
    expect(added.role).toBe("developer");
    const updated = await members.update("bob", { role: "admin" });
    expect(updated.role).toBe("admin");
    expect((await collect(members.list())).map((m) => m.user.name)).toEqual([
      "bob",
    ]);
    await members.remove("bob");
    expect(await collect(members.list())).toEqual([]);
    await expect(members.remove("bob")).rejects.toBeInstanceOf(NotFoundError);
  });
});
