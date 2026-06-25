import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCharacterReferenceSummary,
  characterHasSceneDetails,
  syncSceneCharacterInteractions,
  syncSceneCharactersFromNames
} from './sceneEditorCharacters.js';

test('characterHasSceneDetails detects whether lightweight scene characters have manual details', () => {
  assert.equal(
    characterHasSceneDetails({
      appearance: '',
      clothing: '',
      expression: '',
      pose: '',
      position: ''
    }),
    false
  );

  assert.equal(
    characterHasSceneDetails({
      appearance: '',
      clothing: '',
      expression: '',
      pose: '',
      position: 'left'
    }),
    true
  );
});

test('buildCharacterReferenceSummary summarizes stable dna features for lightweight cards', () => {
  const summary = buildCharacterReferenceSummary({
    gender: 'woman',
    features: {
      外貌标签: ['beautiful'],
      发型标签: ['long hair'],
      发色标签: ['black hair'],
      眼睛标签: ['red eyes'],
      服装基底标签: ['white dress']
    }
  });

  assert.match(summary, /woman/i);
  assert.match(summary, /beautiful/i);
  assert.match(summary, /long hair/i);
  assert.match(summary, /white dress/i);
});

test('buildCharacterReferenceSummary returns empty string when no stable dna is available', () => {
  assert.equal(buildCharacterReferenceSummary({}), '');
  assert.equal(buildCharacterReferenceSummary({ features: {} }), '');
});

test('syncSceneCharactersFromNames builds lightweight characters from Character Names and preserves manual details', () => {
  const result = syncSceneCharactersFromNames('钰慧, 阿宾', [
    {
      name: '钰慧',
      gender: 'woman',
      appearance: 'long hair',
      clothing: '',
      expression: 'shy',
      pose: '',
      position: 'left'
    }
  ], {
    阿宾: { gender: 'man' }
  });

  assert.deepEqual(result, [
    {
      name: '钰慧',
      gender: 'woman',
      appearance: 'long hair',
      clothing: '',
      expression: 'shy',
      pose: '',
      position: 'left'
    },
    {
      name: '阿宾',
      gender: 'man',
      appearance: '',
      clothing: '',
      expression: '',
      pose: '',
      position: ''
    }
  ]);
});

test('syncSceneCharactersFromNames drops removed names and deduplicates repeated names', () => {
  const result = syncSceneCharactersFromNames('阿宾\n阿宾\n王忆如', [
    {
      name: '旧角色',
      gender: 'unknown',
      appearance: 'unused',
      clothing: '',
      expression: '',
      pose: '',
      position: ''
    }
  ]);

  assert.deepEqual(result.map((item) => item.name), ['阿宾', '王忆如']);
});

test('syncSceneCharacterInteractions keeps interactions aligned to character names and seeds generated values', () => {
  const result = syncSceneCharacterInteractions(
    [
      { name: '钰慧' },
      { name: '阿宾' }
    ],
    [
      { role: 'source', action: 'undressing', target: '阿宾' }
    ],
    [
      { name: '阿宾', role: 'target', action: 'undressing', target: '钰慧' }
    ]
  );

  assert.deepEqual(result, [
    { role: 'source', action: 'undressing', target: '阿宾' },
    { role: 'target', action: 'undressing', target: '钰慧' }
  ]);
});
