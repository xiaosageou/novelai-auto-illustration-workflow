import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SECRET_FIELDS,
  SECRETS_FILENAME,
  resolveSecretsPath,
  splitConfig,
  mergeConfig,
  readConfig,
  writeConfig
} from '../utils/config-store.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cfg-store-'));
}

const SAMPLE = {
  llm_url: 'https://api.example.com/v1',
  llm_key: 'sk-top-secret',
  llm_model: 'some-model',
  llm_scene_key: 'sk-scene-secret',
  llm_trim_key: '',
  nai_token: 'pst-nai-secret',
  nai_model: 'nai-diffusion-4-5-full',
  steps: 28,
  artistStylePrompt: 'masterpiece, best quality',
  llm_api_presets: [
    { id: 'p1', name: 'first', url: 'https://a/v1', key: 'sk-preset-1', model: 'm', rateLimitEnabled: false, rateLimitRpm: 3 },
    { id: 'p2', name: 'second', url: 'https://b/v1', key: 'sk-preset-2', model: 'm', rateLimitEnabled: true, rateLimitRpm: 5 }
  ]
};

test('splitConfig 把密钥搬到 secrets，公开部分密钥位留空', () => {
  const { publicConfig, secrets } = splitConfig(SAMPLE);

  for (const field of SECRET_FIELDS) {
    assert.equal(publicConfig[field], '', `${field} 在公开配置里必须为空`);
  }
  assert.equal(secrets.llm_key, 'sk-top-secret');
  assert.equal(secrets.llm_scene_key, 'sk-scene-secret');
  assert.equal(secrets.nai_token, 'pst-nai-secret');
  assert.equal(secrets.llm_trim_key, undefined, '空密钥不写入 secrets');

  assert.deepEqual(secrets.llm_api_presets, { p1: 'sk-preset-1', p2: 'sk-preset-2' });
  assert.equal(publicConfig.llm_api_presets[0].key, '');
  assert.equal(publicConfig.llm_api_presets[1].key, '');
  assert.equal(publicConfig.llm_api_presets[0].url, 'https://a/v1', '预设的普通字段必须保留');
  assert.equal(publicConfig.llm_api_presets[1].rateLimitRpm, 5);

  // 非密钥字段一字不动
  assert.equal(publicConfig.llm_url, SAMPLE.llm_url);
  assert.equal(publicConfig.steps, 28);
  assert.equal(publicConfig.artistStylePrompt, SAMPLE.artistStylePrompt);
});

test('mergeConfig 把密钥还原，且密钥优先于公开配置里的残留值', () => {
  const { publicConfig, secrets } = splitConfig(SAMPLE);
  const merged = mergeConfig(publicConfig, secrets);

  assert.equal(merged.llm_key, 'sk-top-secret');
  assert.equal(merged.nai_token, 'pst-nai-secret');
  assert.equal(merged.llm_api_presets[0].key, 'sk-preset-1');
  assert.equal(merged.llm_api_presets[1].key, 'sk-preset-2');
  assert.equal(merged.steps, 28);

  // secrets 覆盖公开配置里的旧值
  const withStale = mergeConfig({ ...publicConfig, nai_token: 'pst-stale' }, secrets);
  assert.equal(withStale.nai_token, 'pst-nai-secret');
});

test('mergeConfig 在密钥缺失时回落到公开配置里的残留值', () => {
  const merged = mergeConfig({ llm_key: 'legacy-key', nai_token: '' }, {});
  assert.equal(merged.llm_key, 'legacy-key');
  assert.equal(merged.nai_token, '');
});

test('splitConfig 对空配置与畸形 presets 不抛错', () => {
  assert.deepEqual(splitConfig({}).secrets, {});
  const { publicConfig } = splitConfig({ llm_api_presets: [null, 'x', { id: 'p9' }] });
  assert.equal(publicConfig.llm_api_presets[0], null);
  assert.equal(publicConfig.llm_api_presets[1], 'x');
  assert.equal(publicConfig.llm_api_presets[2].key, '');
});

test('resolveSecretsPath 与主配置同目录', () => {
  const p = resolveSecretsPath(path.join('C:', 'proj', 'illustrator_config.json'));
  assert.equal(path.basename(p), SECRETS_FILENAME);
  assert.equal(path.dirname(p), path.join('C:', 'proj'));
});

test('writeConfig 拆分落盘：主文件无密钥，密钥文件有密钥', async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, 'illustrator_config.json');

  await writeConfig(configPath, SAMPLE);

  const publicRaw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const secretsRaw = JSON.parse(await fs.readFile(path.join(dir, SECRETS_FILENAME), 'utf8'));

  assert.equal(publicRaw.llm_key, '');
  assert.equal(publicRaw.nai_token, '');
  assert.equal(publicRaw.llm_api_presets[0].key, '');
  assert.equal(publicRaw.steps, 28);

  assert.equal(secretsRaw.llm_key, 'sk-top-secret');
  assert.equal(secretsRaw.nai_token, 'pst-nai-secret');
  assert.equal(secretsRaw.llm_api_presets.p1, 'sk-preset-1');

  // 主文件里不应出现任何明文密钥字符串
  const publicText = await fs.readFile(configPath, 'utf8');
  assert.ok(!publicText.includes('sk-top-secret'));
  assert.ok(!publicText.includes('pst-nai-secret'));
  assert.ok(!publicText.includes('sk-preset-1'));
});

test('writeConfig 不会因为这次没带密钥就把旧密钥抹掉', async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, 'illustrator_config.json');

  await writeConfig(configPath, SAMPLE);
  // 模拟前端只改画风词、key 字段回传为空
  await writeConfig(configPath, { ...SAMPLE, llm_key: '', artistStylePrompt: 'new style' });

  const merged = await readConfig(configPath);
  assert.equal(merged.llm_key, 'sk-top-secret', '旧密钥必须保留');
  assert.equal(merged.artistStylePrompt, 'new style', '新值必须生效');
  assert.equal(merged.llm_api_presets[0].key, 'sk-preset-1');
});

test('readConfig 读回合并后的完整配置', async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, 'illustrator_config.json');

  await writeConfig(configPath, SAMPLE);
  const merged = await readConfig(configPath);

  assert.equal(merged.llm_key, 'sk-top-secret');
  assert.equal(merged.nai_token, 'pst-nai-secret');
  assert.equal(merged.llm_api_presets[1].key, 'sk-preset-2');
  assert.equal(merged.llm_url, SAMPLE.llm_url);
});

test('readConfig 自动迁移旧版单文件配置并留下备份', async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, 'illustrator_config.json');
  await fs.writeFile(configPath, JSON.stringify(SAMPLE, null, 2), 'utf8');

  const merged = await readConfig(configPath);
  assert.equal(merged.llm_key, 'sk-top-secret', '迁移后仍能读到密钥');

  const publicRaw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(publicRaw.llm_key, '', '主文件必须去掉明文密钥');
  assert.equal(publicRaw.llm_api_presets[0].key, '');

  const secretsRaw = JSON.parse(await fs.readFile(path.join(dir, SECRETS_FILENAME), 'utf8'));
  assert.equal(secretsRaw.llm_key, 'sk-top-secret');

  const backup = await fs.readFile(`${configPath}.bak-split`, 'utf8');
  assert.ok(backup.includes('sk-top-secret'), '备份必须保留原始内容以便回滚');
});

test('readConfig 对不含密钥的配置不生成密钥文件', async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, 'illustrator_config.json');
  await fs.writeFile(configPath, JSON.stringify({ steps: 28, llm_key: '' }), 'utf8');

  const merged = await readConfig(configPath);
  assert.equal(merged.steps, 28);
  await assert.rejects(fs.readFile(path.join(dir, SECRETS_FILENAME)), '不应创建空密钥文件');
});
