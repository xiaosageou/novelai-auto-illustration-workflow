import test from 'node:test';
import assert from 'node:assert/strict';

import { enqueueUniqueJob, removeQueuedJobs } from '../utils/job-queue.js';

test('enqueueUniqueJob marks the first idle job as running-ready', () => {
  const queue = { current: null, items: [] };

  const result = enqueueUniqueJob(queue, {
    key: 'chapter-1',
    jobFactory: () => ({ key: 'chapter-1', chapterKey: 'chapter-1' }),
    busy: false
  });

  assert.equal(result.duplicate, false);
  assert.equal(result.state, 'running');
  assert.equal(result.position, 1);
  assert.equal(queue.items.length, 1);
});

test('enqueueUniqueJob reports queued state when the worker is busy', () => {
  const queue = { current: null, items: [] };

  const result = enqueueUniqueJob(queue, {
    key: 'chapter-2',
    jobFactory: () => ({ key: 'chapter-2', chapterKey: 'chapter-2' }),
    busy: true
  });

  assert.equal(result.duplicate, false);
  assert.equal(result.state, 'queued');
  assert.equal(result.position, 1);
});

test('enqueueUniqueJob deduplicates queued and running jobs', () => {
  const queue = {
    current: { key: 'chapter-1', chapterKey: 'chapter-1' },
    items: [{ key: 'chapter-2', chapterKey: 'chapter-2' }]
  };

  const runningDuplicate = enqueueUniqueJob(queue, {
    key: 'chapter-1',
    jobFactory: () => ({ key: 'chapter-1', chapterKey: 'chapter-1' }),
    busy: true
  });
  const queuedDuplicate = enqueueUniqueJob(queue, {
    key: 'chapter-2',
    jobFactory: () => ({ key: 'chapter-2', chapterKey: 'chapter-2' }),
    busy: true
  });

  assert.deepEqual(runningDuplicate, { duplicate: true, state: 'running', position: 0 });
  assert.deepEqual(queuedDuplicate, { duplicate: true, state: 'queued', position: 1 });
  assert.equal(queue.items.length, 1);
});

test('removeQueuedJobs only removes pending queue items', () => {
  const queue = {
    current: { key: 'chapter-1', chapterKey: 'chapter-1' },
    items: [
      { key: 'chapter-2', chapterKey: 'chapter-2' },
      { key: 'chapter-3', chapterKey: 'chapter-3' }
    ]
  };

  const removed = removeQueuedJobs(queue, job => job.chapterKey === 'chapter-2');

  assert.equal(removed, 1);
  assert.deepEqual(queue.current, { key: 'chapter-1', chapterKey: 'chapter-1' });
  assert.deepEqual(queue.items.map(job => job.chapterKey), ['chapter-3']);
});
