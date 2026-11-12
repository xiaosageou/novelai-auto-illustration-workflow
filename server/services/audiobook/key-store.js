/**
 * MiMo 凭证读写：复用项目已有的 .env 约定。
 *
 * 密钥只落在 BASE_DIR/.env（已被 .gitignore 忽略），前端填写后立即写盘，
 * 任何接口都不回传明文，只回传掩码。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import { parseEnv, updateEnvText } from '../../utils/config-store.js';

export function envPathFor(baseDir) {
  // 容器部署时 .env 写在镜像层会随重建丢失，用 AUDIOBOOK_ENV_FILE 指向挂载目录
  const override = String(process.env.AUDIOBOOK_ENV_FILE || '').trim();
  return override ? path.resolve(override) : path.join(baseDir, '.env');
}

export function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 10) return '***';
  return `${value.slice(0, 4)}${'*'.repeat(6)}${value.slice(-4)}`;
}

/** 读取 MiMo 配置：.env 优先，其次进程环境变量 */
export async function readMimoConfig(baseDir) {
  let env = {};
  try {
    env = parseEnv(await fs.readFile(envPathFor(baseDir), 'utf8'));
  } catch {
    env = {};
  }
  const apiKey = (env.MIMO_API_KEY || process.env.MIMO_API_KEY || '').trim();
  const baseUrl = (env.MIMO_BASE_URL || process.env.MIMO_BASE_URL || '').trim();
  return { apiKey, baseUrl, hasKey: Boolean(apiKey), maskedKey: maskKey(apiKey) };
}

/** 写入 MiMo 配置（只更新这两个键，保留 .env 其它内容） */
export async function saveMimoConfig(baseDir, { apiKey, baseUrl } = {}) {
  const envFile = envPathFor(baseDir);
  let text = '';
  try {
    text = await fs.readFile(envFile, 'utf8');
  } catch {
    text = '';
  }

  const updates = {};
  if (typeof apiKey === 'string' && apiKey.trim()) updates.MIMO_API_KEY = apiKey.trim();
  if (typeof baseUrl === 'string') updates.MIMO_BASE_URL = baseUrl.trim();

  const next = updateEnvText(text, updates);
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  const tmp = `${envFile}.tmp`;
  await fs.writeFile(tmp, next, 'utf8');
  await fs.rename(tmp, envFile);

  if (updates.MIMO_API_KEY) process.env.MIMO_API_KEY = updates.MIMO_API_KEY;
  if (updates.MIMO_BASE_URL) process.env.MIMO_BASE_URL = updates.MIMO_BASE_URL;

  return readMimoConfig(baseDir);
}
