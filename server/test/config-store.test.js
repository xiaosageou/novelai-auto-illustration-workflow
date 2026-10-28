import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ENV_FILENAME,
  ENDPOINT_FIELDS,
  SECRETS_FILENAME,
  SECRET_FIELDS,
  SENSITIVE_FIELDS,
  envKeyFor,
  envToSecrets,
  mergeConfig,
  parseEnv,
  presetEnvKey,
  readConfig,
  resolveEnvPath,
  resolveSecretsPath,
  secretsToEnv,
  splitConfig,
  updateEnvText,
  writeConfig
} from '../utils/config-store.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cfg-env-'));
}

const SAMPLE = {
  llm_url: 'https://api.example.com/v1',
  llm_key: 'sk-top-secret',
  llm_model: 'some-model',
  llm_scene_url: 'https://scene.example.com/v1',
  llm_scene_key: 'sk-scene-secret',
  llm_trim_key: '',
  nai_url: 'https://image.novelai.net',
  nai_token: 'pst-nai-secret',
  proxy_url: 'http://127.0.0.1:10808',
  nai_model: 'nai-diffusion-4-5-full',
  steps: 28,
  artistStylePrompt: 'masterpiece, best quality',
  llm_api_presets: [
    { id: 'p1', name: 'first', url: 'https://a/v1', key: 'sk-preset-1', model: 'm', rateLimitEnabled: false, rateLimitRpm: 3 },
    { id: 'p2', name: 'second', url: 'https://b/v1', key: 'sk-preset-2', model: 'm', rateLimitEnabled: true, rateLimitRpm: 5 }
  ]
};

test('splitConfig 把端点和密钥一起搬出公开配置', () => {
  const { publicConfig, secrets } = splitConfig(SAMPLE);

  for (const field of SENSITIVE_FIELDS) {
    if (field in publicConfig) {
      assert.equal(publicConfig[field], '', `${field} 在公开配置里必须为空`);
    }
  }
  assert.deepEqual([...ENDPOINT_FIELDS].sort(), [
    'llm_character_dna_url', 'llm_nai_tags_url', 'llm_scene_url', 'llm_trim_url',
    'llm_url', 'nai_url', 'proxy_url'
  ].sort());

  assert.equal(secrets.llm_url, 'https://api.example.com/v1', '端点必须进密钥侧');
  assert.equal(secrets.llm_key, 'sk-top-secret');
  assert.equal(secrets.llm_scene_url, 'https://scene.example.com/v1');
  assert.equal(secrets.nai_token, 'pst-nai-secret');
  assert.equal(secrets.nai_url, 'https://image.novelai.net');
  assert.equal(secrets.proxy_url, 'http://127.0.0.1:10808');
  assert.equal(secrets.llm_trim_key, undefined, '空值不写入');

  assert.deepEqual(secrets.llm_api_presets, {
    p1: { url: 'https://a/v1', key: 'sk-preset-1' },
    p2: { url: 'https://b/v1', key: 'sk-preset-2' }
  });
  assert.equal(publicConfig.llm_api_presets[0].url, '', '预设端点同样不能留在公开配置');
  assert.equal(publicConfig.llm_api_presets[0].key, '');
  assert.equal(publicConfig.llm_api_presets[0].name, 'first', '非敏感字段保留');
  assert.equal(publicConfig.llm_api_presets[1].rateLimitRpm, 5);

  // 非敏感字段一字不动
  assert.equal(publicConfig.llm_model, 'some-model');
  assert.equal(publicConfig.steps, 28);
  assert.equal(publicConfig.artistStylePrompt, SAMPLE.artistStylePrompt);
});

test('splitConfig 对空配置与畸形 presets 不抛错', () => {
  assert.deepEqual(splitConfig({}).secrets, {});
  const { publicConfig } = splitConfig({ llm_api_presets: [null, 'x', { id: 'p9' }] });
  assert.equal(publicConfig.llm_api_presets[0], null);
  assert.equal(publicConfig.llm_api_presets[1], 'x');
  assert.equal(publicConfig.llm_api_presets[2].url, '');
});

test('mergeConfig 还原端点、密钥与预设端点', () => {
  const { publicConfig, secrets } = splitConfig(SAMPLE);
  const merged = mergeConfig(publicConfig, secrets);

  assert.equal(merged.llm_url, 'https://api.example.com/v1');
  assert.equal(merged.llm_key, 'sk-top-secret');
  assert.equal(merged.nai_token, 'pst-nai-secret');
  assert.equal(merged.proxy_url, 'http://127.0.0.1:10808');
  assert.equal(merged.llm_api_presets[0].url, 'https://a/v1');
  assert.equal(merged.llm_api_presets[0].key, 'sk-preset-1');
  assert.equal(merged.llm_api_presets[1].key, 'sk-preset-2');
  assert.equal(merged.steps, 28);

  const withStale = mergeConfig({ ...publicConfig, nai_token: 'pst-stale' }, secrets);
  assert.equal(withStale.nai_token, 'pst-nai-secret', '密钥优先于公开配置里的残留值');
});

test('mergeConfig 兼容旧版字符串形式预设密钥并保留公开端点', () => {
  const publicConfig = { llm_api_presets: [{ id: 'p1', name: 'a', url: 'https://a/v1', key: '' }] };
  const merged = mergeConfig(publicConfig, { llm_api_presets: { p1: 'sk-legacy' } });

  assert.equal(merged.llm_api_presets[0].key, 'sk-legacy');
  assert.equal(merged.llm_api_presets[0].url, 'https://a/v1', '缺失的端点回落到公开配置');
});

test('env 变量名映射', () => {
  assert.equal(envKeyFor('llm_url'), 'LLM_URL');
  assert.equal(envKeyFor('llm_character_dna_key'), 'LLM_CHARACTER_DNA_KEY');
  assert.equal(envKeyFor('nai_token'), 'NAI_TOKEN');
  assert.equal(presetEnvKey('1781579277070', 'url'), 'LLM_PRESET_1781579277070_URL');
  assert.equal(presetEnvKey('p1', 'key'), 'LLM_PRESET_P1_KEY');
});

test('parseEnv 支持注释、export、引号与空值', () => {
  const env = parseEnv([
    '# comment',
    '',
    'LLM_URL=https://api.example.com/v1',
    'export NAI_TOKEN="pst-quoted"',
    "PROXY_URL='http://127.0.0.1:10808'",
    'LLM_KEY=',
    'not a valid line'
  ].join('\n'));

  assert.equal(env.LLM_URL, 'https://api.example.com/v1');
  assert.equal(env.NAI_TOKEN, 'pst-quoted');
  assert.equal(env.PROXY_URL, 'http://127.0.0.1:10808');
  assert.equal(env.LLM_KEY, '');
  assert.equal(env['not a valid line'], undefined);
});

test('updateEnvText 就地改值、追加新键并保留手写注释', () => {
  const before = '# 我的注释\nLLM_URL=old\nLLM_KEY=\n';
  const after = updateEnvText(before, { LLM_URL: 'new', LLM_KEY: 'sk-1', NAI_TOKEN: 'pst-1' });

  assert.ok(after.includes('# 我的注释'), '注释必须保留');
  assert.ok(after.includes('LLM_URL=new'));
  assert.ok(after.includes('LLM_KEY=sk-1'));
  assert.ok(after.includes('NAI_TOKEN=pst-1'), '新键追加到末尾');
  assert.ok(!after.includes('LLM_URL=old'));
});

test('secretsToEnv 与 envToSecrets 往返一致', () => {
  const { secrets } = splitConfig(SAMPLE);
  const roundTrip = envToSecrets(secretsToEnv(secrets));

  assert.equal(roundTrip.llm_url, secrets.llm_url);
  assert.equal(roundTrip.llm_key, secrets.llm_key);
  assert.equal(roundTrip.nai_token, secrets.nai_token);
  assert.equal(roundTrip.proxy_url, secrets.proxy_url);
  assert.equal(roundTrip.llm_api_presets.P1.url, 'https://a/v1', 'env 变量名大写，读回后按 id 大小写不敏感匹配');
  assert.equal(roundTrip.llm_api_presets.P1.key, 'sk-preset-1');
});

test('resolveEnvPath 与主配置同目录', () => {
  const configPath = path.join('C:', 'proj', 'illustrator_config.json');
  assert.equal(path.basename(resolveEnvPath(configPath)), ENV_FILENAME);
  assert.equal(path.dirname(resolveEnvPath(configPath)), path.join('C:', 'proj'));
  assert.equal(path.basename(resolveSecretsPath(configPath)), SECRETS_FILENAME);
});

test('writeConfig 落盘：主文件无端点无密钥，.env 有', async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, 'illustrator_config.json');

  await writeConfig(configPath, SAMPLE);

  const publicText = await fs.readFile(configPath, 'utf8');
  const publicRaw = JSON.parse(publicText);
  const envText = await fs.readFile(path.join(dir, ENV_FILENAME), 'utf8');

  assert.equal(publicRaw.llm_key, '');
  assert.equal(publicRaw.llm_url, '');
  assert.equal(publicRaw.llm_api_presets[0].url, '');
  assert.equal(publicRaw.llm_api_presets[0].key, '');
  assert.equal(publicRaw.steps, 28);

  // 主文件里不得出现任何端点或密钥明文
  for (const leak of ['sk-top-secret', 'pst-nai-secret', 'sk-preset-1', 'api.example.com', '127.0.0.1:10808', 'image.novelai.net']) {
    assert.ok(!publicText.includes(leak), `主配置不得包含 ${leak}`);
  }

  assert.ok(envText.includes('LLM_URL=https://api.example.com/v1'));
  assert.ok(envText.includes('LLM_KEY=sk-top-secret'));
  assert.ok(envText.includes('NAI_TOKEN=pst-nai-secret'));
  assert.ok(envText.includes('LLM_PRESET_P1_URL=https://a/v1'));
  assert.ok(envText.includes('LLM_PRESET_P1_KEY=sk-preset-1'));
});

test('writeConfig 不会因为这次没带值就把 .env 里的旧值抹掉', async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, 'illustrator_config.json');

  await writeConfig(configPath, SAMPLE);
  await writeConfig(configPath, {
    ...SAMPLE,
    llm_key: '',
    llm_url: '',
    llm_api_presets: [{ id: 'p1', name: 'first', url: '', key: '', model: 'm' }],
    artistStylePrompt: 'new style'
  });

  const merged = await readConfig(configPath);
  assert.equal(merged.llm_key, 'sk-top-secret', '旧密钥必须保留');
  assert.equal(merged.llm_url, 'https://api.example.com/v1', '旧端点必须保留');
  assert.equal(merged.llm_api_presets[0].key, 'sk-preset-1');
  assert.equal(merged.artistStylePrompt, 'new style', '新值必须生效');
});

test('readConfig 从 .env 合并完整配置', async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, 'illustrator_config.json');

  await writeConfig(configPath, SAMPLE);
  const merged = await readConfig(configPath);

  assert.equal(merged.llm_url, 'https://api.example.com/v1');
  assert.equal(merged.llm_key, 'sk-top-secret');
  assert.equal(merged.nai_token, 'pst-nai-secret');
  assert.equal(merged.nai_url, 'https://image.novelai.net');
  assert.equal(merged.llm_api_presets[1].key, 'sk-preset-2', '预设 id 大小写不同也能对上');
});

test('readConfig 迁移旧版 secrets.json 到 .env 并删除旧文件', async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, 'illustrator_config.json');
  const secretsPath = path.join(dir, SECRETS_FILENAME);

  const publicPart = { ...SAMPLE, llm_key: '', nai_token: '' };
  await fs.writeFile(configPath, JSON.stringify(publicPart, null, 2), 'utf8');
  await fs.writeFile(secretsPath, JSON.stringify({ llm_key: 'sk-top-secret', nai_token: 'pst-nai-secret' }), 'utf8');

  const merged = await readConfig(configPath);
  assert.equal(merged.llm_key, 'sk-top-secret');
  assert.equal(merged.llm_url, 'https://api.example.com/v1', '端点也要一起搬进 .env');

  const envText = await fs.readFile(path.join(dir, ENV_FILENAME), 'utf8');
  assert.ok(envText.includes('LLM_KEY=sk-top-secret'));
  assert.ok(envText.includes('LLM_URL=https://api.example.com/v1'));

  await assert.rejects(fs.readFile(secretsPath), '旧密钥文件迁移后必须删除');

  const publicRaw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(publicRaw.llm_url, '', '主配置里的明文端点必须清掉');
});

test('readConfig 迁移主配置里的明文端点并留下备份', async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, 'illustrator_config.json');
  await fs.writeFile(configPath, JSON.stringify(SAMPLE, null, 2), 'utf8');

  const merged = await readConfig(configPath);
  assert.equal(merged.llm_key, 'sk-top-secret');
  assert.equal(merged.proxy_url, 'http://127.0.0.1:10808');

  const publicRaw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(publicRaw.llm_key, '');
  assert.equal(publicRaw.llm_url, '');
  assert.equal(publicRaw.proxy_url, '');
  assert.equal(publicRaw.llm_api_presets[0].url, '');

  const envText = await fs.readFile(path.join(dir, ENV_FILENAME), 'utf8');
  assert.ok(envText.includes('PROXY_URL=http://127.0.0.1:10808'));

  const backup = await fs.readFile(`${configPath}.bak-split`, 'utf8');
  assert.ok(backup.includes('sk-top-secret'), '备份保留原始内容以便回滚');
});

test('readConfig 对不含敏感字段的配置不创建 .env', async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, 'illustrator_config.json');
  await fs.writeFile(configPath, JSON.stringify({ steps: 28, llm_key: '', llm_url: '' }), 'utf8');

  const merged = await readConfig(configPath);
  assert.equal(merged.steps, 28);
  await assert.rejects(fs.readFile(path.join(dir, ENV_FILENAME)), '不应创建空 .env');
});

test('SECRET_FIELDS 与 ENDPOINT_FIELDS 不重叠', () => {
  const overlap = SECRET_FIELDS.filter(field => ENDPOINT_FIELDS.includes(field));
  assert.deepEqual(overlap, []);
  assert.equal(SENSITIVE_FIELDS.length, SECRET_FIELDS.length + ENDPOINT_FIELDS.length);
});
