import fs from 'fs/promises';
import path from 'path';

function resolveBundlePath(bundlePath, baseDir = process.cwd()) {
  const cleanPath = String(bundlePath || '').trim();
  if (!cleanPath) {
    throw new Error('Vibe bundle 路径不能为空');
  }
  return path.isAbsolute(cleanPath) ? cleanPath : path.join(baseDir, cleanPath);
}

function getPreferredEncodingKeys(model = '') {
  const lower = String(model || '').toLowerCase();
  if (lower.includes('4-5') || lower.includes('4.5')) {
    return ['v4-5full', 'v4-5curated', 'v4-5', 'v4.5full', 'v4.5'];
  }
  if (lower.includes('4')) {
    return ['v4', 'v4full', 'v4curated'];
  }
  return [];
}

function flattenEncodingVariants(encodingsForModel) {
  if (!encodingsForModel || typeof encodingsForModel !== 'object') return [];

  // NovelAI bundle commonly stores variants like: encodings[modelKey].unknown.encoding
  if (typeof encodingsForModel.encoding === 'string') {
    return [encodingsForModel];
  }

  return Object.values(encodingsForModel).filter(item => item && typeof item === 'object');
}

function pickEncoding(vibe, model) {
  const encodings = vibe?.encodings;
  if (!encodings || typeof encodings !== 'object') return null;

  const preferredKeys = getPreferredEncodingKeys(model);
  const allKeys = Object.keys(encodings);
  const orderedKeys = [
    ...preferredKeys.filter(key => Object.prototype.hasOwnProperty.call(encodings, key)),
    ...allKeys.filter(key => !preferredKeys.includes(key))
  ];

  for (const key of orderedKeys) {
    const variants = flattenEncodingVariants(encodings[key]);
    for (const variant of variants) {
      if (typeof variant.encoding === 'string' && variant.encoding.trim()) {
        return {
          encoding: variant.encoding.trim(),
          informationExtracted: Number(variant.params?.information_extracted),
          modelKey: key
        };
      }
    }
  }

  return null;
}

export async function loadVibeBundleForModel(bundlePath, model, baseDir = process.cwd()) {
  const fullPath = resolveBundlePath(bundlePath, baseDir);
  const raw = await fs.readFile(fullPath, 'utf-8');
  const bundle = JSON.parse(raw);

  const vibes = Array.isArray(bundle.vibes) ? bundle.vibes : [bundle];
  const encodings = [];
  const informationExtracted = [];
  const names = [];
  const modelKeys = [];

  for (const vibe of vibes) {
    if (!vibe || typeof vibe !== 'object') continue;
    const picked = pickEncoding(vibe, model);
    if (!picked) continue;

    encodings.push(picked.encoding);
    informationExtracted.push(Number.isFinite(picked.informationExtracted) ? picked.informationExtracted : null);
    names.push(vibe.name || vibe.id || `vibe-${encodings.length}`);
    modelKeys.push(picked.modelKey);
  }

  if (encodings.length === 0) {
    throw new Error(`未能从 Vibe bundle 中找到可用于模型 ${model || '(unknown)'} 的 encoding`);
  }

  return {
    path: fullPath,
    encodings,
    informationExtracted,
    names,
    modelKeys
  };
}
