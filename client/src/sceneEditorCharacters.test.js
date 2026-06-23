import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCharacterReferenceSummary,
  characterHasSceneDetails
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
