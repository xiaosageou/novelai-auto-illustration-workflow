/**
 * 有声书文本层：章节正文清洗、TTS 友好分块、时长与体积估算。
 *
 * 章节切分复用项目已有的 PipelineManager（book.txt → chapters），
 * 这里只处理「已经分好章的正文」如何安全地切成 TTS 请求块。
 */

export const DEFAULT_CHUNK_CHARS = 1600;
export const MAX_CHUNK_CHARS = 2400;
export const MIN_CHUNK_CHARS = 60;

/** 章节正文清洗：去 HTML 残留、装饰分隔线、压缩空行 */
export function cleanChapterText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/<[^>]{1,200}>/g, '')
    .replace(/^[ \t]*[=\-*~#_]{4,}[ \t]*$/gm, '')
    .replace(/^[ \t]*[─━═╌╍▬]{3,}[ \t]*$/gm, '')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 按段落 / 句末标点切块，单块不超过 chunkChars（MiMo 单请求建议 ≤2500 字） */
export function chunkText(text, chunkChars = DEFAULT_CHUNK_CHARS) {
  const limit = Math.max(MIN_CHUNK_CHARS, Math.min(Number(chunkChars) || DEFAULT_CHUNK_CHARS, MAX_CHUNK_CHARS));
  const src = cleanChapterText(text);
  if (!src) return [];

  const paragraphs = src.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const segments = [];

  for (const para of paragraphs) {
    const flat = para.split('\n').map((l) => l.trim()).filter(Boolean).join('');
    if (!flat) continue;
    if (flat.length <= limit) {
      segments.push(flat);
      continue;
    }
    for (const sent of splitSentences(flat)) {
      if (sent.length <= limit) {
        segments.push(sent);
      } else {
        for (let i = 0; i < sent.length; i += limit) segments.push(sent.slice(i, i + limit));
      }
    }
  }

  const chunks = [];
  let cur = '';
  for (const seg of segments) {
    if (cur && cur.length + seg.length > limit) {
      chunks.push(cur);
      cur = '';
    }
    cur += seg;
  }
  if (cur) chunks.push(cur);

  const merged = [];
  for (const c of chunks) {
    if (merged.length && c.length < MIN_CHUNK_CHARS) merged[merged.length - 1] += c;
    else merged.push(c);
  }
  return merged.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function splitSentences(text) {
  const parts = text.match(/[^。！？；：!?;:…]*[。！？；：!?;:…]+["”』」）)]?|[^。！？；：!?;:…]+$/g) || [text];
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** 粗略估算朗读时长（秒）：中文约 4.6 字/秒，英文按 2.6 词/秒 */
export function estimateDurationSec(text) {
  const src = String(text || '');
  const cjk = (src.match(/[\u4e00-\u9fff]/g) || []).length;
  const enWords = (src.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z']+/g) || []).length;
  const other = Math.max(0, src.length - cjk);
  return cjk / 4.6 + enWords / 2.6 + other / 12;
}

/** 指定码率下的体积（字节） */
export function estimateBytes(durationSec, bitrateKbps) {
  return Math.round((durationSec * Number(bitrateKbps || 48) * 1000) / 8);
}

/** 秒 → 1 小时 02 分 */
export function formatDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h} 小时 ${String(m).padStart(2, '0')} 分`
    : `${m} 分 ${String(ss).padStart(2, '0')} 秒`;
}

/** 字节 → 21.6 MB */
export function formatBytes(n) {
  const v0 = Number(n) || 0;
  if (!v0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = v0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
