import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobalQueueManager } from '../services/global-queue-manager.js';

test('GlobalQueueManager: Prompt 队列跨项目排队，Project A 跑完后 Project B 接力', async () => {
  const executionOrder = [];
  const mockPipelines = {
    'ProjectA': {
      isPausedByUser: false,
      processPromptPhase: async () => {
        executionOrder.push('ProjectA_start');
        await new Promise(r => setTimeout(r, 40));
        executionOrder.push('ProjectA_end');
      }
    },
    'ProjectB': {
      isPausedByUser: false,
      processPromptPhase: async () => {
        executionOrder.push('ProjectB_start');
        await new Promise(r => setTimeout(r, 40));
        executionOrder.push('ProjectB_end');
      }
    }
  };

  const manager = new GlobalQueueManager({
    getPipeline: async (name) => mockPipelines[name],
    broadcastSSE: () => {},
    cooldownManager: { getState: () => ({ isCooling: false, remainingSeconds: 0 }) }
  });

  const resA = manager.enqueuePromptJob({ projectName: 'ProjectA', type: 'pipeline' });
  const resB = manager.enqueuePromptJob({ projectName: 'ProjectB', type: 'pipeline' });

  assert.equal(resA.duplicate, false);
  assert.equal(resB.duplicate, false);
  assert.equal(resB.state, 'queued');
  assert.equal(resB.position, 1);

  // 等待两者全部跑完
  while (manager.promptQueue.running || manager.promptQueue.items.length > 0 || manager.promptQueue.current) {
    await new Promise(r => setTimeout(r, 20));
  }

  assert.deepEqual(executionOrder, [
    'ProjectA_start',
    'ProjectA_end',
    'ProjectB_start',
    'ProjectB_end'
  ]);
});

test('GlobalQueueManager: 两级解耦 - Project A Prompt 阶段完成即可流转 Project B，Image 队列异步单例出图', async () => {
  const renderedImages = [];
  const promptSteps = [];

  const mockPipelines = {
    'ProjectA': {
      isPausedByUser: false,
      processPromptPhase: async (targetChap, { onScenePromptReady }) => {
        promptSteps.push('A_prompt_start');
        // 模拟提取出场景 1 和场景 2
        onScenePromptReady({ chapKey: '第1章', scene: { scene_idx: 1 } });
        onScenePromptReady({ chapKey: '第1章', scene: { scene_idx: 2 } });
        promptSteps.push('A_prompt_done');
      },
      redrawSceneWithSavedPrompt: async (chapKey, sceneIdx) => {
        await new Promise(r => setTimeout(r, 30));
        renderedImages.push(`A_${chapKey}_${sceneIdx}`);
      },
      projectProgress: {
        getCompletedChapters: () => ({ '第1章': { scenes: [{ status: 'SUCCESS' }, { status: 'SUCCESS' }] } }),
        getEffectiveChapKey: () => '第1章',
        normalizeKey: (k) => k,
        setChapterStatus: () => {},
        save: async () => {}
      },
      chapters: [{ volume: '', chapter: '第1章', content: 'test' }]
    },
    'ProjectB': {
      isPausedByUser: false,
      processPromptPhase: async (targetChap, { onScenePromptReady }) => {
        promptSteps.push('B_prompt_start');
        onScenePromptReady({ chapKey: '第1章', scene: { scene_idx: 1 } });
        promptSteps.push('B_prompt_done');
      },
      redrawSceneWithSavedPrompt: async (chapKey, sceneIdx) => {
        await new Promise(r => setTimeout(r, 30));
        renderedImages.push(`B_${chapKey}_${sceneIdx}`);
      },
      projectProgress: {
        getCompletedChapters: () => ({ '第1章': { scenes: [{ status: 'SUCCESS' }] } }),
        getEffectiveChapKey: () => '第1章',
        normalizeKey: (k) => k,
        setChapterStatus: () => {},
        save: async () => {}
      },
      chapters: [{ volume: '', chapter: '第1章', content: 'test' }]
    }
  };

  const manager = new GlobalQueueManager({
    getPipeline: async (name) => mockPipelines[name],
    broadcastSSE: () => {},
    cooldownManager: { getState: () => ({ isCooling: false }) }
  });

  manager.enqueuePromptJob({ projectName: 'ProjectA', type: 'pipeline' });
  manager.enqueuePromptJob({ projectName: 'ProjectB', type: 'pipeline' });

  // 等待所有 Prompt 和 Image 任务执行完毕
  while (manager.promptQueue.running || manager.imageQueue.running || manager.promptQueue.items.length > 0 || manager.imageQueue.items.length > 0 || manager.imageQueue.current) {
    await new Promise(r => setTimeout(r, 20));
  }

  // 验证 Prompt 顺序：A 提炼完成 -> B 提炼完成（完全在图片全部渲染完之前已经准备就绪）
  assert.deepEqual(promptSteps, [
    'A_prompt_start',
    'A_prompt_done',
    'B_prompt_start',
    'B_prompt_done'
  ]);

  // 验证图片渲染顺序：严格串行
  assert.deepEqual(renderedImages, [
    'A_第1章_1',
    'A_第1章_2',
    'B_第1章_1'
  ]);
});

test('GlobalQueueManager: 单场景重绘优先级插队 (priority: true)', async () => {
  const renderedImages = [];

  const mockPipeline = {
    isPausedByUser: false,
    redrawSceneWithSavedPrompt: async (chapKey, sceneIdx) => {
      await new Promise(r => setTimeout(r, 25));
      renderedImages.push(`${chapKey}_${sceneIdx}`);
    },
    projectProgress: {
      getCompletedChapters: () => ({}),
      save: async () => {}
    },
    chapters: []
  };

  const manager = new GlobalQueueManager({
    getPipeline: async () => mockPipeline,
    broadcastSSE: () => {},
    cooldownManager: { getState: () => ({ isCooling: false }) }
  });

  // 先推入普通任务 1, 2, 3
  manager.enqueueImageJob({ projectName: 'Test', chapterKey: '第1章', sceneIdx: 1, priority: false });
  manager.enqueueImageJob({ projectName: 'Test', chapterKey: '第1章', sceneIdx: 2, priority: false });
  manager.enqueueImageJob({ projectName: 'Test', chapterKey: '第1章', sceneIdx: 3, priority: false });

  // 用户点击场景 99 重绘，高优插队
  manager.enqueueImageJob({ projectName: 'Test', chapterKey: '第1章', sceneIdx: 99, priority: true });

  while (manager.imageQueue.running || manager.imageQueue.priorityItems.length > 0 || manager.imageQueue.items.length > 0 || manager.imageQueue.current) {
    await new Promise(r => setTimeout(r, 15));
  }

  // 场景 1 已经先被取出开始执行，紧接着插队的场景 99 必须优先于场景 2 和 3 被绘制！
  assert.equal(renderedImages[0], '第1章_1');
  assert.equal(renderedImages[1], '第1章_99');
  assert.equal(renderedImages[2], '第1章_2');
  assert.equal(renderedImages[3], '第1章_3');
});

test('GlobalQueueManager: 取消指定项目，不影响其他排队项目', async () => {
  const promptRun = [];
  const imagesRun = [];

  const mockPipelines = {
    'ProjectA': {
      isPausedByUser: false,
      stop: async () => {},
      processPromptPhase: async () => {
        promptRun.push('A');
      },
      redrawSceneWithSavedPrompt: async () => { imagesRun.push('A'); }
    },
    'ProjectB': {
      isPausedByUser: false,
      stop: async () => {},
      processPromptPhase: async () => {
        promptRun.push('B');
      },
      redrawSceneWithSavedPrompt: async (chapKey, sceneIdx) => { imagesRun.push(`B_${sceneIdx}`); },
      projectProgress: { getCompletedChapters: () => ({}), save: async () => {} },
      chapters: []
    }
  };

  const manager = new GlobalQueueManager({
    getPipeline: async (name) => mockPipelines[name],
    broadcastSSE: () => {},
    cooldownManager: { getState: () => ({ isCooling: false }) }
  });

  // 阻止自动快速消费以进行取消测试
  manager.imageQueue.running = true;

  manager.enqueueImageJob({ projectName: 'ProjectA', chapterKey: '第1章', sceneIdx: 1 });
  manager.enqueueImageJob({ projectName: 'ProjectB', chapterKey: '第1章', sceneIdx: 1 });
  manager.enqueueImageJob({ projectName: 'ProjectA', chapterKey: '第1章', sceneIdx: 2 });
  manager.enqueueImageJob({ projectName: 'ProjectB', chapterKey: '第1章', sceneIdx: 2 });

  assert.equal(manager.imageQueue.items.length, 4);

  // 取消 ProjectA
  await manager.cancelProjectJobs('ProjectA');

  assert.equal(manager.imageQueue.items.length, 2);
  assert.equal(manager.imageQueue.items[0].projectName, 'ProjectB');
  assert.equal(manager.imageQueue.items[1].projectName, 'ProjectB');

  // 恢复消费
  manager.imageQueue.running = false;
  void manager._processImageQueue();

  while (manager.imageQueue.running || manager.imageQueue.items.length > 0 || manager.imageQueue.current) {
    await new Promise(r => setTimeout(r, 15));
  }

  assert.deepEqual(imagesRun, ['B_1', 'B_2']);
});

test('GlobalQueueManager: 状态快照与向后兼容方法', async () => {
  const manager = new GlobalQueueManager({
    getPipeline: async () => ({}),
    broadcastSSE: () => {},
    cooldownManager: { getState: () => ({ isCooling: true, remainingSeconds: 12 }) }
  });

  manager.enqueuePromptJob({ projectName: 'Proj1', type: 'pipeline' });
  manager.enqueueImageJob({ projectName: 'Proj1', chapterKey: '第1章', sceneIdx: 5 });

  const globalState = manager.getGlobalState();
  assert.ok(globalState.promptQueue);
  assert.ok(globalState.imageQueue);
  assert.equal(globalState.cooldown.isCooling, true);

  const projState = manager.getProjectQueueState('Proj1');
  assert.equal(projState.busy, true);
  assert.ok(projState.redrawQueue);
  assert.ok(projState.chapterQueue);
  assert.ok(projState.globalQueue);
  assert.equal(projState.cooldown.remainingSeconds, 12);
});
