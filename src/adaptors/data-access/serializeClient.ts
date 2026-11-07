const queues = new WeakMap<object, Promise<unknown>>();
export function serializeClient<T>(client: object, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(client) ?? Promise.resolve();
  const result = previous.then(work, work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(client, settled);
  void settled.then(() => {
    if (queues.get(client) === settled) queues.delete(client);
  });
  return result;
}
