import { describe, expect, it } from "vitest";
import {
  ConflictError,
  GrepvineError,
  Index,
  InvalidRequestError,
  NotFoundError,
} from "../src/index.js";
import { collect, setup } from "./helpers.js";

describe("indexes", () => {
  it("gets a handle with the index fields", async () => {
    const { fake, client } = setup();
    fake.addIndex("acme/docs", {
      description: "# Docs",
      tags: { team: "search" },
    });
    fake.addDocument("acme/docs", "a.txt", "alpha");
    const index = await client.indexes.get("acme/docs");
    expect(index).toBeInstanceOf(Index);
    expect(index.ref).toBe("acme/docs");
    expect(index.state).toBe("ready");
    expect(index.document_count).toBe(1);
    expect(index.content_bytes).toBe(5);
    expect(index.description).toBe("# Docs");
    expect(index.tags).toEqual({ team: "search" });
    expect(Object.isFrozen(index.tags)).toBe(true);
    expect(index.data.canonical_id).toBe(index.canonical_id);
  });

  it.each(["acme", "acme/", "/docs", "acme/docs/extra", ""])(
    "rejects the malformed reference %j before the network",
    async (ref) => {
      const { fake, client } = setup();
      await expect(client.indexes.get(ref)).rejects.toThrow(
        "ORGANIZATION/INDEX",
      );
      expect(fake.log).toHaveLength(0);
    },
  );

  it("throws NotFoundError for a missing index", async () => {
    const { fake, client } = setup();
    fake.addOrganization("acme");
    await expect(client.indexes.get("acme/none")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("creates an index, sending only the fields given", async () => {
    const { fake, client } = setup();
    fake.addOrganization("acme");
    const index = await client.indexes.create("acme/docs");
    expect(index.name).toBe("docs");
    expect(JSON.parse(fake.log[0].body)).toEqual({ name: "docs" });
    await client.indexes.create("acme/more", {
      description: "Guides",
      tags: { commit: "3f9c2a1" },
    });
    expect(JSON.parse(fake.log[1].body)).toEqual({
      name: "more",
      description: "Guides",
      tags: { commit: "3f9c2a1" },
    });
  });

  it("throws ConflictError for an existing index unless existOk", async () => {
    const { fake, client } = setup();
    fake.addIndex("acme/docs", { description: "kept", tags: { a: "b" } });
    await expect(client.indexes.create("acme/docs")).rejects.toBeInstanceOf(
      ConflictError,
    );
    const index = await client.indexes.create("acme/docs", {
      existOk: true,
      description: "ignored",
      tags: { c: "d" },
    });
    expect(index.description).toBe("kept");
    expect(index.tags).toEqual({ a: "b" });
  });

  it("reports the conflict when the index vanishes before existOk reads it", async () => {
    const { fake, client } = setup();
    fake.addOrganization("acme");
    fake.failNext(409, { code: "conflict", method: "POST" });
    const error = await client.indexes
      .create("acme/docs", { existOk: true })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
  });

  it("waits for a new index to become ready", async () => {
    const { fake, client, sleeps } = setup();
    fake.addOrganization("acme");
    fake.newIndexState = "creating";
    let reads = 0;
    const original = fake.handle.bind(fake);
    fake.handle = async (request) => {
      if (request.method === "GET" && ++reads === 2) {
        fake.indexes.get("acme/docs")!.state = "ready";
      }
      return original(request);
    };
    const index = await client.indexes.create("acme/docs", { wait: true });
    expect(index.state).toBe("ready");
    expect(sleeps).toEqual([500, 500]);
  });

  it("stops waiting when the index fails or the timeout passes", async () => {
    const { fake, client } = setup();
    fake.addIndex("acme/broken", { state: "delete_failed" });
    fake.addIndex("acme/slow", { state: "creating" });
    const broken = await client.indexes.get("acme/broken");
    await expect(broken.waitUntilReady()).rejects.toThrow(
      "cannot become ready",
    );
    const slow = await client.indexes.get("acme/slow");
    const error = await slow
      .waitUntilReady({ timeout: 2_000, interval: 600 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(GrepvineError);
    expect(error.message).toContain("was not ready within 2000 ms");
  });

  it("deletes and checks existence", async () => {
    const { fake, client } = setup();
    fake.addIndex("acme/docs");
    expect(await client.indexes.exists("acme/docs")).toBe(true);
    await client.indexes.delete("acme/docs");
    expect(await client.indexes.exists("acme/docs")).toBe(false);
    await expect(client.indexes.delete("acme/docs")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("delegates handle methods to the client", async () => {
    const { fake, client } = setup();
    fake.addIndex("acme/docs");
    const index = await client.indexes.get("acme/docs");
    fake.addDocument("acme/docs", "a.txt", "alpha");
    const refreshed = await index.refresh();
    expect(index.document_count).toBe(0);
    expect(refreshed.document_count).toBe(1);
    expect(await index.exists()).toBe(true);
    await index.delete();
    expect(await index.exists()).toBe(false);
  });

  it("lists handles, filtered by prefix", async () => {
    const { fake, client } = setup();
    for (const name of ["docs-a", "docs-b", "logs"])
      fake.addIndex(`acme/${name}`);
    const all = await collect(client.indexes.list("acme"));
    expect(all.every((i) => i instanceof Index)).toBe(true);
    expect(all.map((i) => i.name)).toEqual(["docs-a", "docs-b", "logs"]);
    const docs = await collect(
      client.indexes.list("acme", { prefix: "DOCS-" }),
    );
    expect(docs.map((i) => i.name)).toEqual(["docs-a", "docs-b"]);
    expect(fake.log.at(-1)!.query.get("prefix")).toBe("DOCS-");
  });

  it("updates the description and merges tags", async () => {
    const { fake, client } = setup();
    fake.addIndex("acme/docs", { tags: { team: "search", commit: "1" } });
    const index = await client.indexes.get("acme/docs");
    const described = await index.update({ description: "Guides" });
    expect(JSON.parse(fake.log.at(-1)!.body)).toEqual({
      description: "Guides",
    });
    expect(described.description).toBe("Guides");
    expect(index.description).toBe("");
    const tagged = await index.update({
      tags: { team: "platform", commit: null },
    });
    expect(JSON.parse(fake.log.at(-1)!.body)).toEqual({
      tags: { team: "platform", commit: null },
    });
    expect(tagged.tags).toEqual({ team: "platform" });
    expect(tagged.description).toBe("Guides");
    const both = await client.indexes.update("acme/docs", {
      description: "",
      tags: { x: "y" },
    });
    expect(JSON.parse(fake.log.at(-1)!.body)).toEqual({
      description: "",
      tags: { x: "y" },
    });
    expect(both.description).toBe("");
  });

  it("sets and removes tags", async () => {
    const { fake, client } = setup();
    fake.addIndex("acme/docs", { tags: { team: "search" } });
    const index = await client.indexes.get("acme/docs");
    const set = await index.setTags({ commit: "8b1d0e4" });
    expect(set.tags).toEqual({ team: "search", commit: "8b1d0e4" });
    const removed = await set.removeTags("team", "commit");
    expect(JSON.parse(fake.log.at(-1)!.body)).toEqual({
      tags: { team: null, commit: null },
    });
    expect(removed.tags).toEqual({});
  });

  it("throws NotFoundError when updating a missing index", async () => {
    const { fake, client } = setup();
    fake.addOrganization("acme");
    await expect(
      client.indexes.update("acme/none", { description: "x" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("checks descriptions and tags before the network", async () => {
    const { fake, client } = setup();
    fake.addIndex("acme/docs");
    await expect(client.indexes.update("acme/docs", {})).rejects.toThrow(
      "nothing to change",
    );
    await expect(
      client.indexes.create("acme/x", { description: "x".repeat(16385) }),
    ).rejects.toThrow("at most 16384");
    await expect(
      client.indexes.update("acme/docs", { description: "x".repeat(16385) }),
    ).rejects.toThrow("at most 16384");
    const invalid: Record<string, string>[] = [
      { "": "v" },
      { "has space": "v" },
      { ["k".repeat(129)]: "v" },
      { k: "\u0007" },
      { k: "v".repeat(1025) },
    ];
    for (const tags of invalid) {
      await expect(client.indexes.create("acme/x", { tags })).rejects.toThrow();
    }
    const many = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`k${i}`, "v"]),
    );
    await expect(
      client.indexes.create("acme/x", { tags: many }),
    ).rejects.toThrow("at most 64");
    await expect(
      client.indexes.update("acme/docs", { tags: { "a b": null } }),
    ).rejects.toThrow();
    expect(fake.log).toHaveLength(0);
  });

  it("accepts tags at the limits", async () => {
    const { fake, client } = setup();
    fake.addOrganization("acme");
    const tags = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [
        `${i}`.padEnd(128, "k"),
        "v".repeat(1024),
      ]),
    );
    const index = await client.indexes.create("acme/docs", { tags });
    expect(Object.keys(index.tags)).toHaveLength(64);
  });

  it("reports a tag limit the service enforces", async () => {
    const { fake, client } = setup();
    fake.addIndex("acme/docs", {
      tags: Object.fromEntries(
        Array.from({ length: 64 }, (_, i) => [`k${i}`, "v"]),
      ),
    });
    await expect(
      client.indexes.update("acme/docs", { tags: { extra: "v" } }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });
});
