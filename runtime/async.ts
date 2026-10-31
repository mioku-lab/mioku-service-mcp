/** 超时后 reject，用于给 connect / callTool 上保险 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** promise 赛跑，超时返回 undefined 而不抛错（关闭路径用） */
export async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 计数信号量：限制同时进行的 tools/call */
export class Semaphore {
  private available: number;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.available = Math.max(1, limit);
  }

  setLimit(limit: number): void {
    this.available = Math.max(1, limit);
    while (this.available > 0 && this.waiting.length > 0) {
      this.available -= 1;
      this.waiting.shift()!();
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.available <= 0) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.available -= 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.available += 1;
    }
  }
}
