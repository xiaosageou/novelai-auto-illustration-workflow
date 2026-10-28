import path from 'path';
import { promises as fs, existsSync } from 'fs';
import { readJson, writeJsonAtomic } from './db.js';

/**
 * 配置拆分存储（env 版）。
 *
 * illustrator_config.json  —— 可入库、可 diff 的普通配置：采样参数、system prompt、画风词
 * .env                     —— 只放「端点 + 密钥」，已被 .gitignore 忽略
 * illustrator_config.secrets.json —— 旧版密钥文件，只在迁移时读一次，迁移完删除
 *
 * 历史：最早的版本把所有东西塞进一个 json；后来拆出 secrets.json 但仍把端点留在主配置，
 * 导致自建 VPS 地址、本地代理端口这类基础设施信息跟着仓库一起公开。
 * 现在端点和密钥统一收敛到 .env，主配置里对应字段一律留空串。
 */

/** 顶层只放密钥的字段 */
export const SECRET_FIELDS = [
  'llm_key',
  'llm_character_dna_key',
  'llm_scene_key',
  'llm_nai_tags_key',
  'llm_trim_key',
  'nai_token'
];

/** 顶层端点 / 基础设施字段：同样不允许进可入库配置 */
export const ENDPOINT_FIELDS = [
  'llm_url',
  'llm_character_dna_url',
  'llm_scene_url',
  'llm_nai_tags_url',
  'llm_trim_url',
  'nai_url',
  'proxy_url'
];

/** 需要从公开配置里清空的全部字段 */
export const SENSITIVE_FIELDS = [...SECRET_FIELDS, ...ENDPOINT_FIELDS];

/** 旧版 json 密钥文件（仅迁移用） */
export const SECRETS_FILENAME = 'illustrator_config.secrets.json';

/** 新版 env 密钥文件 */
export const ENV_FILENAME = '.env';

export function resolveSecretsPath(configPath) {
  return path.join(path.dirname(configPath), SECRETS_FILENAME);
}

export function resolveEnvPath(configPath) {
  return path.join(path.dirname(configPath), ENV_FILENAME);
}

/** 字段名 -> env 变量名：llm_scene_url -> LLM_SCENE_URL */
export function envKeyFor(field) {
  return String(field).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** 预设字段 -> env 变量名：('p1','url') -> LLM_PRESET_P1_URL */
export function presetEnvKey(id, field) {
  const safeId = String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `LLM_PRESET_${safeId}_${String(field).toUpperCase()}`;
}

const SAFE_ENV_VALUE = /^[A-Za-z0-9_\-.:/@+,]*$/;

function formatEnvValue(value) {
  const text = String(value ?? '');
  if (SAFE_ENV_VALUE.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * 解析 env 文本。支持 # 注释、export 前缀、单双引号、\n 转义。
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseEnv(text = '') {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let rest = match[2].trim();
    if (rest.length >= 2 && ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'")))) {
      rest = rest.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    out[match[1]] = rest;
  }
  return out;
}

/**
 * 把 updates 合并进已有 env 文本：已存在的键就地改值，新键追加到末尾。
 * 用户手写的注释与未知变量原样保留。
 */
export function updateEnvText(text, updates = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const lineIndex = new Map();
  lines.forEach((line, i) => {
    const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) lineIndex.set(m[1], i);
  });

  const appended = [];
  for (const [key, rawValue] of Object.entries(updates)) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue);
    if (lineIndex.has(key)) {
      lines[lineIndex.get(key)] = `${key}=${formatEnvValue(value)}`;
    } else if (value) {
      appended.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  let result = lines.join('\n');
  if (appended.length) {
    if (result && !result.endsWith('\n')) result += '\n';
    result += `${appended.join('\n')}\n`;
  }
  return result;
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * env 变量表 -> secrets 对象（结构同旧版 json：顶层字段 + llm_api_presets 按 id 分组）
 */
export function envToSecrets(env = {}) {
  const secrets = {};
  for (const field of SENSITIVE_FIELDS) {
    const value = env[envKeyFor(field)];
    if (typeof value === 'string' && value) secrets[field] = value;
  }

  const presets = {};
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^LLM_PRESET_(.+)_(URL|KEY)$/);
    if (!match || !value) continue;
    const id = match[1];
    const field = match[2].toLowerCase();
    presets[id] = { ...(presets[id] || {}), [field]: value };
  }
  if (Object.keys(presets).length) secrets.llm_api_presets = presets;
  return secrets;
}

/** secrets 对象 -> env 变量表（只为非空值生成条目） */
export function secretsToEnv(secrets = {}) {
  const env = {};
  for (const field of SENSITIVE_FIELDS) {
    const value = secrets[field];
    if (typeof value === 'string' && value) env[envKeyFor(field)] = value;
  }
  const presets = secrets.llm_api_presets;
  if (presets && typeof presets === 'object') {
    for (const [id, entry] of Object.entries(presets)) {
      if (!entry) continue;
      const values = typeof entry === 'string' ? { key: entry } : entry;
      for (const field of ['url', 'key']) {
        const value = values[field];
        if (typeof value === 'string' && value) env[presetEnvKey(id, field)] = value;
      }
    }
  }
  return env;
}

/**
 * 把完整配置拆成「可公开」与「端点 + 密钥」两部分。
 * 公开部分里 SENSITIVE_FIELDS 一律留空，presets 只保留 id/name/model/限流参数。
 */
export function splitConfig(config = {}) {
  const publicConfig = { ...config };
  const secrets = {};

  for (const field of SENSITIVE_FIELDS) {
    const value = config[field];
    if (typeof value === 'string' && value.trim()) {
      secrets[field] = value;
    }
    if (field in publicConfig) publicConfig[field] = '';
  }

  if (Array.isArray(config.llm_api_presets)) {
    const presetSecrets = {};
    publicConfig.llm_api_presets = config.llm_api_presets.map(preset => {
      if (!preset || typeof preset !== 'object') return preset;
      const { key, url, ...rest } = preset;
      const entry = {};
      if (typeof url === 'string' && url.trim()) entry.url = url;
      if (typeof key === 'string' && key.trim()) entry.key = key;
      if (preset.id && Object.keys(entry).length) presetSecrets[preset.id] = entry;
      return { ...rest, url: '', key: '' };
    });
    if (Object.keys(presetSecrets).length) {
      secrets.llm_api_presets = presetSecrets;
    }
  }

  return { publicConfig, secrets };
}

function presetSecretEntry(entry) {
  if (!entry) return {};
  return typeof entry === 'string' ? { key: entry } : entry;
}

/** 合并两组预设密钥（旧版值是字符串时归一化成 { key }） */
function mergePresetSecrets(base = {}, extra = {}) {
  const ids = new Set([...Object.keys(base || {}), ...Object.keys(extra || {})]);
  const out = {};
  for (const id of ids) {
    const entry = { ...presetSecretEntry(base?.[id]), ...presetSecretEntry(extra?.[id]) };
    if (Object.keys(entry).length) out[id] = entry;
  }
  return out;
}

/** 按预设 id 查密钥；env 变量名大小写不敏感，所以这里也大小写不敏感匹配 */
function lookupPresetSecret(presetSecrets = {}, id) {
  if (!presetSecrets || !id) return undefined;
  if (presetSecrets[id] !== undefined) return presetSecrets[id];
  const target = String(id).toLowerCase();
  for (const [key, value] of Object.entries(presetSecrets)) {
    if (String(key).toLowerCase() === target) return value;
  }
  return undefined;
}

/**
 * 把公开配置与端点/密钥合并回完整配置。secrets 优先，缺失时回落到公开配置里的残留值。
 */
export function mergeConfig(publicConfig = {}, secrets = {}) {
  const merged = { ...publicConfig };

  for (const field of SENSITIVE_FIELDS) {
    const secretValue = secrets[field];
    if (typeof secretValue === 'string' && secretValue) {
      merged[field] = secretValue;
    }
  }

  if (Array.isArray(merged.llm_api_presets)) {
    const presetSecrets = secrets.llm_api_presets || {};
    merged.llm_api_presets = merged.llm_api_presets.map(preset => {
      if (!preset || typeof preset !== 'object') return preset;
      const entry = presetSecretEntry(lookupPresetSecret(presetSecrets, preset.id));
      return {
        ...preset,
        url: typeof entry.url === 'string' && entry.url ? entry.url : (preset.url || ''),
        key: typeof entry.key === 'string' && entry.key ? entry.key : (preset.key || '')
      };
    });
  }

  return merged;
}

/**
 * 读取并合并配置。
 * 优先级：.env > 旧版 secrets.json（迁移后删除）> 主配置里残留的明文（迁移）。
 */
export async function readConfig(configPath, options = {}) {
  const envPath = options.envPath || resolveEnvPath(configPath);
  const secretsPath = options.secretsPath || resolveSecretsPath(configPath);
  const publicConfig = await readJson(configPath, {});
  if (!publicConfig || typeof publicConfig !== 'object') {
    return mergeConfig({}, {});
  }

  if (existsSync(envPath)) {
    return mergeConfig(publicConfig, envToSecrets(parseEnv(await readText(envPath))));
  }

  // 迁移旧版 json 密钥文件
  if (existsSync(secretsPath)) {
    const legacy = await readJson(secretsPath, {});
    const secrets = legacy && typeof legacy === 'object' ? legacy : {};
    const fromPublic = splitConfig(publicConfig);
    const combined = { ...fromPublic.secrets, ...secrets };
    combined.llm_api_presets = mergePresetSecrets(fromPublic.secrets.llm_api_presets, secrets.llm_api_presets);
    if (!Object.keys(combined.llm_api_presets).length) delete combined.llm_api_presets;
    try {
      await fs.writeFile(envPath, buildEnvText(combined), 'utf8');
      await writeJsonAtomic(configPath, fromPublic.publicConfig);
      await fs.unlink(secretsPath).catch(() => {});
      console.warn(`[Config] 已把端点和密钥迁移到 ${ENV_FILENAME}，旧密钥文件已删除`);
    } catch (err) {
      console.error(`[Config] 迁移到 ${ENV_FILENAME} 失败，继续使用旧密钥文件: ${err.message}`);
      return mergeConfig(publicConfig, secrets);
    }
    return mergeConfig(fromPublic.publicConfig, combined);
  }

  // 迁移主配置里的明文（端点或密钥）
  const { publicConfig: sanitized, secrets } = splitConfig(publicConfig);
  if (!Object.keys(secrets).length) {
    return mergeConfig(publicConfig, {});
  }

  try {
    const backupPath = `${configPath}.bak-split`;
    if (!existsSync(backupPath)) {
      await fs.copyFile(configPath, backupPath);
    }
    await fs.writeFile(envPath, buildEnvText(secrets), 'utf8');
    await writeJsonAtomic(configPath, sanitized);
    console.warn(`[Config] 已把端点和密钥迁移到 ${ENV_FILENAME}，主配置已去除明文（备份 ${path.basename(backupPath)}）`);
  } catch (err) {
    console.error(`[Config] 迁移到 ${ENV_FILENAME} 失败，继续使用内存中的完整配置: ${err.message}`);
    return publicConfig;
  }

  return mergeConfig(sanitized, secrets);
}

/** 新文件的初始内容：带注释头 */
function buildEnvText(secrets = {}) {
  const header = [
    '# NovelAI 配图工作站 · 端点与密钥',
    '# 本文件已被 .gitignore 忽略，不要提交。字段留空表示未配置。',
    ''
  ].join('\n');
  return `${header}${updateEnvText('', secretsToEnv(secrets)).replace(/^\n+/, '')}`;
}

/**
 * 拆分写入：主配置写公开部分，端点与密钥写进 .env。
 * 这次没带上的值保留 .env 里的旧值，避免前端只改画风词时把 token 抹掉。
 */
export async function writeConfig(configPath, config, options = {}) {
  const envPath = options.envPath || resolveEnvPath(configPath);
  const { publicConfig, secrets } = splitConfig(config);

  const existingText = await readText(envPath);
  const updates = secretsToEnv(secrets);
  const nextText = existingText && existingText.trim()
    ? updateEnvText(existingText, updates)
    : buildEnvText(secrets);

  await writeJsonAtomic(configPath, publicConfig);
  if (nextText.trim()) {
    await fs.writeFile(envPath, nextText, 'utf8');
  }
  return { publicConfig, secrets };
}
