/**
 * One page of a list or search method.
 */
export interface Page<T> {
  results: T[];
  pagination: { has_next: boolean; next_page_id: string };
}

/**
 * Every item of a list or search method, page after page.
 *
 * `method` is any method that returns a page, such as `client.indexes.list`
 * or `client.search.query`, and `parameters` are its parameters. The pages
 * are fetched as the loop needs them, following `pagination.next_page_id`
 * while `has_next` is true; a page may be empty while more follow. `amount`
 * sets the size of each page and `page` the page to start from.
 *
 * ```ts
 * for await (const index of paginate(client.indexes.list, { organization: "acme" })) {
 *   console.log(index.name, index.state);
 * }
 * ```
 */
export async function* paginate<M extends PageMethod>(
  method: M,
  parameters: Parameters<M>[0],
  options?: { signal?: AbortSignal },
): AsyncGenerator<PageItem<M>, void, undefined> {
  let page: string | undefined = parameters?.page;
  while (true) {
    const answer = await method(
      { ...parameters, ...(page && { page }) },
      options,
    );
    const { results, pagination } = answer as Page<PageItem<M>>;
    yield* results;
    if (!pagination.has_next) return;
    page = pagination.next_page_id;
  }
}

/**
 * A method that {@link paginate} can follow: it takes `page` and returns a
 * {@link Page}.
 */
export type PageMethod = (
  parameters: any,
  options?: { signal?: AbortSignal },
) => Promise<Page<unknown> | undefined>;

/**
 * The type of the items a {@link PageMethod} returns.
 */
export type PageItem<M extends PageMethod> =
  NonNullable<Awaited<ReturnType<M>>> extends Page<infer T> ? T : never;
