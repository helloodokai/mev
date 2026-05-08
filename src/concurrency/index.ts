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
  timeoutMs?: number,
): Promise<U[]> {
  const sem = new Semaphore(concurrency);
  const results: U[] = new Array(items.length);

  await Promise.all(
    items.map(async (item, index) => {
      const release = await sem.acquire();
      try {
        if (timeoutMs && timeoutMs > 0) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          try {
            results[index] = await fn(item);
          } finally {
            clearTimeout(timeout);
          }
        } else {
          results[index] = await fn(item);
        }
      } catch (err) {
        // Store a sentinel error object instead of crashing the whole batch
        results[index] = {
          __parallelMapError: true,
          __error: err instanceof Error ? err.message : String(err),
        } as unknown as U;
      } finally {
        release();
      }
    }),
  );

  return results;
}

export function isParallelMapError<U>(result: U): result is U & { __parallelMapError: true; __error: string } {
  return result !== null && typeof result === "object" && "__parallelMapError" in result;
}