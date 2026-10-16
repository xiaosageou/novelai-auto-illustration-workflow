/**
 * prompt-reference-service.js
 * 所长真机提示词库轻量内存索引与检索服务 (In-Memory Hybrid Reference Prompt Indexer)
 *
 * 核心特性：
 * 1. 纯内存常驻单例，零外部依赖，毫秒级响应（< 0.05ms）
 * 2. 覆盖全量 1.7 万条真机数据（常规库 5,702 条 + R18 动作库 11,982 条）
 * 3. 三维精准打分：尺度与人数对齐 + 动作分类硬锚点 + 中英双向关键词/Danbooru Tag 倒排检索
 * 4. 自动过滤泛用画质冗余词与画师签名，仅提炼核心构图、镜头、站位与微观接触点
 * 5. 格式化为轻量 Few-Shot 模组，无缝注入 LLM 上下文
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 动作与场景意图多向别名表 (Taxonomy & Action Alias Map)
const TAXONOMY_ACTION_MAP = {
  // 核心体位与亲密交互
  '后入': ['后入', '背后', '背后位', 'doggystyle', 'from behind', 'behind'],
  '背后': ['后入', '背后', '背后位', 'doggystyle', 'from behind', 'behind'],
  '传教士': ['传教士', '正常位', 'missionary', 'on back', 'lying on back'],
  '种付': ['种付', '受孕', 'deep penetration', 'internal cumshot', 'mating press'],
  '骑乘': ['骑乘', '女上', 'cowgirl position', 'straddling', 'sitting on lap'],
  '反向骑乘': ['反向骑乘', '背向骑乘', 'reverse cowgirl', 'reverse straddling'],
  '对坐': ['对坐', '面对面', 'facing each other', 'sitting sex'],
  '站立': ['站立', '站姿', 'standing', 'standing sex'],
  '侧卧': ['侧卧', '侧面', 'spooning', 'side lying', 'side-lying'],
  '火车便当': ['火车便当', '抱起', 'lifted', 'carrying', 'standing suspension'],
  '折叠': ['倒栽折叠', '折叠位', 'jackknife', 'legs folded', 'legs up'],
  '口交': ['口交', '吹箫', '侍奉', 'fellatio', 'blowjob', 'deepthroat'],
  '手交': ['手交', '套弄', 'handjob', 'stroking penis'],
  '乳交': ['乳交', '夹弄', 'paizuri', 'titjob', 'breast smother'],
  '足交': ['足交', '踩弄', 'footjob', 'feet'],
  '素股': ['素股', '股间', 'thigh sex', 'sumata', 'thighs'],
  '69': ['69', '69式', '互侍', 'sixty-nine', 'mutual oral'],
  '双女': ['双女', '双飞', '2girls', 'threesome', 'double blowjob'],
  '双男': ['双男', '夹攻', '1girl 2boys', 'sandwiched', 'gangbang'],
  '群芳': ['群芳', '后宫', 'harem', 'multiple girls', 'surrounded'],
  '群像': ['群像', '围攻', 'gangbang', 'multiple boys', 'surrounded'],

  // 基础情感与微观互动
  '接吻': ['接吻', '亲吻', '吻', 'kiss', 'french kiss', 'kissing'],
  '拥抱': ['拥抱', '抱住', '相拥', 'hug', 'embracing', 'holding'],
  '牵手': ['牵手', '执手', 'holding hands', 'interlocked fingers'],
  '抚摸': ['抚摸', '抚脸', '摸头', 'touching', 'hand on cheek', 'head pat'],
  '对视': ['对视', '相视', '凝视', 'eye contact', 'looking at each other'],
  '背靠背': ['背靠背', '背靠', 'back-to-back', 'back to back'],
  '并排': ['并排', '并肩', '同行', 'side by side', 'walking together'],
  '依偎': ['依偎', '靠在', 'snuggling', 'head on shoulder', 'leaning'],
  '流泪': ['流泪', '哭泣', '落泪', 'tears', 'crying', 'weeping'],
  '微笑': ['微笑', '轻笑', '笑颜', 'smile', 'smiling', 'gentle smile'],
  '脸红': ['脸红', '羞涩', '害羞', 'blush', 'flushed face', 'embarrassed'],

  // 动作与场景氛围
  '拔剑': ['拔剑', '持剑', '出鞘', 'sword', 'holding sword', 'drawing sword'],
  '战斗': ['战斗', '交战', '交锋', 'fighting', 'combat', 'battle', 'action'],
  '施法': ['施法', '法术', '魔法', 'magic', 'casting spell', 'magic circle'],
  '防御': ['防御', '格挡', '抵挡', 'shield', 'blocking', 'defending'],
  '对峙': ['对峙', '对决', '警惕', 'confrontation', 'standoff', 'facing'],
  '奔跑': ['奔跑', '逃跑', '追逐', 'running', 'chasing', 'fleeing'],
  '跳跃': ['跳跃', '腾空', '跃起', 'jumping', 'midair', 'leaping'],
  '跪地': ['跪地', '下跪', '跪坐', 'kneeling', 'on knees'],
  '躺平': ['躺着', '横卧', '仰面', 'lying', 'on back', 'on bed'],

  // 镜头与特定环境
  '特写': ['特写', '微距', 'close-up', 'close up', 'extreme close-up'],
  '视角': ['主视角', '第一人称', 'pov', 'point of view', 'viewer'],
  '俯视': ['俯视', '从上往下', 'from above', 'looking down', 'overhead'],
  '仰视': ['仰视', '从下往上', 'from below', 'looking up', 'low angle'],
  '教室': ['教室', '课堂', '学校', 'classroom', 'school', 'desk'],
  '卧室': ['卧室', '房间', '床上', 'bedroom', 'bed', 'pillow', 'sheets'],
  '夜景': ['夜晚', '夜空', '月下', 'night', 'moon', 'starry sky', 'moonlight'],
  '雨中': ['下雨', '雨中', '雨滴', 'rain', 'raining', 'wet']
};

const STOP_WORDS = new Set([
  '一个', '正在', '少女', '少年', '男子', '女子', '女人', '男人', '两人', '我们', '他们',
  '自己', '看着', '面前', '身上', '开始', '随后', '这时', '之中', '这里', '那里', '什么',
  '出来', '进去', '过去', '过来', '起来', '下去', '有些', '一点', '而且', '并且'
]);

/**
 * 过滤画质冗余修饰词、画师签名与无意义格式词，提炼精粹构图与姿态
 */
export function cleanReferenceTags(rawTags) {
  if (!rawTags || typeof rawTags !== 'string') return '';
  const tokens = rawTags.split(/[,;\n]+/).map(t => t.trim()).filter(Boolean);
  
  // 冗余通用质量词、时间戳与负面标记
  const genericQualityRegex = /^(masterpiece|best quality|high detail|very aesthetic|best illustration|ultra high resolution|digital illustration|Variety\+|medium complexity|censored|uncensored|year 202[0-9]|simple illustration|flat color|-?[0-9.]+::.*::)$/i;
  // 画师词缀
  const isArtistRegex = /^([0-9.]+::)?artist:[^:]*(::)?$/i;

  const filtered = tokens.filter(t => !genericQualityRegex.test(t) && !isArtistRegex.test(t));
  return filtered.join(', ');
}

class PromptReferenceService {
  constructor() {
    this.r18Entries = [];
    this.regularEntries = [];
    this.r18TermIndex = new Map();
    this.regularTermIndex = new Map();
    this.isInitialized = false;
    this.isLoading = false;
  }

  /**
   * 初始化服务，加载 JSON 并构建倒排索引
   */
  async initialize() {
    if (this.isInitialized || this.isLoading) return;
    this.isLoading = true;

    try {
      const docsDir = path.resolve(__dirname, '../../docs');
      const r18Path = path.join(docsDir, 'suozhang_r18_full.json');
      const regPath = path.join(docsDir, 'suozhang-regular.json');

      if (fs.existsSync(r18Path)) {
        const raw = fs.readFileSync(r18Path, 'utf8');
        const parsed = JSON.parse(raw);
        this.r18Entries = this._normalizeEntries(parsed.entries || parsed);
        this.r18TermIndex = this._buildTermIndex(this.r18Entries);
      }

      if (fs.existsSync(regPath)) {
        const raw = fs.readFileSync(regPath, 'utf8');
        const parsed = JSON.parse(raw);
        this.regularEntries = this._normalizeEntries(parsed.entries || parsed);
        this.regularTermIndex = this._buildTermIndex(this.regularEntries);
      }

      this.isInitialized = true;
    } catch (err) {
      console.warn('[PromptReferenceService] 初始化提示词库索引警告:', err.message);
    } finally {
      this.isLoading = false;
    }
  }

  _normalizeEntries(rawList) {
    if (!Array.isArray(rawList)) return [];
    return rawList.map((item, idx) => {
      const title = String(item.title || '').trim();
      const pathArr = Array.isArray(item.path) ? item.path : [];
      const pathStr = pathArr.join(' > ');
      const rawTags = String(item.tags || '');
      const cleanTags = cleanReferenceTags(rawTags);

      // 推断角色数量特征
      const lowerTags = rawTags.toLowerCase();
      let inferredCharCount = 0;
      if (lowerTags.includes('1girl, 1boy') || lowerTags.includes('1boy, 1girl') || lowerTags.includes('1girl,1boy') || lowerTags.includes('2girls') || lowerTags.includes('2boys') || lowerTags.includes('hetero')) {
        inferredCharCount = 2;
      } else if (lowerTags.includes('group') || lowerTags.includes('3girls') || lowerTags.includes('3boys') || lowerTags.includes('harem') || lowerTags.includes('gangbang') || lowerTags.includes('multiple girls') || lowerTags.includes('multiple boys')) {
        inferredCharCount = 3;
      } else if (lowerTags.includes('solo') || lowerTags.includes('1girl') || lowerTags.includes('1boy')) {
        inferredCharCount = 1;
      }

      // 是否带有 4.5/最新版加成
      const is45 = /4\.5/i.test(title) || /4\.5/i.test(pathStr) || /year 202[56]/i.test(rawTags);

      return {
        id: item.id || `entry_${idx}`,
        title,
        path: pathArr,
        pathStr,
        rawTags,
        cleanTags,
        inferredCharCount,
        is45
      };
    });
  }

  _buildTermIndex(entries) {
    const index = new Map();
    const addTerm = (term, entryIdx) => {
      if (!term) return;
      const t = term.trim().toLowerCase();
      if (t.length < 2) return;
      let set = index.get(t);
      if (!set) {
        set = new Set();
        index.set(t, set);
      }
      set.add(entryIdx);
    };

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      // 索引标题
      if (e.title) {
        const titleClean = e.title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
        const words = titleClean.split(/\s+/).filter(Boolean);
        for (const w of words) {
          addTerm(w, i);
        }
        // 中文 2~3 字切片
        for (let len = 2; len <= 3; len++) {
          for (let j = 0; j <= e.title.length - len; j++) {
            addTerm(e.title.substr(j, len), i);
          }
        }
      }

      // 索引分类路径
      for (const p of e.path) {
        addTerm(p, i);
        for (let len = 2; len <= 3; len++) {
          for (let j = 0; j <= p.length - len; j++) {
            addTerm(p.substr(j, len), i);
          }
        }
      }

      // 索引 Danbooru 关键标签（去除格式符号后）
      const tagList = e.cleanTags.split(/[,;]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
      for (const t of tagList) {
        const rawTag = t.replace(/[{}[\]()]/g, '').trim();
        if (rawTag) addTerm(rawTag, i);
      }
    }

    return index;
  }

  /**
   * 根据场景卡片查找最贴合的真机参考 Prompt
   * @param {Object|string} sceneCard - 场景信息对象或描述字符串
   * @param {Object} options - 检索参数
   * @param {number} [options.limit=2] - 返回条数
   * @param {boolean} [options.isNsfw] - 是否限制在 NSFW 库
   * @param {number} [options.characterCount] - 场景角色数
   * @returns {Array<{ id: string, title: string, category: string, tags: string, score: number, matchReason: string }>}
   */
  findReferences(sceneCard, options = {}) {
    if (!this.isInitialized) {
      // 启动同步快速初始化
      try {
        const docsDir = path.resolve(__dirname, '../../docs');
        const r18Path = path.join(docsDir, 'suozhang_r18_full.json');
        const regPath = path.join(docsDir, 'suozhang-regular.json');
        if (fs.existsSync(r18Path)) {
          const parsed = JSON.parse(fs.readFileSync(r18Path, 'utf8'));
          this.r18Entries = this._normalizeEntries(parsed.entries || parsed);
          this.r18TermIndex = this._buildTermIndex(this.r18Entries);
        }
        if (fs.existsSync(regPath)) {
          const parsed = JSON.parse(fs.readFileSync(regPath, 'utf8'));
          this.regularEntries = this._normalizeEntries(parsed.entries || parsed);
          this.regularTermIndex = this._buildTermIndex(this.regularEntries);
        }
        this.isInitialized = true;
      } catch (err) {
        console.warn('[PromptReferenceService] 同步加载提示词库警告:', err.message);
        return [];
      }
    }

    const limit = Math.max(1, Math.min(options.limit || 2, 5));
    
    // 解析场景属性
    let visualDesc = '';
    let coreAction = '';
    let sexPosition = '';
    let nsfwRating = 'sfw';
    let charCount = 0;

    if (typeof sceneCard === 'string') {
      visualDesc = sceneCard;
    } else if (sceneCard && typeof sceneCard === 'object') {
      visualDesc = sceneCard.visual_description || sceneCard.visualDescription || sceneCard.description || '';
      coreAction = sceneCard.core_action || sceneCard.coreAction || '';
      sexPosition = sceneCard.sex_position || sceneCard.sexPosition || '';
      nsfwRating = sceneCard.nsfw_rating || sceneCard.nsfwRating || 'sfw';
      if (Array.isArray(sceneCard.characters)) {
        charCount = sceneCard.characters.length;
      }
    }

    if (options.characterCount) charCount = options.characterCount;
    const isNsfw = typeof options.isNsfw === 'boolean'
      ? options.isNsfw
      : (nsfwRating !== 'sfw' || Boolean(sexPosition));

    const dataset = isNsfw ? this.r18Entries : this.regularEntries;
    const termIndex = isNsfw ? this.r18TermIndex : this.regularTermIndex;

    if (!dataset || dataset.length === 0) return [];

    // 收集查询关键词
    const fullText = `${visualDesc} ${coreAction} ${sexPosition}`.toLowerCase();
    const queryTerms = new Set();
    const aliasExpandedTerms = new Set();

    // 1. 从别名表中命中意图扩展词
    for (const [key, aliases] of Object.entries(TAXONOMY_ACTION_MAP)) {
      if (fullText.includes(key.toLowerCase())) {
        aliases.forEach(a => {
          queryTerms.add(a.toLowerCase());
          aliasExpandedTerms.add(a.toLowerCase());
        });
      }
    }

    // 2. 如果有明确体位，加入极高权重项
    if (sexPosition) {
      queryTerms.add(sexPosition.toLowerCase());
      for (const [key, aliases] of Object.entries(TAXONOMY_ACTION_MAP)) {
        if (sexPosition.includes(key)) {
          aliases.forEach(a => queryTerms.add(a.toLowerCase()));
        }
      }
    }

    // 3. 切分动作与场景分词
    if (coreAction) {
      queryTerms.add(coreAction.toLowerCase());
    }

    // 4. 提取中文 2~3 字切片（过滤停用词与超高频泛词，保障毫秒级性能）
    for (let len = 2; len <= 3; len++) {
      for (let j = 0; j <= visualDesc.length - len; j++) {
        const slice = visualDesc.substr(j, len).trim().toLowerCase();
        if (slice && !STOP_WORDS.has(slice) && termIndex.has(slice)) {
          const matchCount = termIndex.get(slice)?.size || 0;
          if (matchCount > 0 && matchCount < 1000) {
            queryTerms.add(slice);
          }
        }
      }
    }

    // 收集候选条目
    const candidateScores = new Map();
    const matchReasons = new Map();

    for (const term of queryTerms) {
      const matchedIndices = termIndex.get(term);
      if (!matchedIndices) continue;

      const isHighPriority = aliasExpandedTerms.has(term) || (sexPosition && term.includes(sexPosition));
      const termWeight = isHighPriority ? 25 : 8;

      for (const idx of matchedIndices) {
        candidateScores.set(idx, (candidateScores.get(idx) || 0) + termWeight);
        if (!matchReasons.has(idx)) {
          matchReasons.set(idx, term);
        }
      }
    }

    // 如果倒排未命中任何词，返回空
    if (candidateScores.size === 0) {
      return [];
    }

    // 对候选集进行综合精细化重排
    const scoredList = [];
    for (const [idx, baseScore] of candidateScores.entries()) {
      const item = dataset[idx];
      let score = baseScore;

      // 人数匹配加减分
      if (charCount > 0 && item.inferredCharCount > 0) {
        if (charCount === item.inferredCharCount) {
          score += 20; // 人数严格对齐
        } else if (Math.abs(charCount - item.inferredCharCount) >= 2) {
          score -= 30; // 人数差异过大惩罚（如单人场景绝不推多人，反之亦然）
        }
      }

      // 4.5/最新版本质量加成
      if (item.is45) {
        score += 10;
      }

      // 标签长度适中度（过短信息不足，过长浪费 token）
      const tagLen = item.cleanTags.length;
      if (tagLen >= 40 && tagLen <= 400) {
        score += 5;
      }

      scoredList.push({
        id: item.id,
        title: item.title,
        category: item.pathStr,
        tags: item.cleanTags,
        score,
        matchReason: `命中分类或动作词[${matchReasons.get(idx) || '意图对齐'}]`
      });
    }

    scoredList.sort((a, b) => b.score - a.score);
    return scoredList.slice(0, limit);
  }

  /**
   * 将检索出的参考条目格式化为 LLM Prompt 注入文本
   * @param {Array} references - findReferences 返回的条目数组
   * @returns {string} 格式化后的提示词区块
   */
  formatReferencesForLlm(references) {
    if (!Array.isArray(references) || references.length === 0) return '';

    const lines = [
      '【本地精选真机参考范例（Few-Shot 构图与标签参考）】',
      '以下为所长提示词库中通过 NAI 实机验证的高质量提示词，请重点参考其镜头视角、空间站位、骨骼动作与微观接触细节（请勿直接照抄非本场景的角色外观）：'
    ];

    references.forEach((ref, idx) => {
      const categoryLabel = ref.category ? `[${ref.category}] ` : '';
      const titleLabel = ref.title ? `· ${ref.title}` : '';
      lines.push(`• 范例 ${idx + 1} (${categoryLabel}${titleLabel}):`);
      lines.push(`  ${ref.tags}`);
    });

    return lines.join('\n');
  }
}

// 单例导出
export const promptReferenceService = new PromptReferenceService();
export default promptReferenceService;
