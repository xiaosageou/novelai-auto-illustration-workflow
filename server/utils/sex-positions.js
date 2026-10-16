// ─────────────────────────────────────────────────────────────────────────────
// sex-positions.js
// 26 种标准性爱体位/亲密侍奉/多人群像定义、同义词检索与 NAI 4.5 标准参考提示词模组
// 涵盖 15 种经典插入体位 + 7 种亲密侍奉动作 + 4 种多人群像场景
// ─────────────────────────────────────────────────────────────────────────────

export const STANDARD_SEX_POSITIONS = [
  {
    id: 'missionary',
    name: '传教士位',
    canonical_en: 'missionary',
    aliases: [
      '传教士位', '传教士', '经典正身位', '正身位', '仰卧位', '仰卧正位', '正常位',
      'missionary', 'missionary position', 'on back'
    ],
    summary: '女方仰卧平躺，男方面对面伏于上方，经典面对面正向交合。',
    prompt: 'missionary, on back, lying, spread legs, boy on top, leg grab, sheet grab, arched back, head back, blush, open mouth, heavy breathing, trembling, sweat, steaming body, from side',
    prompt_nl: 'Classic missionary position with female lying on back with spread legs on the bed, male positioned on top between her legs, side view capturing arched back, heavy breathing, and flushed expressions.'
  },
  {
    id: 'mating_press',
    name: '种付位',
    canonical_en: 'mating press',
    aliases: [
      '种付位', '种付', '折叠位', '压迫位', '双腿朝天', '双腿架肩', '折叠压迫',
      'mating press', 'folded legs over head'
    ],
    summary: '女方双腿被大幅折叠至胸口/头部两侧上方，男方重力前倾深插，极度受力与压迫感。',
    prompt: 'mating press, folded, legs up, legs over head, spread legs, boy on top, holding another\'s ankles, ankle grab, arched back, wide-eyed, open mouth, heavy breathing, sweat, trembling, motion lines, from below',
    prompt_nl: 'Mating press position, female partner folded with legs pressed up over her head and ankles held firmly, male partner leaning down over her from above, deep penetration angle, wide-eyed panting expression.'
  },
  {
    id: 'doggystyle',
    name: '四足后入',
    canonical_en: 'doggystyle',
    aliases: [
      '四足后入', '经典后入位', '后入位', '后入', '四足跪趴', '狗趴', '趴跪后入', '从背后插入',
      'doggystyle', 'doggy style', 'all fours'
    ],
    summary: '女方四肢着地跪趴床面翘臀，男方在后方抓腰大力进入，可回头看镜头。',
    prompt: 'doggystyle, all fours, on hands and knees, ass up, arched back, faceless male, grabbing hips, waist grab, from behind, head down, looking back, parted lips, heavy breathing, sweat, steaming body, motion blur, motion lines',
    prompt_nl: 'Classic doggystyle on hands and knees, female partner arched back with hips raised, male partner gripping her waist firmly from behind, female looking back over shoulder with parted lips and heavy breathing.'
  },
  {
    id: 'prone_bone',
    name: '俯卧后入',
    canonical_en: 'prone bone',
    aliases: [
      '俯卧后入', '俯卧后入位', '俯卧位', '趴着后入', '趴在床上后入', '趴在床上', '贴床后入', '压背俯卧', '俯卧下压',
      'prone bone', 'lying on stomach'
    ],
    summary: '女方整个身躯平趴在床上（常抓枕头/陷进床褥），男方紧贴背部从后方覆盖插入。',
    prompt: 'prone bone, lying on stomach, on stomach, flat on bed, boy on top, lying on person, from behind, face planted in pillow, pillow grab, arched back, blush, heavy breathing, trembling, sweat, steaming body, motion lines',
    prompt_nl: 'Prone bone position with female partner lying flat on her stomach clutching the pillow, male partner pressing down flush against her back from behind, side angle capturing intimate full-body contact and trembling flushed face.'
  },
  {
    id: 'cowgirl',
    name: '正向骑乘',
    canonical_en: 'cowgirl position',
    aliases: [
      '正向骑乘', '骑乘位', '女上位', '跨坐骑乘', '女上男下', '正向跨坐',
      'cowgirl position', 'cowgirl', 'straddling'
    ],
    summary: '女方居上位面朝男方跨坐起伏，双手常撑在男方胸膛，主导摇曳律动。',
    prompt: 'cowgirl position, girl on top, straddling, sitting on person, bouncing, bouncing breasts, motion lines, hands on male chest, leaning forward, looking down, panting, arched back, sweat, steaming body, cowboy shot',
    prompt_nl: 'Cowgirl position with female partner straddling on top of the reclining male, leaning slightly forward with hands resting on his chest, cowboy shot framing bouncing movement, arched back, and downward gaze.'
  },
  {
    id: 'reverse_cowgirl',
    name: '反向骑乘',
    canonical_en: 'reverse cowgirl',
    aliases: [
      '反向骑乘', '反向反骑乘位', '背向骑乘', '反骑乘', '背对骑乘',
      'reverse cowgirl position', 'reverse cowgirl'
    ],
    summary: '女方背对男方面部跨坐，镜头聚焦背部优美曲线、腰窝与臀部，常伴有扭头回望。',
    prompt: 'reverse cowgirl position, girl on top, back view, from behind, straddling, sitting on person, ass focus, arched back, turning head, looking back over shoulder, blush, heavy breathing, sweat, motion lines',
    prompt_nl: 'Reverse cowgirl position facing away from the male partner, girl on top with visible back curves and hips, turning head to glance back over her shoulder with flushed cheeks and heavy breathing.'
  },
  {
    id: 'lap_sitting',
    name: '面对面对坐',
    canonical_en: 'sitting on lap',
    aliases: [
      '面对面对坐', '面对面怀抱坐位', '树袋熊坐位', '怀抱对坐', '对坐', '莲花坐位', '怀抱坐位',
      'sitting on lap', 'lotus position', 'lap sitting'
    ],
    summary: '男方坐姿，女方跨坐男方大腿上面对面相拥，双腿盘腰双臂环颈，极度温存深情。',
    prompt: 'sitting on lap, sitting on person, face-to-face, straddling, legs around waist, arms around neck, embrace, hugging, forehead to forehead, close-up, eye level, blush, open mouth, heavy breathing, trembling, sweat',
    prompt_nl: 'Intimate face-to-face lap sitting position, female straddling the seated male with legs wrapped around his waist and arms embracing his neck, eye-level close-up capturing foreheads touching, trembling lips, and shared warmth.'
  },
  {
    id: 'reverse_lap',
    name: '背向坐身',
    canonical_en: 'reverse lap',
    aliases: [
      '背向坐身', '背向坐身位', '背向坐位', '椅子后入坐位', '书桌坐位', '办公椅坐位', '背向跨坐',
      'reverse lap', 'sitting on lap from behind'
    ],
    summary: '女方背对男方坐在其腿上/椅子上，男方从后方搂腰控制抽送，常伴随头部后仰。',
    prompt: 'sitting on lap, sitting on person, sex from behind, back to male, sitting on chair, waist grab, under desk, legs dangling, head back, heavy breathing, sweat drops',
    prompt_nl: 'Reverse lap seated sex position on a chair or desk, female seated on male lap with back facing him, male hands firmly holding her hips from behind while her head tilts back with breathless pleasure.'
  },
  {
    id: 'standing_doggystyle',
    name: '站立后入',
    canonical_en: 'standing doggystyle',
    aliases: [
      '站立后入', '站立后入位', '按在墙上后入', '倚墙站立后入', '靠墙后入', '扶墙后入',
      'standing doggystyle', 'standing sex from behind'
    ],
    summary: '双人站立，女方手扶墙面/桌沿弯腰拱起后背，男方立于身后抓跨挺入。',
    prompt: 'standing, standing sex, sex from behind, bent over, against wall, hands against wall, arched back, faceless male, grabbing hips, full body, wide shot, motion lines',
    prompt_nl: 'Standing sex from behind against a wall, female bent forward with hands braced against the wall surface, male standing behind grabbing her waist, dynamic full body framing.'
  },
  {
    id: 'one_leg_lift',
    name: '单腿站立',
    canonical_en: 'one-leg lift',
    aliases: [
      '单腿站立', '单腿架起站立位', '单腿架起', '提腿站立', '站立提腿', '扶墙提腿',
      'one-leg lift', 'standing leg lift'
    ],
    summary: '男方站立将女方单侧玉腿高高架起或扛在腰间/肩头，极强不对称张力。',
    prompt: 'standing, standing sex, one leg lifted, leg grab, standing on one leg, lifting leg, from side, cowboy shot, sweat, trembling, open mouth',
    prompt_nl: 'Standing sex position with one of the female partner\'s legs lifted and supported by the male, standing on one leg with side-angle cowboy framing highlighting muscle tension and vulnerable balance.'
  },
  {
    id: 'suspended_congress',
    name: '正向火车便当',
    canonical_en: 'suspended congress',
    aliases: [
      '正向火车便当', '正向抱起火车便当', '火车便当', '抱起悬空', '站立抱操', '抱起后插',
      'suspended congress', 'standing carry sex'
    ],
    summary: '男方站立将女方彻底悬空抱起，女方双腿缠腰双臂挽脖，充满纯粹肉体力量感。',
    prompt: 'suspended congress, lifting person, carrying, legs around waist, arms around neck, straight-on, full body shot, trembling, open mouth, heavy breathing, sweat, motion lines',
    prompt_nl: 'Suspended congress standing position, male carrying and lifting the female off the floor while she wraps both legs around his waist and arms around his neck, full-body shot displaying physical power and weightlessness.'
  },
  {
    id: 'reverse_suspended',
    name: '逆向火车便当',
    canonical_en: 'reverse suspended congress',
    aliases: [
      '逆向火车便当', '逆向反抱火车便当', '反向火车便当', '背向抱起', '背向悬空抱起',
      'reverse suspended congress', 'reverse suspended'
    ],
    summary: '男方从背后将女方悬空抱起反插，女方双腿凌空或向后蜷曲，臀部视觉焦点极强。',
    prompt: 'reverse suspended congress, lifting person, carrying, back view, from behind, legs up, folded, ass focus, back view, arched back, sweat, motion lines',
    prompt_nl: 'Reverse suspended congress position, lifting female from behind with her back facing the viewer, arched spine and legs lifted while supported mid-air, dynamic back perspective.'
  },
  {
    id: 'spooning',
    name: '汤匙侧卧',
    canonical_en: 'spooning',
    aliases: [
      '汤匙侧卧', '汤匙背后侧卧位', '侧卧后入', '背后侧卧', '勺子位', '侧卧交合',
      'spooning', 'lying on side sex'
    ],
    summary: '两人面朝同一方向并排侧卧如两把嵌套的汤匙，男方在后环抱交合，温存缠绵。',
    prompt: 'spooning, lying on side, from side, sex from behind, embrace, curled up, profile view, one leg raised, legs tangled, gentle intimacy, closed eyes, heavy breathing, sweat drops',
    prompt_nl: 'Gentle spooning position lying on side together, male embracing female from behind with bodies curved parallel in bed, profile view with tangled legs and quiet intimacy.'
  },
  {
    id: 'side_split',
    name: '侧卧提腿',
    canonical_en: 'side split',
    aliases: [
      '侧卧提腿', '侧卧一字马提腿位', '侧身抬腿', '侧卧一字马', '侧卧劈叉', '侧卧抬腿',
      'side split', 'lying split sex'
    ],
    summary: '女方侧躺在床，单腿大幅高举劈叉拉开，男方侧身抵住进入，构图线条极其修长。',
    prompt: 'from side, lying, split, one leg raised, leg grab, grabbing ankle, wide shot, dutch angle, trembling, sweat, steaming body, flushed face',
    prompt_nl: 'Side-lying split position with one leg lifted high and ankle held by the partner, side angle with dramatic diagonal framing capturing the wide leg stretch and intense flushed reaction.'
  },
  {
    id: 'piledriver',
    name: '倒栽折叠位',
    canonical_en: 'piledriver',
    aliases: [
      '倒栽折叠位', '倒栽折叠桩击位', '倒栽葱', '折叠打桩', '倒立桩击', '桩击位', '打桩机位',
      'piledriver', 'piledriver position'
    ],
    summary: '女方头部与双肩陷在床榻，下半身垂直倒立朝天被压迫，男方垂直强力打桩下压。',
    prompt: 'piledriver position, upside-down, inverted, legs straight up, feet up, from below, foreshortening, deep penetration, arched back, ahegao, trembling, speed lines',
    prompt_nl: 'Piledriver position with female partner inverted upside-down on the bed, legs pointed straight up with dramatic foreshortening from below, intense deep penetration focus with trembling expression.'
  },
  {
    id: 'handjob',
    name: '手交侍奉',
    canonical_en: 'handjob',
    aliases: [
      '手交侍奉', '手交', '撸管', '手动侍奉', '手部侍奉',
      'handjob', 'penis grab', 'stroked penis'
    ],
    summary: '女方使用手部握持并上下撸动男方下体，专注手部动作、表情与身体微前倾。',
    prompt: 'handjob, penis grab, stroked penis, gripping penis, sitting next to, leaning forward, blush, parted lips, looking down, sweat, trembling, intimate focus, cowboy shot',
    prompt_nl: 'Handjob intimate service, female sitting beside or leaning forward while holding and stroking firmly, looking down with flushed blushing face and parted lips, cowboy shot focused on intimate interaction.'
  },
  {
    id: 'fellatio',
    name: '口交侍奉',
    canonical_en: 'fellatio',
    aliases: [
      '口交侍奉', '口交', '吹奏', '含住', '深喉', '口部侍奉',
      'fellatio', 'blowjob', 'oral sex'
    ],
    summary: '女方跪姿面朝男方，口含男方下体进行侍奉，眼神向上仰视，伴随唾液与羞涩神情。',
    prompt: 'blowjob, fellatio, on knees, kneeling, looking up at viewer, eye contact, open mouth, tongue out, saliva, saliva trail, blush, tears in eyes, head tilted, cowboy shot',
    prompt_nl: 'Kneeling fellatio service, female on knees looking up at partner with wide moist eyes and head tilted, open mouth with delicate saliva trail, expressive flushed face captured in cowboy framing.'
  },
  {
    id: 'cunnilingus',
    name: '舔阴侍奉',
    canonical_en: 'cunnilingus',
    aliases: [
      '舔阴侍奉', '舔阴', '口舌侍奉', '口部承欢',
      'cunnilingus', 'female oral'
    ],
    summary: '女方仰卧展腿承受口舌侍奉，双手抓床单/弓背，面露极度欢愉与颤抖喘息。',
    prompt: 'cunnilingus, spread legs, on back, lying, face between legs, head between legs, gripping sheets, arched back, head back, heavy breathing, flushed face, trembling, pleasure expression, from side',
    prompt_nl: 'Cunnilingus oral service, female lying on back with spread legs and arched back gripping the bedsheets, partner head positioned between legs, side view emphasizing trembling flushed pleasure.'
  },
  {
    id: 'paizuri',
    name: '乳交侍奉',
    canonical_en: 'paizuri',
    aliases: [
      '乳交侍奉', '乳交', '夹胸', '胸部侍奉', '双乳夹磨',
      'paizuri', 'titfuck', 'breast hold'
    ],
    summary: '女方跪坐或前倾，双手将丰满双乳紧密向内挤压夹住男方，眼神上瞟娇羞喘息。',
    prompt: 'paizuri, breast hold, cleavage, large breasts, pressing breasts together, kneeling, leaning forward, looking up, blush, parted lips, sweat, precum, close-up, cowboy shot',
    prompt_nl: 'Paizuri breast service, female kneeling and leaning forward holding and pressing breasts firmly together around the partner, looking up with flushed cheeks, close-up cowboy framing.'
  },
  {
    id: 'footjob',
    name: '足交侍奉',
    canonical_en: 'footjob',
    aliases: [
      '足交侍奉', '足交', '玉足侍奉', '足底踩弄', '双足踩弄',
      'footjob', 'soles', 'bare feet'
    ],
    summary: '女方坐姿或居高临下，用光洁脚底/脚趾踩弄挑逗，神情带有一丝从容戏谑或微红。',
    prompt: 'footjob, soles, bare feet, toes, feet on crotch, sitting, crossed legs, looking down, smirk, seductive smile, blush, feet focus, from below, cowboy shot',
    prompt_nl: 'Footjob service, female sitting with legs crossed using bare soles and toes to tease and stroke, looking down with a seductive smirk and blush, low-angle cowboy shot highlighting feet.'
  },
  {
    id: 'sumata',
    name: '股间素股',
    canonical_en: 'sumata',
    aliases: [
      '股间素股', '素股', '股交', '大腿夹弄', '腿间摩擦',
      'sumata', 'thigh sex'
    ],
    summary: '男方在女方并拢的大腿内侧之间摩擦交合，不插入而通过双腿紧夹带来极致温润感。',
    prompt: 'sumata, thigh sex, between thighs, crossed legs, pressing thighs together, lying, on back, blush, trembling, wet skin, heavy breathing, close-up, eye contact',
    prompt_nl: 'Sumata thigh sex, partner rubbing between tightly pressed inner thighs while lying on back, intimate close-up focusing on flushed skin, trembling thighs, and mutual eye contact.'
  },
  {
    id: 'sixty_nine',
    name: '69式互侍',
    canonical_en: 'sixty-nine',
    aliases: [
      '69式互侍', '69式', '六九式', '互口', '互侍',
      '69', 'sixty-nine', '69 position'
    ],
    summary: '两人一上一下身体呈180度倒转对向卧姿，同时为对方进行口舌侍奉，极具几何交错美感。',
    prompt: '69, 69 position, sixty-nine, inverted, one on top, face to crotch, mutual oral, spread legs, lying, arched back, heavy breathing, trembling, sweat, side view',
    prompt_nl: 'Inverted sixty-nine 69 mutual oral position, one partner positioned on top facing the opposite direction, mutual mouth-to-crotch interaction, dynamic side view capturing arched bodies and trembling breath.'
  },
  {
    id: 'threesome_ffm',
    name: '双女侍奉',
    canonical_en: 'threesome ffm',
    aliases: [
      '双女侍奉', '双飞', '2女1男', '二女一男', '双女同欢',
      'ffm', 'threesome ffm', '2girls 1boy'
    ],
    summary: '两名女性角色一左一右或前后环绕一名男性，进行亲吻、拥抱与共同侍奉。',
    prompt: '2girls, 1boy, ffm threesome, sandwiched, girls flanking male, one kissing, one embracing, shared intimacy, intimate touch, bed, bedroom, multiple views suppressed, rim light, wide shot',
    prompt_nl: 'FFM threesome scene with two females flanking and embracing a single male partner, one kissing and one holding hands on a wide bed, cinematic rim lighting and wide shot.'
  },
  {
    id: 'threesome_mmf',
    name: '双男夹击',
    canonical_en: 'threesome mmf',
    aliases: [
      '双男夹击', '双龙', '夹心', '1女2男', '一女二男', '两男一女',
      'mmf', 'threesome mmf', '1girl 2boys'
    ],
    summary: '两名男性角色从前后或两侧包围一名女性，女性处于中心位置，承受双重互动。',
    prompt: '1girl, 2boys, mmf threesome, sandwiched, girl in center, surrounded, front and behind, double attention, overwhelmed expression, blushing, trembling, tearful, bedroom, close-up',
    prompt_nl: 'MMF threesome scene with one female centered between two male partners front and behind, female showing overwhelmed blushing emotional reaction, close-up composition with dramatic lighting.'
  },
  {
    id: 'group_harem',
    name: '群芳簇拥',
    canonical_en: 'harem group',
    aliases: [
      '群芳簇拥', '后宫簇拥', '众女相伴', '群女侍奉',
      'harem', 'multiple girls 1boy'
    ],
    summary: '三名或更多女性围绕一名男性，形成膝枕、倚靠、牵手等温存华丽的后宫群像画面。',
    prompt: 'multiple girls, 1boy, male harem, girls surrounding, leaning on person, lap pillow, holding hands, affection, gentle smiles, luxurious bed, volumetric lighting, rim light, wide shot',
    prompt_nl: 'Harem group scene with multiple girls gathering affectionately around one male, featuring lap pillow, gentle smiles, and soft physical contact on a luxurious bed, wide shot with volumetric lighting.'
  },
  {
    id: 'group_gangbang',
    name: '群像围攻',
    canonical_en: 'gangbang group',
    aliases: [
      '群像围攻', '轮番包围', '群像包围', '众男围攻',
      'gangbang', '1girl multiple boys'
    ],
    summary: '单名女性面对多名男性的包围与互动，强化空间压迫感、中心焦点与动人情绪。',
    prompt: '1girl, multiple boys, gangbang, surrounded, crowded, overwhelming, hands reaching, kneeling, helpless expression, flushed, trembling, high contrast, dramatic shadows',
    prompt_nl: 'Group scene with one female surrounded by multiple male figures in a crowded space, hands reaching toward the center, high contrast and dramatic shadows highlighting intense emotional vulnerability.'
  }
];

export const STANDARD_SEX_POSITION_NAMES = STANDARD_SEX_POSITIONS.map(p => p.name);

// 建立精确与模糊索引表
const ALIAS_MAP = new Map();
for (const pos of STANDARD_SEX_POSITIONS) {
  ALIAS_MAP.set(pos.name.toLowerCase(), pos);
  ALIAS_MAP.set(pos.id.toLowerCase(), pos);
  ALIAS_MAP.set(pos.canonical_en.toLowerCase(), pos);
  for (const alias of pos.aliases) {
    ALIAS_MAP.set(alias.toLowerCase(), pos);
  }
}

// 收集所有别名，按别名长度从长到短排序（贪婪最长匹配）
const SORTED_ALIASES = [];
for (const pos of STANDARD_SEX_POSITIONS) {
  for (const alias of pos.aliases) {
    if (alias.length >= 2) {
      SORTED_ALIASES.push({ alias: alias.toLowerCase(), pos });
    }
  }
}
SORTED_ALIASES.sort((a, b) => b.alias.length - a.alias.length);

/**
 * 智能查找/匹配体位定义
 * @param {string} text - 待检测的体位名称、标签或上下文描述
 * @returns {object|null} 匹配到的体位对象或 null
 */
export function findSexPosition(text) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;

  // 1. 精确或小写匹配
  const lower = raw.toLowerCase();
  if (ALIAS_MAP.has(lower)) {
    return ALIAS_MAP.get(lower);
  }

  // 2. 别名包含匹配（优先更长词长，避免“后入”误撞“站立后入”或“趴在床上后入”）
  for (const entry of SORTED_ALIASES) {
    if (lower.includes(entry.alias)) {
      return entry.pos;
    }
  }

  // 3. 常见特征关键字模糊检测
  if (/mating[_ -]?press|折叠|种付/.test(lower)) return ALIAS_MAP.get('mating_press');
  if (/piledriver|倒立|倒栽|打桩/.test(lower)) return ALIAS_MAP.get('piledriver');
  if (/reverse[_ -]?cowgirl|反骑乘|背向骑乘|背对骑乘/.test(lower)) return ALIAS_MAP.get('reverse_cowgirl');
  if (/cowgirl|骑乘|女上位/.test(lower)) return ALIAS_MAP.get('cowgirl');
  if (/reverse[_ -]?suspended|反向火车便当|逆向.*便当/.test(lower)) return ALIAS_MAP.get('reverse_suspended');
  if (/suspended[_ -]?congress|火车便当|悬空抱/.test(lower)) return ALIAS_MAP.get('suspended_congress');
  if (/standing[_ -]?doggystyle|站立后入|倚墙后入|靠墙.*后入/.test(lower)) return ALIAS_MAP.get('standing_doggystyle');
  if (/prone[_ -]?bone|俯卧后入|趴在床上后入|压背俯卧/.test(lower)) return ALIAS_MAP.get('prone_bone');
  if (/doggystyle|四足|跪趴|后入|狗爬/.test(lower)) return ALIAS_MAP.get('doggystyle');
  if (/missionary|传教士|仰卧正身|正身位/.test(lower)) return ALIAS_MAP.get('missionary');
  if (/spooning|汤匙|侧卧后入|侧卧交合/.test(lower)) return ALIAS_MAP.get('spooning');
  if (/side[_ -]?split|一字马|侧卧提腿|侧卧抬腿/.test(lower)) return ALIAS_MAP.get('side_split');
  if (/reverse[_ -]?lap|背向坐/.test(lower)) return ALIAS_MAP.get('reverse_lap');
  if (/lap[_ -]?sitting|面对面对坐|怀抱对坐|树袋熊/.test(lower)) return ALIAS_MAP.get('lap_sitting');
  if (/one[_ -]?leg|单腿站立|单腿架起/.test(lower)) return ALIAS_MAP.get('one_leg_lift');

  // 4. 亲密侍奉与非直接性爱特征关键字
  if (/handjob|手交|撸管|手部侍奉|手动侍奉/.test(lower)) return ALIAS_MAP.get('handjob');
  if (/fellatio|blowjob|oral sex|口交|吹奏|深喉|含住|口部侍奉/.test(lower)) return ALIAS_MAP.get('fellatio');
  if (/cunnilingus|female oral|舔阴|口舌侍奉|口部承欢/.test(lower)) return ALIAS_MAP.get('cunnilingus');
  if (/paizuri|titfuck|乳交|夹胸|双乳夹|胸部侍奉/.test(lower)) return ALIAS_MAP.get('paizuri');
  if (/footjob|足交|玉足|足底踩|双足踩/.test(lower)) return ALIAS_MAP.get('footjob');
  if (/sumata|thigh sex|素股|股间|大腿夹|腿间摩擦/.test(lower)) return ALIAS_MAP.get('sumata');
  if (/69|sixty[-_ ]?nine|六九式|互口|互侍/.test(lower)) return ALIAS_MAP.get('sixty_nine');

  // 5. 多人群像互动特征关键字
  if (/threesome[_ -]?ffm|双女|双飞|2女1男|二女一男|双女同欢/.test(lower)) return ALIAS_MAP.get('threesome_ffm');
  if (/threesome[_ -]?mmf|双男|双龙|夹心|1女2男|一女二男|两男一女/.test(lower)) return ALIAS_MAP.get('threesome_mmf');
  if (/harem|群芳|后宫|众女|群女/.test(lower)) return ALIAS_MAP.get('group_harem');
  if (/gangbang|群像围攻|群像包围|轮番包围|众男围攻/.test(lower)) return ALIAS_MAP.get('group_gangbang');

  return null;
}
