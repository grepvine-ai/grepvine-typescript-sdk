import {
  addOrganizationMember,
  createOrganization,
  deleteOrganization,
  getOrganization,
  listOrganizationMembers,
  listOrganizations,
  removeOrganizationMember,
  transferOrganizationOwnership,
  updateOrganizationMember,
} from "../generated/sdk.gen.js";
import type { Member, Organization } from "../models.js";
import { Paginator, type PageOptions } from "../paginator.js";
import { unwrap, type Runtime } from "../runtime.js";
import { type RequestOptions } from "./common.js";

const identity = <T>(value: T) => value;

/**
 * A role a member can be given; ownership moves with
 * {@link Organizations.transferOwnership}.
 *
 * @category Organizations
 */
export type MemberRole = "admin" | "developer" | "reader";

/**
 * The organizations the caller can see, reached as `client.organizations`.
 *
 * @category Organizations
 */
export class Organizations {
  /** @internal */
  constructor(private readonly runtime: Runtime) {}

  /** Every organization, or at most `limit` of them. */
  list(options: PageOptions = {}): Paginator<Organization> {
    return new Paginator(
      async (page, amount, signal) =>
        unwrap(
          await listOrganizations({
            ...(await this.runtime.call(signal)),
            query: { amount, ...(page ? { page } : {}) },
          }),
        ).data,
      identity<Organization>,
      options,
    );
  }

  /** One organization by name. */
  async get(name: string, options: RequestOptions = {}): Promise<Organization> {
    return unwrap(
      await getOrganization({
        ...(await this.runtime.call(options.signal)),
        path: { organization: name },
      }),
    ).data;
  }

  /** Create an organization; the caller becomes its owner. */
  async create(
    name: string,
    options: RequestOptions = {},
  ): Promise<Organization> {
    return unwrap(
      await createOrganization({
        ...(await this.runtime.call(options.signal)),
        body: { name },
      }),
    ).data;
  }

  /** Start deleting an organization. Deletion completes in the background. */
  async delete(name: string, options: RequestOptions = {}): Promise<void> {
    unwrap(
      await deleteOrganization({
        ...(await this.runtime.call(options.signal)),
        path: { organization: name },
      }),
    );
  }

  /** Make another account the owner of the organization. */
  async transferOwnership(
    organization: string,
    user: string,
    options: RequestOptions = {},
  ): Promise<void> {
    unwrap(
      await transferOrganizationOwnership({
        ...(await this.runtime.call(options.signal)),
        path: { organization },
        body: { user },
      }),
    );
  }

  /** The members of an organization. */
  members(organization: string): Members {
    return new Members(this.runtime, organization);
  }
}

/**
 * The members of one organization, reached as
 * `client.organizations.members("my-org")`.
 *
 * @category Organizations
 */
export class Members {
  /** @internal */
  constructor(
    private readonly runtime: Runtime,
    /** The organization's name. */
    readonly organization: string,
  ) {}

  /** Every member, or at most `limit` of them. */
  list(options: PageOptions = {}): Paginator<Member> {
    return new Paginator(
      async (page, amount, signal) =>
        unwrap(
          await listOrganizationMembers({
            ...(await this.runtime.call(signal)),
            path: { organization: this.organization },
            query: { amount, ...(page ? { page } : {}) },
          }),
        ).data,
      identity<Member>,
      options,
    );
  }

  /** Add an account to the organization with a role. */
  async add(
    user: string,
    options: { role: MemberRole } & RequestOptions,
  ): Promise<Member> {
    return unwrap(
      await addOrganizationMember({
        ...(await this.runtime.call(options.signal)),
        path: { organization: this.organization },
        body: { user, role: options.role },
      }),
    ).data;
  }

  /** Change a member's role. */
  async update(
    user: string,
    options: { role: MemberRole } & RequestOptions,
  ): Promise<Member> {
    return unwrap(
      await updateOrganizationMember({
        ...(await this.runtime.call(options.signal)),
        path: { organization: this.organization, user },
        body: { role: options.role },
      }),
    ).data;
  }

  /** Remove a member from the organization. */
  async remove(user: string, options: RequestOptions = {}): Promise<void> {
    unwrap(
      await removeOrganizationMember({
        ...(await this.runtime.call(options.signal)),
        path: { organization: this.organization, user },
      }),
    );
  }
}
