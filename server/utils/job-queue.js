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
