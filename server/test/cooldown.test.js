import test from 'node:test';
import assert from 'node:assert/strict';
import { CooldownManager } from '../utils/cooldown.js';

test('cooldown degrades after three consecutive 429 responses and recovers after five successes', () => {
  const cooldown = new CooldownManager(15, 35);

  cooldown.record429();
  cooldown.record429();
  assert.equal(cooldown.getState().mode, 'normal');
  assert.equal(cooldown.getState().cooldownSeconds, 15);

  cooldown.record429();
  assert.equal(cooldown.getState().mode, 'degraded');
  assert.equal(cooldown.getState().cooldownSeconds, 35);

  for (let index = 0; index < 4; index++) cooldown.recordSuccess();
  assert.equal(cooldown.getState().mode, 'degraded');

  cooldown.record429();
  assert.equal(cooldown.getState().degradedSuccesses, 0);

  for (let index = 0; index < 4; index++) cooldown.recordSuccess();
  assert.equal(cooldown.getState().mode, 'degraded');

  cooldown.recordSuccess();
  assert.equal(cooldown.getState().mode, 'normal');
  assert.equal(cooldown.getState().cooldownSeconds, 15);
});

test('configured base cooldown is clamped and does not change fixed degraded interval', () => {
  const cooldown = new CooldownManager(15, 35);
  cooldown.setBaseCooldownSeconds(8);
  assert.equal(cooldown.getState().cooldownSeconds, 8);

  cooldown.record429();
  cooldown.record429();
  cooldown.record429();
  cooldown.setBaseCooldownSeconds(12);
  assert.equal(cooldown.getState().baseCooldownSeconds, 12);
  assert.equal(cooldown.getState().cooldownSeconds, 35);
});
