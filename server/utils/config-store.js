import path from 'path';
import { promises as fs, existsSync } from 'fs';
import { readJson, writeJsonAtomic } from './db.js';

/**
 * 配置拆分存储。
 *
 * illustrator_config.json    —— 可入库、可版本管理、可 diff 的普通配置
 * illustrator_config.secrets.json —— 只放密钥，已被 .gitignore 忽略
 *
 * 旧版把所有东西塞在一个文件里，导致整个配置文件被 gitignore，
 * 连带 system prompt、采样参数、画风词这些本该纳入版本管理的内容也一起丢了。
 */

// 顶层需要保密的字段
export const SECRET_FIELDS = [
  'llm_key',
  'llm_character_dna_key',
  'llm_scene_key',
  'llm_nai_tags_key',
  'llm_trim_key',
  'nai_token'
];

export const SECRETS_FILENAME = 'illustrator_config.secrets.json';

export function resolveSecretsPath(configPath) {
  return path.join(path.dirname(configPath), SECRETS_FILENAME);
}

/**
 * 把完整配置拆成「可公开」与「密钥」两部分。
 * 公开部分里的敏感字段一律留空，presets 里只保留 id/name/url/model/限流参数。
 */
export function splitConfig(config = {}) {
  const publicConfig = { ...config };
  const secrets = {};

  for (const field of SECRET_FIELDS) {
    const value = config[field];
    if (typeof value === 'string' && value.trim()) {
      secrets[field] = value;
    }
    publicConfig[field] = '';
  }

  if (Array.isArray(config.llm_api_presets)) {
    const presetKeys = {};
    publicConfig.llm_api_presets = config.llm_api_presets.map(preset => {
      if (!preset || typeof preset !== 'object') return preset;
      const { key, ...rest } = preset;
      if (preset.id && typeof key === 'string' && key.trim()) {
        presetKeys[preset.id] = key;
      }
      return { ...rest, key: '' };
    });
    if (Object.keys(presetKeys).length) {
      secrets.llm_api_presets = presetKeys;
    }
  }

  return { publicConfig, secrets };
}

/**
 * 把公开配置与密钥合并回完整配置。密钥优先，缺失时回落到公开配置里的残留值。
 */
export function mergeConfig(publicConfig = {}, secrets = {}) {
  const merged = { ...publicConfig };

  for (const field of SECRET_FIELDS) {
    const secretValue = secrets[field];
    if (typeof secretValue === 'string' && secretValue) {
      merged[field] = secretValue;
    }
  }

  if (Array.isArray(merged.llm_api_presets)) {
    const presetKeys = secrets.llm_api_presets || {};
    merged.llm_api_presets = merged.llm_api_presets.map(preset => {
      if (!preset || typeof preset !== 'object') return preset;
      const secretKey = presetKeys[preset.id];
      return {
        ...preset,
        key: typeof secretKey === 'string' && secretKey ? secretKey : (preset.key || '')
      };
    });
  }

  return merged;
}

/**
 * 读取并合并配置。若密钥文件不存在而主配置里还留着明文密钥，就地迁移并备份。
 */
export async function readConfig(configPath, options = {}) {
  const secretsPath = options.secretsPath || resolveSecretsPath(configPath);
  const publicConfig = await readJson(configPath, {});
  if (!publicConfig || typeof publicConfig !== 'object') {
    return mergeConfig({}, {});
  }

  if (existsSync(secretsPath)) {
    const secrets = await readJson(secretsPath, {});
    return mergeConfig(publicConfig, secrets && typeof secrets === 'object' ? secrets : {});
  }

  // 迁移旧版单文件配置
  const { publicConfig: sanitized, secrets } = splitConfig(publicConfig);
  if (!Object.keys(secrets).length) {
    return mergeConfig(publicConfig, {});
  }

  try {
    const backupPath = `${configPath}.bak-split`;
    if (!existsSync(backupPath)) {
      await fs.copyFile(configPath, backupPath);
    }
    await writeJsonAtomic(secretsPath, secrets);
    await writeJsonAtomic(configPath, sanitized);
    console.warn(`[Config] 已把密钥迁移到 ${path.basename(secretsPath)}，主配置已去除明文密钥（备份 ${path.basename(backupPath)}）`);
  } catch (err) {
    console.error(`[Config] 密钥迁移失败，继续使用内存中的完整配置: ${err.message}`);
    return publicConfig;
  }

  return mergeConfig(sanitized, secrets);
}

/**
 * 拆分写入：主配置写公开部分，密钥单独写密钥文件。
 * 这次没带上的密钥键保留旧值，避免前端只改画风词时把 token 抹掉。
 */
export async function writeConfig(configPath, config, options = {}) {
  const secretsPath = options.secretsPath || resolveSecretsPath(configPath);
  const { publicConfig, secrets } = splitConfig(config);

  const existing = existsSync(secretsPath) ? await readJson(secretsPath, {}) : {};
  const mergedSecrets = { ...(existing && typeof existing === 'object' ? existing : {}) };

  for (const [field, value] of Object.entries(secrets)) {
    if (field === 'llm_api_presets') continue;
    mergedSecrets[field] = value;
  }
  if (secrets.llm_api_presets) {
    mergedSecrets.llm_api_presets = {
      ...(existing?.llm_api_presets || {}),
      ...secrets.llm_api_presets
    };
  }

  await writeJsonAtomic(configPath, publicConfig);
  if (Object.keys(mergedSecrets).length) {
    await writeJsonAtomic(secretsPath, mergedSecrets);
  }
  return { publicConfig, secrets: mergedSecrets };
}
