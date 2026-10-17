export function enqueueUniqueJob(queue, { key, jobFactory, busy = false }) {
  const existingIndex = queue.items.findIndex(item => item.key === key);

  if (queue.current?.key === key) {
    return { duplicate: true, state: 'running', position: 0 };
  }
  if (existingIndex >= 0) {
    return { duplicate: true, state: 'queued', position: existingIndex + 1 };
  }

  const job = jobFactory();
  queue.items.push(job);

  const position = queue.items.length + (queue.current ? 1 : 0);
  return {
    duplicate: false,
    state: busy ? 'queued' : (position === 1 ? 'running' : 'queued'),
    position
  };
}

export function removeQueuedJobs(queue, predicate) {
  const originalLength = queue.items.length;
  queue.items = queue.items.filter(job => !predicate(job));
  return originalLength - queue.items.length;
}

export class ConcurrencyQueue {
  constructor(concurrency = 5) {
    this.concurrency = Math.max(1, concurrency);
    this.running = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._next();
    });
  }

  _next() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      this.running++;
      Promise.resolve()
        .then(fn)
        .then(
          (result) => {
            this.running--;
            resolve(result);
            this._next();
          },
          (error) => {
            this.running--;
            reject(error);
            this._next();
          }
        );
    }
  }

  async waitIdle() {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

