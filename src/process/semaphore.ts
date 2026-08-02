/** Simple counting semaphore used to cap concurrent OS processes per backend. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(concurrency: number) {
    if (concurrency < 1) throw new Error("concurrency must be >= 1");
    this.available = concurrency;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    const gate = Promise.withResolvers<void>();
    this.waiters.push(gate.resolve);
    await gate.promise;
    this.available--;
    return () => this.release();
  }

  private release(): void {
    this.available++;
    this.waiters.shift()?.();
  }
}
