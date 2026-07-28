/**
 * Runs `task` over every item with at most `limit` in flight, so a wide object
 * does not open one request per field at once.
 */
export const mapWithConcurrency = async <Item, Output>(
  items: readonly Item[],
  limit: number,
  task: (item: Item) => Promise<Output>
): Promise<Output[]> => {
  const results = new Array<Output>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      // eslint-disable-next-line no-await-in-loop
      results[index] = await task(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
};
