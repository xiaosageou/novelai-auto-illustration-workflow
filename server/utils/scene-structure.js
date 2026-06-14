function cleanText(value) {
  return String(value || '').trim();
}

function normalizeCharacter(raw = {}) {
  if (typeof raw === 'string') {
    return {
      name: cleanText(raw),
      gender: 'unknown',
      appearance: '',
      clothing: '',
      expression: '',
      pose: '',
      position: ''
    };
  }

  return {
    name: cleanText(raw.name),
    gender: cleanText(raw.gender || raw.sex || 'unknown') || 'unknown',
    appearance: cleanText(raw.appearance || raw.features || raw.look),
    clothing: cleanText(raw.clothing || raw.outfit || raw.costume),
    expression: cleanText(raw.expression || raw.emotion),
    pose: cleanText(raw.pose || raw.action),
    position: cleanText(raw.position || raw.location)
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(cleanText).filter(Boolean))];
  }
  if (typeof value === 'string') {
    return [...new Set(value.split(/[,，；;\n]+/).map(cleanText).filter(Boolean))];
  }
  return [];
}

function normalizeVisualEntity(raw = {}) {
  if (typeof raw === 'string') {
    return {
      type: 'object',
      description: cleanText(raw),
      count: 1,
      position: '',
      must_show: true
    };
  }
  return {
    type: cleanText(raw.type || raw.entity_type || 'object') || 'object',
    description: cleanText(raw.description || raw.name || raw.content),
    count: Math.max(1, Number(raw.count) || 1),
    position: cleanText(raw.position || raw.location),
    must_show: raw.must_show !== false
  };
}

function normalizeInteractionAction(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const action = cleanText(raw.action || raw.tag || raw.interaction);
  if (!action) return null;
  return {
    action,
    source: cleanText(raw.source || raw.actor || raw.donor),
    target: cleanText(raw.target || raw.receiver || raw.recipient),
    mutual: raw.mutual === true || /mutual|each other|互相|彼此|相互/.test(cleanText(raw.role))
  };
}

function normalizeCharacterNameList(rawScene = {}, characters = []) {
  const directList = rawScene.character_names || rawScene.scene_characters || rawScene.characterNames;
  const names = [];

  if (Array.isArray(directList)) {
    names.push(...directList.map(item => {
      if (typeof item === 'string') return item;
      return item?.name || item?.character || item?.角色 || '';
    }));
  } else if (typeof directList === 'string') {
    names.push(...directList.split(/[,，、\s]+/));
  }

  for (const char of characters) {
    if (char.name) names.push(char.name);
  }

  return [...new Set(names.map(cleanText).filter(Boolean))];
}

function inferVisualEntities(rawScene = {}) {
  const explicit = Array.isArray(rawScene.visual_entities)
    ? rawScene.visual_entities.map(normalizeVisualEntity).filter(item => item.description)
    : [];
  if (explicit.length > 0) return explicit;

  const text = [
    rawScene.visual_description,
    rawScene.scene_desc,
    rawScene.environment,
    rawScene.cinematography,
    rawScene.interactions
  ].map(cleanText).join(' ');
  const entities = [];
  if (/屏风|剪影|人影|silhouette|shadow[_ ]play/i.test(text)) {
    const shadowCount = /两个|一男一女|男女|two/i.test(text) ? 2 : 1;
    entities.push({
      type: 'shadow_silhouette',
      description: shadowCount === 2 ? 'two overlapping human silhouettes behind a translucent screen' : 'human silhouette behind a translucent screen',
      count: shadowCount,
      position: 'midground',
      must_show: true
    });
  }
  if (/门缝|door crack/i.test(text)) {
    entities.push({
      type: 'framing_object',
      description: 'narrow door crack with dark doorframe edges',
      count: 1,
      position: 'foreground',
      must_show: true
    });
  }
  return entities;
}

function inferMustShow(rawScene = {}, visualEntities = []) {
  const explicit = normalizeStringList(rawScene.must_show);
  const text = [
    rawScene.visual_description,
    rawScene.scene_desc,
    rawScene.cinematography,
    rawScene.interactions,
    rawScene.plot_traces
  ].map(cleanText).join(' ');
  const inferred = [];
  if (/剑尖.*喉|喉.*剑尖|sword.*throat/i.test(text)) {
    inferred.push(
      'sword_tip_touching_throat',
      'blade_pressed_against_neck',
      'visible_sword_tip',
      'visible_throat_contact',
      'side_view'
    );
  }
  if (/扣.*扣子|扣上衣扣|buttoning/i.test(text)) {
    inferred.push('buttoning_clothes', 'hands_holding_buttons', 'partially_buttoned_robe');
  }
  for (const entity of visualEntities) {
    if (entity.type === 'shadow_silhouette') {
      inferred.push(entity.count >= 2 ? 'two_human_silhouettes' : 'human_silhouette', 'silhouette_behind_screen');
    }
    if (entity.type === 'framing_object') {
      inferred.push('view_through_door_crack', 'dark_doorframe_foreground');
    }
  }
  return [...new Set([...explicit, ...inferred])];
}

function inferMustNotShow(rawScene = {}) {
  const explicit = normalizeStringList(rawScene.must_not_show);
  const text = [
    rawScene.visual_description,
    rawScene.scene_desc,
    rawScene.cinematography,
    rawScene.interactions
  ].map(cleanText).join(' ');
  const inferred = [];
  if (/剑尖.*喉|喉.*剑尖|sword.*throat/i.test(text)) {
    inferred.push('swinging_sword', 'sword_pointing_away', 'gap_between_sword_and_throat');
  }
  if (/扣.*扣子|扣上衣扣|buttoning/i.test(text)) {
    inferred.push('fully_open_robe', 'hands_away_from_clothes');
  }
  return [...new Set([...explicit, ...inferred])];
}

export function getSceneCharacters(scene = {}) {
  const chars = Array.isArray(scene.characters)
    ? scene.characters
    : (Array.isArray(scene.scene_characters) ? scene.scene_characters : []);
  return chars.map(normalizeCharacter).filter(char => {
    return char.name || char.appearance || char.clothing || char.expression || char.pose || char.position;
  });
}

export function buildSceneDescription(scene = {}) {
  const visual = cleanText(scene.visual_description || scene.scene_desc);
  if (visual) return visual;

  const characterText = getSceneCharacters(scene).map(char => {
    const parts = [
      char.name,
      char.gender && char.gender !== 'unknown' ? char.gender : '',
      char.appearance,
      char.clothing,
      char.expression,
      char.pose,
      char.position
    ].filter(Boolean);
    return parts.join('，');
  }).filter(Boolean).join('；');

  return [
    cleanText(scene.environment),
    cleanText(scene.cinematography),
    characterText,
    cleanText(scene.interactions),
    cleanText(scene.text_elements)
  ].filter(Boolean).join('；') || 'anime style, detailed illustration';
}

export function serializeSceneForMatching(scene = {}) {
  const chars = getSceneCharacters(scene).map(char => Object.values(char).filter(Boolean).join(' ')).join(' ');
  return [
    Array.isArray(scene.character_names) ? scene.character_names.join(' ') : scene.character_names,
    scene.scene_desc,
    scene.visual_description,
    scene.environment,
    scene.cinematography,
    chars,
    scene.interactions,
    scene.plot_traces,
    scene.text_elements
  ].map(cleanText).filter(Boolean).join(' ');
}

export function normalizeSceneCard(rawScene = {}) {
  // 合法的 NSFW 等级白名单，防止 LLM 乱写
  const VALID_NSFW = new Set(['sfw', 'nsfw_mild', 'nsfw_moderate', 'nsfw_explicit']);
  const rawNsfw = cleanText(rawScene.nsfw_rating || rawScene.nsfw || '');

  const characters = getSceneCharacters(rawScene);
  const listedNames = normalizeCharacterNameList(rawScene, characters);
  const characterNames = new Set(characters.map(char => char.name).filter(Boolean));
  for (const name of listedNames) {
    if (!characterNames.has(name)) {
      characters.push(normalizeCharacter({ name, gender: 'unknown' }));
      characterNames.add(name);
    }
  }

  const visualEntities = inferVisualEntities(rawScene);
  const interactionActions = (Array.isArray(rawScene.interaction_actions)
    ? rawScene.interaction_actions
    : (Array.isArray(rawScene.interactionActions) ? rawScene.interactionActions : []))
    .map(normalizeInteractionAction)
    .filter(Boolean)
    .filter(interaction => (
      characterNames.has(interaction.source)
      && characterNames.has(interaction.target)
    ));

  const normalized = {
    scene_idx: Number(rawScene.scene_idx) || Number(rawScene.scene_id) || 1,
    trigger_sentence: cleanText(rawScene.trigger_sentence),
    nsfw_rating: VALID_NSFW.has(rawNsfw) ? rawNsfw : 'sfw',
    visual_description: cleanText(rawScene.visual_description || rawScene.scene_desc),
    environment: cleanText(rawScene.environment),
    cinematography: cleanText(rawScene.cinematography),
    characters,
    character_names: characters.map(char => char.name).filter(Boolean),
    interactions: cleanText(rawScene.interactions),
    interaction_actions: interactionActions,
    plot_traces: cleanText(rawScene.plot_traces),
    text_elements: cleanText(rawScene.text_elements),
    visual_entities: visualEntities,
    must_show: inferMustShow(rawScene, visualEntities),
    must_not_show: inferMustNotShow(rawScene)
  };

  if (!normalized.text_elements) {
    normalized.must_not_show = [...new Set([
      ...normalized.must_not_show,
      'readable text',
      'signboard writing',
      'watermark'
    ])];
  }

  normalized.scene_desc = buildSceneDescription(normalized);
  return normalized;
}
