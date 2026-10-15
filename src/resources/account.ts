import {
  approveDeviceAuthorization,
  changePassword,
  createApiKey,
  denyDeviceAuthorization,
  getCurrentUser,
  getUsernameAvailability,
  listApiKeys,
  login,
  logout,
  pollDeviceToken,
  registerUser,
  revokeApiKey,
  startDeviceAuthorization,
} from "../generated/sdk.gen.js";
import { isNode } from "../config.js";
import { APIError, GrepvineError } from "../errors.js";
import type {
  ApiKey,
  ApiKeyCreated,
  DeviceAuthorization,
  User,
} from "../models.js";
import { Paginator, type PageOptions } from "../paginator.js";
import { unwrap, type Runtime } from "../runtime.js";
import type { RequestOptions } from "./common.js";

/**
 * The API keys of the caller's account, reached as `client.apiKeys`.
 *
 * @category API keys
 */
export class ApiKeys {
  /** @internal */
  constructor(private readonly runtime: Runtime) {}

  /** Every API key of the account, including revoked ones. */
  list(options: PageOptions = {}): Paginator<ApiKey> {
    return new Paginator(
      async (page, amount, signal) =>
        unwrap(
          await listApiKeys({
            ...(await this.runtime.call(signal)),
            query: { amount, ...(page ? { page } : {}) },
          }),
        ).data,
      (key: ApiKey) => key,
      options,
    );
  }

  /** Create an API key. Its secret `key` is returned only this once. */
  async create(
    name: string,
    options: RequestOptions = {},
  ): Promise<ApiKeyCreated> {
    return unwrap(
      await createApiKey({
        ...(await this.runtime.call(options.signal)),
        body: { name },
      }),
    ).data;
  }

  /** Revoke an API key by its `id`. */
  async revoke(id: string, options: RequestOptions = {}): Promise<void> {
    unwrap(
      await revokeApiKey({
        ...(await this.runtime.call(options.signal)),
        path: { api_key_id: id },
      }),
    );
  }
}

/**
 * Options of {@link Account.register}.
 *
 * @category Account
 */
export interface RegisterOptions extends RequestOptions {
  /** The account name, shared with organizations. */
  name: string;
  email: string;
  password: string;
}

/**
 * Options of {@link Account.login}.
 *
 * @category Account
 */
export interface LoginOptions extends RequestOptions {
  /** A username or an email address. */
  identifier: string;
  password: string;
}

/**
 * Options of {@link Account.changePassword}.
 *
 * @category Account
 */
export interface ChangePasswordOptions extends RequestOptions {
  currentPassword: string;
  newPassword: string;
}

/**
 * Accounts and sessions, reached as `client.account`.
 *
 * An API key authenticates every call except {@link Account.register},
 * {@link Account.usernameAvailable} and {@link Account.login}, which need no
 * credentials. After `login`, the client uses the session instead of the
 * API key until {@link Account.logout}.
 *
 * @category Account
 */
export class Account {
  /** @internal */
  constructor(private readonly runtime: Runtime) {}

  /** Create an account. */
  async register(options: RegisterOptions): Promise<User> {
    const { name, email, password } = options;
    return unwrap(
      await registerUser({
        ...(await this.runtime.call(options.signal, "none")),
        body: { name, email, password },
      }),
    ).data;
  }

  /** Whether a name is free for a new account or organization. */
  async usernameAvailable(
    name: string,
    options: RequestOptions = {},
  ): Promise<boolean> {
    return unwrap(
      await getUsernameAvailability({
        ...(await this.runtime.call(options.signal, "none")),
        path: { name },
      }),
    ).data.available;
  }

  /**
   * Start a session and keep it on the client, so later calls use it.
   *
   * In Node.js the client keeps the session cookie and its CSRF token
   * itself. In a browser the browser keeps the cookie, and requests are sent
   * with `credentials: "include"`; the service must allow the page's origin.
   */
  async login(options: LoginOptions): Promise<User> {
    const { identifier, password } = options;
    const { data, response } = unwrap(
      await login({
        ...(await this.runtime.call(options.signal, "none")),
        body: { identifier, password },
      }),
    );
    this.runtime.csrfToken = response.headers.get("x-csrf-token") ?? undefined;
    if (isNode()) {
      const cookies =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [];
      this.runtime.sessionCookies = cookies
        .map((cookie) => cookie.split(";", 1)[0].trim())
        .filter((pair) => pair.includes("="));
    }
    return data;
  }

  /** End the session, or revoke the API key in use when there is no session. */
  async logout(options: RequestOptions = {}): Promise<void> {
    unwrap(await logout({ ...(await this.runtime.call(options.signal)) }));
    this.runtime.sessionCookies = [];
    this.runtime.csrfToken = undefined;
  }

  /** The account the client acts as. */
  async me(options: RequestOptions = {}): Promise<User> {
    return unwrap(
      await getCurrentUser({ ...(await this.runtime.call(options.signal)) }),
    ).data;
  }

  /** Change the account's password. */
  async changePassword(options: ChangePasswordOptions): Promise<void> {
    unwrap(
      await changePassword({
        ...(await this.runtime.call(options.signal)),
        body: {
          current_password: options.currentPassword,
          new_password: options.newPassword,
        },
      }),
    );
  }
}

/**
 * The outcome of one {@link DeviceLogin.poll}: the issued key, or that the
 * login is still waiting for approval. With `"slow_down"`, wait 5 seconds
 * longer between polls.
 *
 * @category Device login
 */
export type DevicePoll =
  | { status: "issued"; apiKey: ApiKeyCreated }
  | { status: "pending" }
  | { status: "slow_down" };

/**
 * Options of {@link DeviceLogin.authorize}.
 *
 * @category Device login
 */
export interface AuthorizeOptions extends RequestOptions {
  /** The name the new API key gets. Default `"Grepvine TypeScript SDK"`. */
  apiKeyName?: string;
  /**
   * Called once with the login to approve: show its `user_code` and
   * `verification_uri_complete` to the person who will approve it.
   */
  onCode: (authorization: DeviceAuthorization) => void | Promise<void>;
  /** The longest time to wait for approval, in milliseconds. Default: until the login expires. */
  timeout?: number;
}

const SLOW_DOWN_STEP = 5_000;

/**
 * Logging in a device, such as a command-line tool or an agent, by having a
 * person approve it; reached as `client.deviceLogin`.
 *
 * The device calls {@link DeviceLogin.start} (or {@link DeviceLogin.authorize},
 * which does everything) without credentials; the person approves the code
 * with {@link DeviceLogin.approve} from a client that holds a session or an
 * API key; the device then receives an API key of its own.
 *
 * @category Device login
 */
export class DeviceLogin {
  /** @internal */
  constructor(private readonly runtime: Runtime) {}

  /** Start a device login; the new key will be named `apiKeyName`. */
  async start(
    options: RequestOptions & { apiKeyName: string },
  ): Promise<DeviceAuthorization> {
    return unwrap(
      await startDeviceAuthorization({
        ...(await this.runtime.call(options.signal, "none")),
        body: { api_key_name: options.apiKeyName },
      }),
    ).data;
  }

  /**
   * Ask once whether the login was approved.
   *
   * A denied or expired login throws {@link InvalidRequestError} with code
   * `"access_denied"` or `"expired_token"`.
   */
  async poll(
    deviceCode: string,
    options: RequestOptions = {},
  ): Promise<DevicePoll> {
    try {
      const { data } = unwrap(
        await pollDeviceToken({
          ...(await this.runtime.call(options.signal, "none")),
          body: { device_code: deviceCode },
        }),
      );
      return { status: "issued", apiKey: data };
    } catch (error) {
      if (error instanceof APIError && error.statusCode === 400) {
        if (error.code === "authorization_pending")
          return { status: "pending" };
        if (error.code === "slow_down") return { status: "slow_down" };
      }
      throw error;
    }
  }

  /** Approve a device login by the code it shows. */
  async approve(userCode: string, options: RequestOptions = {}): Promise<void> {
    unwrap(
      await approveDeviceAuthorization({
        ...(await this.runtime.call(options.signal)),
        body: { user_code: userCode },
      }),
    );
  }

  /** Deny a device login by the code it shows. */
  async deny(userCode: string, options: RequestOptions = {}): Promise<void> {
    unwrap(
      await denyDeviceAuthorization({
        ...(await this.runtime.call(options.signal)),
        body: { user_code: userCode },
      }),
    );
  }

  /**
   * Log in this device: start a login, report its code through `onCode`, and
   * poll at the service's interval until the key is issued.
   *
   * A denied login throws {@link InvalidRequestError} with code
   * `"access_denied"`. A login that expires, or outlasts `timeout`, throws
   * {@link GrepvineError}.
   *
   * ```ts
   * const key = await client.deviceLogin.authorize({
   *   onCode: ({ user_code, verification_uri_complete }) =>
   *     console.log(`Open ${verification_uri_complete} and enter ${user_code}`),
   * });
   * ```
   */
  async authorize(options: AuthorizeOptions): Promise<ApiKeyCreated> {
    const { signal } = options;
    const authorization = await this.start({
      apiKeyName: options.apiKeyName ?? "Grepvine TypeScript SDK",
      signal,
    });
    await options.onCode(authorization);
    const started = this.runtime.now();
    const expires = started + authorization.expires_in * 1000;
    const deadline =
      options.timeout === undefined
        ? expires
        : Math.min(expires, started + options.timeout);
    let interval = Math.max(authorization.interval, 1) * 1000;
    while (true) {
      const left = deadline - this.runtime.now();
      if (left <= 0) break;
      await this.runtime.sleep(Math.min(interval, left), signal);
      if (this.runtime.now() >= deadline) break;
      const outcome = await this.poll(authorization.device_code, { signal });
      if (outcome.status === "issued") return outcome.apiKey;
      if (outcome.status === "slow_down") interval += SLOW_DOWN_STEP;
    }
    throw new GrepvineError(
      deadline < expires
        ? `the device login was not approved within ${options.timeout} ms`
        : "the device login expired before it was approved",
    );
  }
}
