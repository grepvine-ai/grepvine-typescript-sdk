/**
 * An in-memory Grepvine service for tests, served through a fake `fetch`.
 *
 * It speaks the public API's wire shapes closely enough to exercise the SDK
 * end to end without a network: bearer and session authentication, every
 * route, idempotency replay, preconditions, per-document batch results, byte
 * ranges, folded listings, regex search with byte offsets, and page tokens
 * bound to the request's arguments.
 */

export const API_KEY = "gvk_test-key-0123456789abcdefghijklmnop";
export const ENDPOINT = "http://grepvine.test";

const MAX_BATCH_RECORDS = 2048;
const MAX_AMOUNT = 200;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Reject extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reason = "validation",
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export interface StoredDocument {
  key: string;
  content: Uint8Array;
  metadata: Record<string, { type: string; value: unknown }>;
  revision: string;
  updated_at: string;
}

export interface FakeIndex {
  organization: string;
  name: string;
  id: string;
  state: string;
  description: string;
  tags: Record<string, string>;
  documents: Map<string, StoredDocument>;
  idempotency: Map<string, { digest: string; status: number; body: unknown }>;
  optimization_progress_percent?: number;
}

export interface Fault {
  times: number;
  status?: number;
  code?: string;
  message?: string;
  retryAfter?: number;
  error?: unknown;
  method?: string;
  pathSuffix?: string;
}

/** One request as the fake received it. */
export interface Logged {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
  form?: FormData;
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-Request-ID": "req-test",
      ...headers,
    },
  });
}

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Buffer.from(digest).toString("hex");
}

function byteOffset(text: string, index: number): number {
  return encoder.encode(text.slice(0, index)).byteLength;
}

export class FakeGrepvine {
  readonly apiKey = API_KEY;
  readonly organizations = new Map<
    string,
    { id: string; name: string; role: string; created_at: string }
  >();
  readonly members = new Map<
    string,
    Map<string, { user: string; role: string }>
  >();
  readonly indexes = new Map<string, FakeIndex>();
  readonly apiKeys: {
    id: string;
    name: string;
    prefix: string;
    created_at: string;
    revoked_at?: string;
  }[] = [];
  readonly users = new Map<
    string,
    { id: string; name: string; email: string; password: string }
  >();
  readonly sessions = new Map<string, { user: string; csrf: string }>();
  readonly devices = new Map<
    string,
    { user_code: string; name: string; state: string; polls: number }
  >();
  readonly log: Logged[] = [];
  faults: Fault[] = [];
  /** Stop a search page after examining this many lines, to produce empty pages. */
  searchTruncateAfter: number | undefined;
  quoteEtag = false;
  /** The state a newly created index starts in. */
  newIndexState = "ready";
  private revisions = 0;
  readonly now = "2026-09-06T12:00:00Z";

  /** A `fetch` to give the client. */
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    this.handle(new Request(input, init))) as typeof fetch;

  addOrganization(name: string, role = "owner") {
    const entry = { id: crypto.randomUUID(), name, role, created_at: this.now };
    this.organizations.set(name.toLowerCase(), entry);
    return entry;
  }

  addIndex(
    ref: string,
    options: {
      state?: string;
      description?: string;
      tags?: Record<string, string>;
    } = {},
  ): FakeIndex {
    const [organization, name] = ref.split("/");
    if (!this.organizations.has(organization.toLowerCase()))
      this.addOrganization(organization);
    const index: FakeIndex = {
      organization: this.organizations.get(organization.toLowerCase())!.name,
      name,
      id: crypto.randomUUID(),
      state: options.state ?? "ready",
      description: options.description ?? "",
      tags: { ...(options.tags ?? {}) },
      documents: new Map(),
      idempotency: new Map(),
    };
    this.indexes.set(
      `${organization.toLowerCase()}/${name.toLowerCase()}`,
      index,
    );
    return index;
  }

  addDocument(
    ref: string,
    key: string,
    content: string | Uint8Array,
    metadata: StoredDocument["metadata"] = {},
  ): StoredDocument {
    const index = this.index(...(ref.split("/") as [string, string]));
    const document: StoredDocument = {
      key,
      content: typeof content === "string" ? encoder.encode(content) : content,
      metadata,
      revision: this.revision(),
      updated_at: this.now,
    };
    index.documents.set(key, document);
    return document;
  }

  addUser(name: string, password: string, email = `${name}@example.com`) {
    const user = { id: crypto.randomUUID(), name, email, password };
    this.users.set(name.toLowerCase(), user);
    return user;
  }

  failNext(
    status: number,
    options: Omit<Fault, "status" | "times"> & { times?: number } = {},
  ) {
    this.faults.push({ times: 1, ...options, status });
  }

  throwNext(
    error: unknown,
    options: Omit<Fault, "error" | "times"> & { times?: number } = {},
  ) {
    this.faults.push({ times: 1, ...options, error });
  }

  /** The logged requests other than those for the given paths. */
  requestsTo(suffix: string): Logged[] {
    return this.log.filter((entry) => entry.path.endsWith(suffix));
  }

  private revision(): string {
    this.revisions += 1;
    return `rev-${String(this.revisions).padStart(6, "0")}`;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.replace(/^\/v1/, "")).replace(
      /%2F/gi,
      "/",
    );
    const rawPath = url.pathname.replace(/^\/v1/, "");
    const contentType = request.headers.get("content-type") ?? "";
    const logged: Logged = {
      method: request.method,
      path,
      query: url.searchParams,
      headers: request.headers,
      body: "",
    };
    if (contentType.startsWith("multipart/form-data")) {
      logged.form = await request.clone().formData();
    } else {
      logged.body = await request.clone().text();
    }
    this.log.push(logged);

    const fault = this.faults.find(
      (f) =>
        f.times > 0 &&
        (f.method === undefined || f.method === request.method) &&
        (f.pathSuffix === undefined || path.endsWith(f.pathSuffix)),
    );
    if (fault) {
      fault.times -= 1;
      if (fault.error !== undefined) throw fault.error;
      return json(
        fault.status!,
        {
          code: fault.code ?? "internal_error",
          reason: "server",
          error: fault.message ?? "the request could not be completed",
        },
        fault.retryAfter === undefined
          ? {}
          : { "Retry-After": String(fault.retryAfter) },
      );
    }
    try {
      return await this.route(request, logged, rawPath);
    } catch (error) {
      if (error instanceof Reject) {
        return json(
          error.status,
          { code: error.code, reason: error.reason, error: error.message },
          error.headers,
        );
      }
      throw error;
    }
  }

  private authenticate(request: Request): string {
    const authorization = request.headers.get("authorization");
    if (authorization === `Bearer ${this.apiKey}`) return "owner";
    const cookie = request.headers.get("cookie") ?? "";
    const session = /grepvine-session=([^;]+)/.exec(cookie)?.[1];
    if (session && this.sessions.has(session)) {
      const entry = this.sessions.get(session)!;
      if (
        !["GET", "HEAD"].includes(request.method) &&
        request.headers.get("x-csrf-token") !== entry.csrf
      ) {
        throw new Reject(
          403,
          "csrf_failed",
          "the CSRF token is missing or not valid",
          "auth",
        );
      }
      return entry.user;
    }
    throw new Reject(
      401,
      "unauthenticated",
      "authentication is required",
      "auth",
    );
  }

  private organization(name: string) {
    const entry = this.organizations.get(name.toLowerCase());
    if (!entry)
      throw new Reject(
        404,
        "not_found",
        "the resource does not exist",
        "resource",
      );
    return entry;
  }

  private index(organization: string, name: string): FakeIndex {
    this.organization(organization);
    const index = this.indexes.get(
      `${organization.toLowerCase()}/${name.toLowerCase()}`,
    );
    if (!index)
      throw new Reject(
        404,
        "not_found",
        "the resource does not exist",
        "resource",
      );
    return index;
  }

  private body(logged: Logged): any {
    try {
      const value = JSON.parse(logged.body);
      if (value && typeof value === "object" && !Array.isArray(value))
        return value;
    } catch {
      // Fall through.
    }
    throw new Reject(400, "invalid_request", "the request is invalid");
  }

  private async fingerprint(logged: Logged): Promise<string> {
    const query = new URLSearchParams(logged.query);
    query.delete("page");
    return sha(`${logged.method} ${logged.path} ${query} ${logged.body}`);
  }

  private async pageArgs(logged: Logged): Promise<[number, number]> {
    const amount = Number(logged.query.get("amount") ?? 50);
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
      throw new Reject(
        400,
        "invalid_amount",
        "amount must be between 1 and 200",
      );
    }
    const page = logged.query.get("page");
    if (!page) return [amount, 0];
    try {
      const token = JSON.parse(Buffer.from(page, "base64url").toString());
      if (token.fingerprint === (await this.fingerprint(logged)))
        return [amount, token.cursor];
    } catch {
      // Fall through.
    }
    throw new Reject(
      400,
      "invalid_page",
      "the page token is invalid or expired",
      "pagination",
    );
  }

  private async token(logged: Logged, cursor: number): Promise<string> {
    return Buffer.from(
      JSON.stringify({ cursor, fingerprint: await this.fingerprint(logged) }),
    ).toString("base64url");
  }

  private async page<T>(
    logged: Logged,
    items: T[],
    extra: Record<string, unknown> = {},
  ) {
    const [amount, cursor] = await this.pageArgs(logged);
    const hasNext = cursor + amount < items.length;
    return json(200, {
      results: items.slice(cursor, cursor + amount),
      ...extra,
      pagination: {
        next_page_id: hasNext ? await this.token(logged, cursor + amount) : "",
        has_next: hasNext,
      },
    });
  }

  private indexJSON(index: FakeIndex) {
    let bytes = 0;
    for (const document of index.documents.values())
      bytes += document.content.byteLength;
    return {
      id: index.id,
      organization: index.organization,
      name: index.name,
      canonical_id: index.id,
      description: index.description,
      tags: { ...index.tags },
      state: index.state,
      document_count: index.documents.size,
      content_bytes: bytes,
      created_at: this.now,
      ...(index.optimization_progress_percent === undefined
        ? {}
        : {
            optimization_progress_percent: index.optimization_progress_percent,
          }),
    };
  }

  private async route(
    request: Request,
    logged: Logged,
    rawPath: string,
  ): Promise<Response> {
    const { method } = request;
    const segments = rawPath.split("/").filter(Boolean).map(decodeURIComponent);
    const route = `${method} /${segments
      .map((segment, i) =>
        i % 2 === 1 && segments[0] !== "auth" && segments[0] !== "device"
          ? "*"
          : segment,
      )
      .join("/")}`;

    // Routes that need no credentials.
    if (method === "POST" && rawPath === "/auth/register") {
      const body = this.body(logged);
      if (this.users.has(body.name.toLowerCase())) {
        throw new Reject(
          409,
          "username_taken",
          "the username is taken",
          "state",
        );
      }
      const user = this.addUser(body.name, body.password, body.email);
      return json(201, {
        id: user.id,
        name: user.name,
        email: user.email,
        created_at: this.now,
      });
    }
    if (
      method === "GET" &&
      segments[0] === "auth" &&
      segments[1] === "usernames"
    ) {
      const name = segments[2];
      return json(200, {
        name,
        available:
          !this.users.has(name.toLowerCase()) &&
          !this.organizations.has(name.toLowerCase()),
      });
    }
    if (method === "POST" && rawPath === "/auth/login") {
      const body = this.body(logged);
      const user = this.users.get(String(body.identifier).toLowerCase());
      if (!user || user.password !== body.password) {
        throw new Reject(
          401,
          "invalid_credentials",
          "the username or password is wrong",
          "auth",
        );
      }
      const session = crypto.randomUUID();
      const csrf = crypto.randomUUID();
      this.sessions.set(session, { user: user.name, csrf });
      const headers = new Headers({
        "Content-Type": "application/json",
        "X-Csrf-Token": csrf,
      });
      headers.append(
        "Set-Cookie",
        `grepvine-session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      );
      return new Response(
        JSON.stringify({
          id: user.id,
          name: user.name,
          email: user.email,
          created_at: this.now,
        }),
        { status: 200, headers },
      );
    }
    if (method === "POST" && rawPath === "/device/authorizations") {
      const body = this.body(logged);
      const device_code = crypto.randomUUID();
      const user_code = `ABCD-${String(this.devices.size + 1).padStart(4, "0")}`;
      this.devices.set(device_code, {
        user_code,
        name: body.api_key_name,
        state: "pending",
        polls: 0,
      });
      return json(200, {
        device_code,
        user_code,
        verification_uri: "https://grepvine.test/device",
        verification_uri_complete: `https://grepvine.test/device?code=${user_code}`,
        expires_in: 600,
        interval: 5,
      });
    }
    if (method === "POST" && rawPath === "/device/token") {
      const body = this.body(logged);
      const device = this.devices.get(body.device_code);
      if (!device)
        throw new Reject(
          400,
          "expired_token",
          "the device code expired",
          "device",
        );
      device.polls += 1;
      if (device.state === "pending")
        throw new Reject(
          400,
          "authorization_pending",
          "authorization is pending",
          "device",
        );
      if (device.state === "slow_down") {
        device.state = "pending";
        throw new Reject(400, "slow_down", "poll less often", "device");
      }
      if (device.state === "denied")
        throw new Reject(
          400,
          "access_denied",
          "the device login was denied",
          "device",
        );
      if (device.state === "expired")
        throw new Reject(
          400,
          "expired_token",
          "the device code expired",
          "device",
        );
      return json(200, this.createKey(device.name));
    }

    const user = this.authenticate(request);

    if (method === "POST" && rawPath === "/auth/logout") {
      const session = /grepvine-session=([^;]+)/.exec(
        request.headers.get("cookie") ?? "",
      )?.[1];
      if (session) this.sessions.delete(session);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && rawPath === "/auth/me") {
      return json(200, {
        id: "user-1",
        name: user,
        email: `${user}@example.com`,
        created_at: this.now,
      });
    }
    if (method === "PUT" && rawPath === "/auth/password") {
      this.body(logged);
      return new Response(null, { status: 204 });
    }
    if (
      method === "POST" &&
      (rawPath === "/device/authorizations/approve" ||
        rawPath === "/device/authorizations/deny")
    ) {
      const body = this.body(logged);
      const device = [...this.devices.values()].find(
        (d) => d.user_code === body.user_code,
      );
      if (!device)
        throw new Reject(
          404,
          "not_found",
          "the resource does not exist",
          "resource",
        );
      device.state = rawPath.endsWith("approve") ? "approved" : "denied";
      return new Response(null, { status: 204 });
    }

    switch (route) {
      case "GET /api-keys":
        return this.page(logged, this.apiKeys);
      case "POST /api-keys":
        return json(201, this.createKey(this.body(logged).name));
      case "DELETE /api-keys/*": {
        const key = this.apiKeys.find((k) => k.id === segments[1]);
        if (!key)
          throw new Reject(
            404,
            "not_found",
            "the resource does not exist",
            "resource",
          );
        key.revoked_at = this.now;
        return new Response(null, { status: 204 });
      }
      case "GET /organizations":
        return this.page(logged, [...this.organizations.values()]);
      case "POST /organizations": {
        const { name } = this.body(logged);
        if (this.organizations.has(name.toLowerCase())) {
          throw new Reject(409, "conflict", "the organization exists", "state");
        }
        return json(201, this.addOrganization(name));
      }
      case "GET /organizations/*":
        return json(200, this.organization(segments[1]));
      case "DELETE /organizations/*":
        this.organization(segments[1]);
        this.organizations.delete(segments[1].toLowerCase());
        return json(202, undefined);
      case "PUT /organizations/*/owner":
        this.organization(segments[1]);
        this.body(logged);
        return new Response(null, { status: 204 });
      case "GET /organizations/*/members":
        this.organization(segments[1]);
        return this.page(
          logged,
          [
            ...(this.members.get(segments[1].toLowerCase())?.values() ?? []),
          ].map((m) => this.memberJSON(m)),
        );
      case "POST /organizations/*/members": {
        this.organization(segments[1]);
        const body = this.body(logged);
        const members =
          this.members.get(segments[1].toLowerCase()) ?? new Map();
        this.members.set(segments[1].toLowerCase(), members);
        members.set(body.user.toLowerCase(), {
          user: body.user,
          role: body.role,
        });
        return json(201, this.memberJSON(members.get(body.user.toLowerCase())));
      }
      case "PUT /organizations/*/members/*": {
        const member = this.members
          .get(segments[1].toLowerCase())
          ?.get(segments[3].toLowerCase());
        if (!member)
          throw new Reject(
            404,
            "not_found",
            "the resource does not exist",
            "resource",
          );
        member.role = this.body(logged).role;
        return json(200, this.memberJSON(member));
      }
      case "DELETE /organizations/*/members/*": {
        const members = this.members.get(segments[1].toLowerCase());
        if (!members?.delete(segments[3].toLowerCase())) {
          throw new Reject(
            404,
            "not_found",
            "the resource does not exist",
            "resource",
          );
        }
        return new Response(null, { status: 204 });
      }
      case "GET /organizations/*/indexes": {
        this.organization(segments[1]);
        const prefix = (logged.query.get("prefix") ?? "").toLowerCase();
        const items = [...this.indexes.values()]
          .filter(
            (i) => i.organization.toLowerCase() === segments[1].toLowerCase(),
          )
          .filter((i) => i.name.toLowerCase().startsWith(prefix))
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map((i) => {
            const { optimization_progress_percent: _, ...summary } =
              this.indexJSON(i);
            return summary;
          });
        return this.page(logged, items);
      }
      case "POST /organizations/*/indexes": {
        this.organization(segments[1]);
        const body = this.body(logged);
        if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(body.name ?? "")) {
          throw new Reject(400, "invalid_name", "the index name is invalid");
        }
        if (
          this.indexes.has(
            `${segments[1].toLowerCase()}/${body.name.toLowerCase()}`,
          )
        ) {
          throw new Reject(409, "conflict", "the index exists", "state");
        }
        const index = this.addIndex(`${segments[1]}/${body.name}`, {
          description: body.description,
          tags: body.tags,
          state: this.newIndexState,
        });
        return json(201, this.indexJSON(index));
      }
    }

    if (
      segments[0] === "organizations" &&
      segments[2] === "indexes" &&
      segments.length >= 4
    ) {
      const index = this.index(segments[1], segments[3]);
      const rest = segments.slice(4);
      if (rest.length === 0) {
        if (method === "GET") return json(200, this.indexJSON(index));
        if (method === "DELETE") {
          this.indexes.delete(
            `${index.organization.toLowerCase()}/${index.name.toLowerCase()}`,
          );
          return json(202, undefined);
        }
        if (method === "PATCH") {
          const body = this.body(logged);
          if (body.description === undefined && body.tags === undefined) {
            throw new Reject(400, "invalid_request", "the request is invalid");
          }
          if (body.description !== undefined)
            index.description = body.description;
          if (body.tags !== undefined) {
            const merged = { ...index.tags };
            for (const [key, value] of Object.entries(body.tags)) {
              if (value === null) delete merged[key];
              else merged[key] = value as string;
            }
            if (Object.keys(merged).length > 64) {
              throw new Reject(
                400,
                "too_many_tags",
                "an index has at most 64 tags",
              );
            }
            index.tags = merged;
          }
          return json(200, this.indexJSON(index));
        }
      }
      const tail = rest.join("/");
      if (tail === "query" && method === "POST")
        return this.query(logged, index);
      if (tail === "objects" && method === "GET")
        return this.listDocuments(logged, index);
      if (tail === "objects" && method === "PUT")
        return this.putDocument(request, logged, index);
      if (tail === "objects:batch" && method === "POST")
        return this.putBatch(request, logged, index);
      if (tail === "objects:delete" && method === "POST")
        return this.deleteBatch(request, logged, index);
      if (rest[0] === "objects" && rest.length === 2) {
        if (method === "GET") return this.getDocument(request, index, rest[1]);
        if (method === "DELETE")
          return this.deleteDocument(request, index, rest[1]);
      }
    }
    throw new Reject(
      404,
      "not_found",
      "the resource does not exist",
      "resource",
    );
  }

  private memberJSON(member: { user: string; role: string }) {
    return {
      user: {
        id: `user-${member.user}`,
        name: member.user,
        email: `${member.user}@example.com`,
        created_at: this.now,
      },
      role: member.role,
      created_at: this.now,
    };
  }

  private createKey(name: string) {
    const key = {
      id: crypto.randomUUID(),
      name,
      prefix: "gvk_abcd",
      created_at: this.now,
    };
    this.apiKeys.push(key);
    return { ...key, key: `gvk_abcd${crypto.randomUUID()}` };
  }

  private idempotencyKey(request: Request): string {
    const key = request.headers.get("idempotency-key");
    if (!key || key.length < 16 || key.length > 128) {
      throw new Reject(
        400,
        "invalid_idempotency_key",
        "Idempotency-Key must be 16 to 128 characters",
      );
    }
    return key;
  }

  private async replay(
    index: FakeIndex,
    key: string,
    digest: string,
  ): Promise<Response | undefined> {
    const previous = index.idempotency.get(key);
    if (!previous) return undefined;
    if (previous.digest !== digest) {
      throw new Reject(
        409,
        "conflict",
        "idempotency key payload changed",
        "state",
      );
    }
    return json(previous.status, previous.body);
  }

  private remember(
    index: FakeIndex,
    key: string,
    digest: string,
    body: unknown,
  ) {
    index.idempotency.set(key, { digest, status: 200, body });
    return json(200, body);
  }

  private preconditionHolds(
    index: FakeIndex,
    key: string,
    ifMatch?: string | null,
    ifNoneMatch?: string | null,
  ) {
    const existing = index.documents.get(key);
    if (ifMatch) return existing?.revision === ifMatch;
    if (ifNoneMatch === "*") return existing === undefined;
    return true;
  }

  private rejected(key: string, code: string) {
    const message =
      code === "not_found"
        ? "the document does not exist"
        : "the precondition failed";
    return {
      key,
      error: {
        code,
        reason: code === "not_found" ? "resource" : "precondition",
        error: message,
      },
    };
  }

  private store(
    index: FakeIndex,
    key: string,
    content: Uint8Array,
    metadata: StoredDocument["metadata"],
  ) {
    const document = {
      key,
      content,
      metadata,
      revision: this.revision(),
      updated_at: this.now,
    };
    index.documents.set(key, document);
    return document;
  }

  private async putDocument(
    request: Request,
    logged: Logged,
    index: FakeIndex,
  ) {
    const key = this.idempotencyKey(request);
    const form = logged.form;
    if (!form)
      throw new Reject(400, "invalid_request", "the request is invalid");
    const documentKey = String(form.get("key"));
    const content = new Uint8Array(
      await (form.get("content") as Blob).arrayBuffer(),
    );
    const metadata = JSON.parse(String(form.get("metadata") ?? "{}"));
    const digest = await sha(
      `${documentKey}\0${decoder.decode(content)}\0${form.get("metadata")}\0${request.headers.get("if-match")}`,
    );
    const replayed = await this.replay(index, key, digest);
    if (replayed) return replayed;
    if (
      !this.preconditionHolds(
        index,
        documentKey,
        request.headers.get("if-match"),
        request.headers.get("if-none-match"),
      )
    ) {
      throw new Reject(
        412,
        "precondition_failed",
        "the precondition failed",
        "precondition",
      );
    }
    const document = this.store(index, documentKey, content, metadata);
    return this.remember(index, key, digest, {
      key: documentKey,
      revision: document.revision,
    });
  }

  private async putBatch(request: Request, logged: Logged, index: FakeIndex) {
    const key = this.idempotencyKey(request);
    if (request.headers.get("content-type") !== "application/x-ndjson") {
      throw new Reject(
        415,
        "unsupported_media_type",
        "the batch must be NDJSON",
      );
    }
    const lines = logged.body.split("\n").filter((line) => line.trim());
    if (!lines.length)
      throw new Reject(400, "empty_batch", "the batch is empty");
    if (lines.length > MAX_BATCH_RECORDS)
      throw new Reject(400, "too_many_documents", "the batch is too large");
    const digest = await sha(logged.body);
    const replayed = await this.replay(index, key, digest);
    if (replayed) return replayed;
    const results = [];
    for (const line of lines) {
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Reject(400, "invalid_ndjson", "the NDJSON batch is invalid");
      }
      if (
        !this.preconditionHolds(
          index,
          record.key,
          record.if_match,
          record.if_none_match,
        )
      ) {
        results.push(this.rejected(record.key, "precondition_failed"));
        continue;
      }
      const document = this.store(
        index,
        record.key,
        encoder.encode(record.content),
        record.metadata ?? {},
      );
      results.push({ key: record.key, revision: document.revision });
    }
    return this.remember(index, key, digest, { results });
  }

  private async deleteDocument(
    request: Request,
    index: FakeIndex,
    key: string,
  ) {
    this.idempotencyKey(request);
    const document = index.documents.get(key);
    if (!document)
      throw new Reject(
        404,
        "not_found",
        "the resource does not exist",
        "resource",
      );
    const ifMatch = request.headers.get("if-match");
    if (ifMatch && ifMatch !== document.revision) {
      throw new Reject(
        412,
        "precondition_failed",
        "the precondition failed",
        "precondition",
      );
    }
    index.documents.delete(key);
    return json(200, { key, revision: this.revision() });
  }

  private async deleteBatch(
    request: Request,
    logged: Logged,
    index: FakeIndex,
  ) {
    const key = this.idempotencyKey(request);
    const body = this.body(logged);
    if (!Array.isArray(body.objects) || !body.objects.length) {
      throw new Reject(
        400,
        "invalid_request",
        "objects must be a non-empty list",
      );
    }
    const digest = await sha(logged.body);
    const replayed = await this.replay(index, key, digest);
    if (replayed) return replayed;
    const results = body.objects.map(
      (record: { key: string; if_match?: string }) => {
        const document = index.documents.get(record.key);
        if (!document) return this.rejected(record.key, "not_found");
        if (record.if_match && record.if_match !== document.revision) {
          return this.rejected(record.key, "precondition_failed");
        }
        index.documents.delete(record.key);
        return { key: record.key, revision: this.revision() };
      },
    );
    return this.remember(index, key, digest, { results });
  }

  private getDocument(request: Request, index: FakeIndex, key: string) {
    const document = index.documents.get(key);
    if (!document)
      throw new Reject(
        404,
        "not_found",
        "the resource does not exist",
        "resource",
      );
    const etag = this.quoteEtag ? `"${document.revision}"` : document.revision;
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      ETag: etag,
      "Accept-Ranges": "bytes",
      "X-Grepvine-Metadata": JSON.stringify(document.metadata),
    };
    const range = request.headers.get("range");
    const size = document.content.byteLength;
    if (!range)
      return new Response(new Uint8Array(document.content), {
        status: 200,
        headers,
      });
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      throw new Reject(
        400,
        "invalid_range",
        "the Range header must contain one bytes range",
      );
    }
    let start: number;
    let end: number;
    if (!match[1]) {
      start = Math.max(0, size - Number(match[2]));
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (start >= size) {
      throw new Reject(
        416,
        "range_not_satisfiable",
        "the range does not overlap the document",
        "validation",
        {
          "Content-Range": `bytes */${size}`,
        },
      );
    }
    return new Response(document.content.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` },
    });
  }

  private listDocuments(logged: Logged, index: FakeIndex) {
    const prefix = logged.query.get("prefix") ?? "";
    const delimiter = logged.query.get("delimiter");
    const keys = [...index.documents.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();
    const prefixes = new Set<string>();
    const summaries = [];
    for (const key of keys) {
      if (delimiter) {
        const position = key.indexOf(delimiter, prefix.length);
        if (position >= 0) {
          prefixes.add(key.slice(0, position + delimiter.length));
          continue;
        }
      }
      const document = index.documents.get(key)!;
      let searchable = true;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(document.content);
      } catch {
        searchable = false;
      }
      summaries.push({
        key,
        revision: document.revision,
        content_bytes: document.content.byteLength,
        metadata: document.metadata,
        updated_at: document.updated_at,
        searchable,
      });
    }
    return this.page(logged, summaries, { common_prefixes: [...prefixes] });
  }

  private filter(
    expression?: string,
  ): (metadata: StoredDocument["metadata"]) => boolean {
    if (!expression) return () => true;
    const clauses = expression.split(/\s+AND\s+/i).map((raw) => {
      let clause = raw.trim();
      if (clause.startsWith("(") && clause.endsWith(")"))
        clause = clause.slice(1, -1);
      const match =
        /^\s*([A-Za-z_]\w*)\s+(=|!=|<=|>=|<|>|STARTSWITH)\s+('(?:[^']|'')*'|-?\d+(?:\.\d+)?)\s*$/i.exec(
          clause,
        );
      if (!match)
        throw new Reject(
          400,
          "invalid_filter",
          `cannot parse filter near '${clause}'`,
        );
      const value = match[3].startsWith("'")
        ? match[3].slice(1, -1).replaceAll("''", "'")
        : Number(match[3]);
      return { field: match[1], op: match[2].toUpperCase(), value };
    });
    return (metadata) =>
      clauses.every(({ field, op, value }) => {
        const actual = metadata[field]?.value as any;
        if (actual === undefined || actual === null) return false;
        switch (op) {
          case "STARTSWITH":
            return (
              typeof actual === "string" &&
              typeof value === "string" &&
              actual.startsWith(value)
            );
          case "=":
            return actual === value;
          case "!=":
            return actual !== value;
          case "<":
            return actual < value;
          case "<=":
            return actual <= value;
          case ">":
            return actual > value;
          default:
            return actual >= value;
        }
      });
  }

  private async query(logged: Logged, index: FakeIndex) {
    const body = this.body(logged);
    const allowed = new Set([
      "pattern",
      "mode",
      "case_sensitive",
      "whole_word",
      "multiline",
      "filter",
      "lines_before",
      "lines_after",
    ]);
    if (
      Object.keys(body).some((k) => !allowed.has(k)) ||
      !("pattern" in body)
    ) {
      throw new Reject(400, "invalid_request", "the request is invalid");
    }
    const mode = body.mode ?? "regex";
    if (body.whole_word && mode !== "literal") {
      throw new Reject(
        400,
        "invalid_pattern",
        "whole-word matching is valid only in literal mode",
      );
    }
    let source =
      mode === "regex"
        ? body.pattern
        : body.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (body.whole_word) source = `(?<!\\w)${source}(?!\\w)`;
    let flags = "gu";
    if (body.case_sensitive === false) flags += "i";
    let regex: RegExp;
    try {
      regex = new RegExp(source, flags + (body.multiline ? "m" : ""));
    } catch (error) {
      throw new Reject(400, "invalid_pattern", (error as Error).message);
    }
    const predicate = this.filter(body.filter);
    const before = body.lines_before ?? 0;
    const after = body.lines_after ?? 0;
    const [amount, cursor] = await this.pageArgs(logged);

    type Unit = {
      document: StoredDocument;
      lines: string[];
      ordinal: number;
      text: string;
    };
    const units: Unit[] = [];
    const keys = [...index.documents.keys()].sort();
    for (const key of keys) {
      const document = index.documents.get(key)!;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          document.content,
        );
      } catch {
        continue;
      }
      if (!predicate(document.metadata)) continue;
      const lines = text.split("\n");
      if (body.multiline) {
        const count = [...text.matchAll(regex)].length;
        for (let i = 0; i < count; i++)
          units.push({ document, lines, ordinal: i, text });
      } else {
        lines.forEach((_, i) =>
          units.push({ document, lines, ordinal: i, text }),
        );
      }
    }

    const results = [];
    let position = cursor;
    let examined = 0;
    while (position < units.length && results.length < amount) {
      if (
        this.searchTruncateAfter !== undefined &&
        examined >= this.searchTruncateAfter
      )
        break;
      const { document, lines, ordinal, text } = units[position];
      position++;
      examined++;
      const offsets = [0];
      for (const line of lines.slice(0, -1))
        offsets.push(offsets.at(-1)! + encoder.encode(line).byteLength + 1);
      if (body.multiline) {
        const match = [...text.matchAll(regex)][ordinal];
        const start = byteOffset(text, match.index!);
        const end = byteOffset(text, match.index! + match[0].length);
        let first = 0;
        let last = 0;
        offsets.forEach((offset, i) => {
          if (offset <= start) first = i;
          if (offset < Math.max(end, start + 1)) last = i;
        });
        results.push(
          this.result(
            document,
            lines,
            offsets,
            first,
            last,
            [[start, end]],
            before,
            after,
          ),
        );
      } else {
        const line = lines[ordinal];
        const spans: [number, number][] = [...line.matchAll(regex)].map((m) => [
          offsets[ordinal] + byteOffset(line, m.index!),
          offsets[ordinal] + byteOffset(line, m.index! + m[0].length),
        ]);
        if (spans.length)
          results.push(
            this.result(
              document,
              lines,
              offsets,
              ordinal,
              ordinal,
              spans,
              before,
              after,
            ),
          );
      }
    }
    const hasNext = position < units.length;
    return json(200, {
      results,
      pagination: {
        next_page_id: hasNext ? await this.token(logged, position) : "",
        has_next: hasNext,
      },
    });
  }

  private result(
    document: StoredDocument,
    lines: string[],
    offsets: number[],
    first: number,
    last: number,
    spans: [number, number][],
    before: number,
    after: number,
  ) {
    const result: Record<string, unknown> = {
      key: document.key,
      revision: document.revision,
      line_number: first + 1,
      last_line_number: last + 1,
      line_start_offset: offsets[first],
      line_end_offset: offsets[last] + encoder.encode(lines[last]).byteLength,
      text_start_offset: offsets[first],
      text_line_number: first + 1,
      text: lines.slice(first, last + 1).join("\n"),
      matches: spans.map(([start, end]) => ({
        offset: start,
        length: end - start,
      })),
      text_truncated: false,
      matches_truncated: false,
    };
    const context = (from: number, to: number) =>
      lines.slice(from, to).map((text, i) => ({
        line_number: from + i + 1,
        text,
        text_truncated: false,
      }));
    if (before)
      result.lines_before = context(Math.max(0, first - before), first);
    if (after)
      result.lines_after = context(
        last + 1,
        Math.min(lines.length, last + 1 + after),
      );
    return result;
  }
}
