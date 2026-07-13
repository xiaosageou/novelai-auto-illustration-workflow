import { promises as fs } from 'fs';
import path from 'path';
import { removeNonEnglishPromptTokens } from './prompt-cleaner.js';

const DNA_FEATURE_KEYS = [
  "外貌标签",
  "身材标签",
  "胸部标签",
  "发型标签",
  "发色标签",
  "眼睛标签",
  "肤色标签",
  "年龄感标签",
  "服装基底标签",
  "特殊特征标签"
];

function uniqueClean(values = []) {
  const list = Array.isArray(values) ? values : String(values || '').split(/[,，、\s]+/);
  return [...new Set(list.map(item => String(item || '').trim()).filter(Boolean))];
}

function mergeFeatureTags(previous = {}, incoming = {}) {
  const merged = {};
  for (const key of DNA_FEATURE_KEYS) {
    merged[key] = uniqueClean([
      ...(Array.isArray(previous?.[key]) ? previous[key] : []),
      ...(Array.isArray(incoming?.[key]) ? incoming[key] : [])
    ]);
  }
  return merged;
}

function mergeTagString(previous = "", incoming = "") {
  return uniqueClean([
    ...String(previous || '').split(/[,，]/),
    ...String(incoming || '').split(/[,，]/)
  ]).join(", ");
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * 原子化安全地将数据写入 JSON 文件
 * 步骤：先写入随机命名的临时文件，然后再重命名替换目标文件，防止写入中途断电导致文件损坏。
 */
export async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`);
  const jsonString = JSON.stringify(data, null, 4);
  
  try {
    // 确保父目录存在
    await fs.mkdir(dir, { recursive: true });

    // 写入临时文件
    await fs.writeFile(tempPath, jsonString, 'utf-8');

    // 原子性重命名替换目标文件
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Docker 单文件 bind mount 场景下，临时文件通常写在容器层，
    // rename 覆盖挂载目标时会因为跨设备或 mount point 替换失败。
    if (['EXDEV', 'EBUSY', 'EPERM'].includes(error?.code)) {
      try {
        await fs.writeFile(filePath, jsonString, 'utf-8');
        try {
          await fs.unlink(tempPath);
        } catch {}
        return;
      } catch (writeError) {
        try {
          await fs.unlink(tempPath);
        } catch {}
        throw writeError;
      }
    }

    // 发生异常时清理可能残留的临时文件
    try {
      await fs.unlink(tempPath);
    } catch {}
    throw error;
  }
}

/**
 * 读取 JSON 文件，如果文件不存在则返回默认值
 */
export async function readJson(filePath, defaultValue = {}) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return defaultValue;
    }
    throw error;
  }
}

/**
 * 项目进度管理封装 (pipeline_progress.json)
 */
export class ProjectProgress {
  constructor(projectDir) {
    this.progressFile = path.join(projectDir, 'pipeline_progress.json');
    this.data = null;
  }

  normalizeKey(key) {
    return key.replace(/[\s_]+/g, '').toLowerCase();
  }

  getEffectiveChapKey(volume, chapter) {
    const standardKey = `${volume}_${chapter}`.replace(/\s+/g, '_');
    const standardNorm = this.normalizeKey(standardKey);
    const completed = this.getCompletedChapters();
    for (const existingKey of Object.keys(completed)) {
      if (this.normalizeKey(existingKey) === standardNorm) {
        return existingKey;
      }
    }
    return standardKey;
  }

  getEffectiveChapKeyByRaw(rawKey) {
    const rawNorm = this.normalizeKey(rawKey);
    const completed = this.getCompletedChapters();
    for (const existingKey of Object.keys(completed)) {
      if (this.normalizeKey(existingKey) === rawNorm) {
        return existingKey;
      }
    }
    return rawKey;
  }

  async load() {
    this.data = await readJson(this.progressFile, {
      completed_chapters: {},
      global_characters: {},
      character_dna_versions: {},
      character_dna_slices: {},
      pipeline_pause: null
    });
    // 初始化默认字段，防止字段不存在
    if (!this.data.completed_chapters) this.data.completed_chapters = {};
    if (!this.data.global_characters) this.data.global_characters = {};
    if (!this.data.character_dna_versions) this.data.character_dna_versions = {};
    if (!this.data.character_dna_slices) this.data.character_dna_slices = {};

    let promptsMigrated = false;
    for (const chapter of Object.values(this.data.completed_chapters)) {
      if (!Array.isArray(chapter?.scenes)) continue;
      for (const scene of chapter.scenes) {
        for (const field of ['final_prompt', 'base_prompt', 'final_negative']) {
          if (!scene?.[field]) continue;
          const cleaned = removeNonEnglishPromptTokens(scene[field]);
          if (cleaned !== scene[field]) {
            scene[field] = cleaned;
            promptsMigrated = true;
          }
        }
        if (Array.isArray(scene?.character_prompts)) {
          const cleanedPrompts = scene.character_prompts
            .map(removeNonEnglishPromptTokens)
            .filter(Boolean);
          if (JSON.stringify(cleanedPrompts) !== JSON.stringify(scene.character_prompts)) {
            scene.character_prompts = cleanedPrompts;
            promptsMigrated = true;
          }
        }
      }
    }
    if (promptsMigrated) {
      await writeJsonAtomic(this.progressFile, this.data);
    }
    return this.data;
  }

  async save() {
    if (!this.data) return;
    await writeJsonAtomic(this.progressFile, this.data);
  }

  getCompletedChapters() {
    return this.data?.completed_chapters || {};
  }

  getGlobalCharacters() {
    return this.data?.global_characters || {};
  }

  getCharacterDnaVersions() {
    return this.data?.character_dna_versions || {};
  }

  findCharacterName(name = '') {
    const target = String(name || '').split('(')[0].trim().toLowerCase();
    if (!target) return '';
    return Object.entries(this.getGlobalCharacters()).find(([characterName, character]) => {
      const candidates = [characterName, ...(Array.isArray(character?.aliases) ? character.aliases : [])]
        .map(value => String(value || '').split('(')[0].trim().toLowerCase());
      return candidates.includes(target);
    })?.[0] || '';
  }

  getCharacterDNAForChapter(name = '', chapterIndex = 0) {
    const characterName = this.findCharacterName(name);
    if (!characterName) return null;
    const character = this.getGlobalCharacters()[characterName] || {};
    const versions = Array.isArray(this.getCharacterDnaVersions()[characterName])
      ? this.getCharacterDnaVersions()[characterName]
      : [];
    const index = Number.isInteger(Number(chapterIndex)) ? Number(chapterIndex) : 0;
    const active = versions
      .filter(version => Number(version?.startChapterIndex) <= index
        && (version?.endChapterIndex == null || Number(version.endChapterIndex) >= index))
      .sort((a, b) => Number(b.startChapterIndex) - Number(a.startChapterIndex))[0];
    return active ? { ...character, ...active, name: characterName } : { ...character, name: characterName };
  }

  upsertCharacterDnaVersion(name, version = {}) {
    if (!this.data) return null;
    const characterName = this.findCharacterName(name) || String(name || '').trim();
    if (!characterName || !this.data.global_characters?.[characterName]) return null;
    const startChapterIndex = Number(version.startChapterIndex);
    if (!Number.isInteger(startChapterIndex) || startChapterIndex < 0) return null;
    const versions = Array.isArray(this.data.character_dna_versions[characterName])
      ? this.data.character_dna_versions[characterName]
      : [];
    const next = {
      id: String(version.id || `chapter_${startChapterIndex + 1}`).trim(),
      startChapterIndex,
      tags: uniqueClean(String(version.tags || '').split(/[,，]/)).join(', '),
      features: mergeFeatureTags(Object.fromEntries(DNA_FEATURE_KEYS.map(key => [key, []])), version.features || {}),
      evidence: Array.isArray(version.evidence) ? version.evidence.slice(0, 20) : [],
      confidence: normalizeConfidence(version.confidence),
      supersededNegative: uniqueClean(String(version.supersededNegative || '').split(/[,，]/)).join(', '),
      sourceSliceKey: String(version.sourceSliceKey || '').trim(),
      sourceChapters: uniqueClean(version.sourceChapters || []),
      updatedAt: Date.now()
    };
    const existingIndex = versions.findIndex(item => item.id === next.id || Number(item.startChapterIndex) === startChapterIndex);
    if (existingIndex >= 0) versions.splice(existingIndex, 1, { ...versions[existingIndex], ...next });
    else versions.push(next);
    versions.sort((a, b) => Number(a.startChapterIndex) - Number(b.startChapterIndex));
    versions.forEach((item, index) => {
      item.endChapterIndex = index + 1 < versions.length ? Number(versions[index + 1].startChapterIndex) - 1 : null;
    });
    this.data.character_dna_versions[characterName] = versions;
    return versions.find(item => item.id === next.id);
  }

  deleteCharacterDnaVersion(name, versionId) {
    const characterName = this.findCharacterName(name);
    const versions = this.getCharacterDnaVersions()[characterName];
    if (!characterName || !Array.isArray(versions) || versions.length <= 1) return false;
    const index = versions.findIndex(item => item.id === versionId);
    if (index < 0) return false;
    versions.splice(index, 1);
    versions.forEach((item, position) => {
      item.endChapterIndex = position + 1 < versions.length ? Number(versions[position + 1].startChapterIndex) - 1 : null;
    });
    return true;
  }

  getCharacterDnaSlices() {
    return this.data?.character_dna_slices || {};
  }

  isCharacterDnaSliceCompleted(sliceKey) {
    return this.getCharacterDnaSlices()?.[sliceKey]?.status === 'completed';
  }

  setCharacterDnaSliceStatus(sliceKey, data = {}) {
    if (!this.data) return;
    this.data.character_dna_slices[sliceKey] = {
      ...(this.data.character_dna_slices[sliceKey] || {}),
      ...data,
      updatedAt: Date.now()
    };
  }

  setPipelinePause(pauseInfo = null) {
    if (!this.data) return;
    this.data.pipeline_pause = pauseInfo ? { ...pauseInfo, updatedAt: Date.now() } : null;
  }

  setChapterStatus(chapKey, status, scenes = []) {
    if (!this.data) return;
    const previous = this.data.completed_chapters[chapKey] || {};
    this.data.completed_chapters[chapKey] = {
      status,
      scenes,
      scene_extraction_failures: Array.isArray(previous.scene_extraction_failures)
        ? previous.scene_extraction_failures
        : [],
      updatedAt: Date.now()
    };
  }

  setChapterSceneExtractionFailures(chapKey, failures = []) {
    if (!this.data) return;
    const previous = this.data.completed_chapters[chapKey] || {};
    this.data.completed_chapters[chapKey] = {
      ...previous,
      scene_extraction_failures: Array.isArray(failures) ? failures : [],
      updatedAt: Date.now()
    };
  }

  setChapterFailed(chapKey, error, scenes = null) {
    if (!this.data) return;
    const previous = this.data.completed_chapters[chapKey] || {};
    this.data.completed_chapters[chapKey] = {
      status: 'failed',
      error: String(error),
      scenes: Array.isArray(scenes) ? scenes : (Array.isArray(previous.scenes) ? previous.scenes : []),
      scene_extraction_failures: Array.isArray(previous.scene_extraction_failures)
        ? previous.scene_extraction_failures
        : [],
      updatedAt: Date.now()
    };
  }

  updateCharacterDNA(name, {
    tags = "",
    features = null,
    aliases = [],
    gender = "",
    role_type = "",
    evidence = [],
    confidence = 0,
    source_chapters = [],
    source_text_summary = "",
    height_class = "",
    body_proportion = ""
  } = {}) {
    if (!this.data) return;
    
    // 如果没有特征，初始化默认结构
    const defaultFeatures = Object.fromEntries(DNA_FEATURE_KEYS.map(key => [key, []]));

    if (!this.data.global_characters[name]) {
      this.data.global_characters[name] = {
        tags: mergeTagString("", tags),
        features: mergeFeatureTags(defaultFeatures, features || {}),
        aliases: uniqueClean(aliases),
        gender: String(gender || '').trim(),
        role_type: String(role_type || '').trim(),
        evidence: Array.isArray(evidence) ? evidence.slice(0, 20) : [],
        confidence: normalizeConfidence(confidence),
        height_class: String(height_class || '').trim(),
        body_proportion: String(body_proportion || '').trim(),
        source_chapters: uniqueClean(source_chapters),
        source_text_summary: String(source_text_summary || '').trim(),
        base64_img: "", // 保留字段以兼容
        use_vibe: false // 保留字段以兼容
      };
    } else {
      const char = this.data.global_characters[name];
      char.tags = mergeTagString(char.tags || "", tags);
      char.features = mergeFeatureTags({ ...defaultFeatures, ...(char.features || {}) }, features || {});
      char.aliases = uniqueClean([...(char.aliases || []), ...uniqueClean(aliases)]);
      char.gender = char.gender || String(gender || '').trim();
      char.role_type = char.role_type || String(role_type || '').trim();
      char.evidence = [
        ...(Array.isArray(char.evidence) ? char.evidence : []),
        ...(Array.isArray(evidence) ? evidence : [])
      ].slice(-30);
      char.confidence = Math.max(normalizeConfidence(char.confidence), normalizeConfidence(confidence));
      char.height_class = char.height_class || String(height_class || '').trim();
      char.body_proportion = char.body_proportion || String(body_proportion || '').trim();
      char.source_chapters = uniqueClean([...(char.source_chapters || []), ...uniqueClean(source_chapters)]);
      if (source_text_summary) {
        char.source_text_summary = uniqueClean([char.source_text_summary, source_text_summary]).join(" / ");
      }
    }
  }

  setCharacterDNATags(name, tags = "") {
    if (!this.data || !name) return false;
    const char = this.data.global_characters?.[name];
    if (!char) return false;
    char.tags = uniqueClean(String(tags || '').split(/[,，]/)).join(", ");
    return true;
  }

  setCharacterDNAFeatures(name, features = {}) {
    if (!this.data || !name) return false;
    const char = this.data.global_characters?.[name];
    if (!char) return false;
    const defaultFeatures = Object.fromEntries(DNA_FEATURE_KEYS.map(key => [key, []]));
    const mergedFeatures = mergeFeatureTags(defaultFeatures, features || {});
    char.features = mergedFeatures;
    char.tags = uniqueClean(
      DNA_FEATURE_KEYS.flatMap(key => Array.isArray(mergedFeatures[key]) ? mergedFeatures[key] : [])
    ).join(", ");
    return true;
  }
}
