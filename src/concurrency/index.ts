export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export async function parallelMap<T, U>(
  items: ReadonlyArray<T>,
  fn: (item: T) => Promise<U>,
  concurrency: number,
): Promise<U[]> {
  const sem = new Semaphore(concurrency);
  return Promise.all(
    items.map(async (item) => {
      const release = await sem.acquire();
      try {
        return await fn(item);
      } finally {
        release();
      }
    }),
  );
}
