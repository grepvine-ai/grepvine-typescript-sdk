import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  ConflictError,
  GrepvineClient,
  GrepvineError,
  InvalidRequestError,
  NotFoundError,
} from "../src/index.js";
import {
  ENDPOINT,
  FakeGrepvine,
  collect,
  internals,
  setup,
} from "./helpers.js";

/** A client without an API key, whose pauses are recorded instead of waited out. */
function anonymous(fake = new FakeGrepvine()) {
  const client = new GrepvineClient({
    endpoint: ENDPOINT,
    fetch: fake.fetch,
  });
  const sleeps: number[] = [];
  let clock = 0;
  const runtime = internals(client);
  runtime.now = () => clock;
  runtime.sleep = async (ms) => {
    if (ms <= 0) return;
    sleeps.push(ms);
    clock += ms;
  };
  return { fake, client, sleeps };
}

describe("API keys", () => {
  it("creates, lists and revokes keys", async () => {
    const { client, fake } = setup();
    const created = await client.apiKeys.create("ci");
    expect(created.name).toBe("ci");
    expect(created.key).toMatch(/^gvk_/);
    const keys = await collect(client.apiKeys.list());
    expect(keys.map((k) => k.name)).toEqual(["ci"]);
    expect(keys[0]).not.toHaveProperty("key");
    await client.apiKeys.revoke(created.id);
    expect(fake.log.at(-1)!.method).toBe("DELETE");
    expect(fake.log.at(-1)!.path).toBe(`/api-keys/${created.id}`);
    expect((await client.apiKeys.list().first())!.revoked_at).toBeDefined();
    await expect(client.apiKeys.revoke("missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("account", () => {
  it("registers and checks names without credentials", async () => {
    const { client, fake } = anonymous();
    expect(await client.account.usernameAvailable("alice")).toBe(true);
    const user = await client.account.register({
      name: "alice",
      email: "a@example.com",
      password: "pw-123456",
    });
    expect(user.name).toBe("alice");
    expect(await client.account.usernameAvailable("alice")).toBe(false);
    await expect(
      client.account.register({
        name: "alice",
        email: "b@example.com",
        password: "x",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(fake.log.every((r) => !r.headers.has("authorization"))).toBe(true);
  });

  it("keeps the session cookie and CSRF token after login", async () => {
    const { client, fake } = anonymous();
    fake.addUser("alice", "secret-pass");
    await expect(
      client.account.login({ identifier: "alice", password: "wrong" }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    const user = await client.account.login({
      identifier: "alice",
      password: "secret-pass",
    });
    expect(user.name).toBe("alice");
    expect((await client.account.me()).name).toBe("alice");
    const me = fake.log.at(-1)!;
    expect(me.headers.get("cookie")).toMatch(/^grepvine-session=/);
    expect(me.headers.get("authorization")).toBeNull();
    expect(me.headers.get("x-csrf-token")).toBeNull();

    await client.apiKeys.create("laptop");
    const create = fake.log.at(-1)!;
    expect(create.headers.get("x-csrf-token")).toBe(
      [...fake.sessions.values()][0].csrf,
    );

    await client.account.changePassword({
      currentPassword: "secret-pass",
      newPassword: "new-pass-1",
    });
    expect(JSON.parse(fake.log.at(-1)!.body)).toEqual({
      current_password: "secret-pass",
      new_password: "new-pass-1",
    });

    await client.account.logout();
    expect(fake.sessions.size).toBe(0);
    await expect(client.account.me()).rejects.toThrow("no API key");
  });

  it("uses the API key for me and logout when there is no session", async () => {
    const { client, fake } = setup();
    expect((await client.account.me()).name).toBe("owner");
    await client.account.logout();
    expect(fake.log.at(-1)!.headers.get("authorization")).toBe(
      `Bearer ${fake.apiKey}`,
    );
  });
});

describe("device login", () => {
  it("starts, polls, approves and denies", async () => {
    const device = anonymous();
    const { client: approver } = setup();
    // The approver and the device talk to the same service.
    const approverFake = (
      approver as unknown as { runtime: { options: { fetch: typeof fetch } } }
    ).runtime.options;
    approverFake.fetch = device.fake.fetch;

    const authorization = await device.client.deviceLogin.start({
      apiKeyName: "cli",
    });
    expect(authorization.user_code).toBe("ABCD-0001");
    expect(
      await device.client.deviceLogin.poll(authorization.device_code),
    ).toEqual({ status: "pending" });
    device.fake.devices.get(authorization.device_code)!.state = "slow_down";
    expect(
      await device.client.deviceLogin.poll(authorization.device_code),
    ).toEqual({ status: "slow_down" });
    await approver.deviceLogin.approve(authorization.user_code);
    const issued = await device.client.deviceLogin.poll(
      authorization.device_code,
    );
    expect(issued.status).toBe("issued");
    expect(issued.status === "issued" && issued.apiKey.name).toBe("cli");

    const second = await device.client.deviceLogin.start({
      apiKeyName: "other",
    });
    await approver.deviceLogin.deny(second.user_code);
    const error = await device.client.deviceLogin
      .poll(second.device_code)
      .catch((e) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error.code).toBe("access_denied");
    await expect(approver.deviceLogin.approve("NOPE")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("authorizes at the service's interval until the key is issued", async () => {
    const { client, fake, sleeps } = anonymous();
    const codes: string[] = [];
    let polls = 0;
    const original = fake.handle.bind(fake);
    fake.handle = async (request) => {
      if (request.url.endsWith("/device/token")) {
        polls++;
        const device = [...fake.devices.values()][0];
        if (polls === 2) device.state = "slow_down";
        if (polls === 3) device.state = "approved";
      }
      return original(request);
    };
    const key = await client.deviceLogin.authorize({
      apiKeyName: "agent",
      onCode: (authorization) => {
        codes.push(authorization.user_code);
      },
    });
    expect(codes).toEqual(["ABCD-0001"]);
    expect(key.name).toBe("agent");
    // Pending, then slow down (5 seconds longer from then on), then issued.
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(polls).toBe(3);
  });

  it("stops when the login is denied, expires or outlasts the timeout", async () => {
    const denied = anonymous();
    const pending = denied.client.deviceLogin.authorize({
      onCode: async ({ user_code }) => {
        const device = [...denied.fake.devices.values()].find(
          (d) => d.user_code === user_code,
        )!;
        device.state = "denied";
      },
    });
    await expect(pending).rejects.toMatchObject({ code: "access_denied" });

    const slow = anonymous();
    const error = await slow.client.deviceLogin
      .authorize({ onCode: () => {}, timeout: 12_000 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(GrepvineError);
    expect(error.message).toContain("not approved within 12000 ms");

    const expiring = anonymous();
    const expired = await expiring.client.deviceLogin
      .authorize({ onCode: () => {} })
      .catch((e) => e);
    expect(expired.message).toContain("expired");
    expect(expiring.sleeps.reduce((a, b) => a + b, 0)).toBe(600_000);
  });
});
