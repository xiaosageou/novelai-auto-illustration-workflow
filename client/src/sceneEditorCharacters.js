export const SCENE_CHARACTER_DETAIL_FIELDS = ['appearance', 'clothing', 'expression', 'pose', 'position'];

export function createEmptySceneCharacterInteraction(defaults = {}) {
  return {
    role: String(defaults?.role || '').trim(),
    action: String(defaults?.action || '').trim(),
    target: String(defaults?.target || '').trim()
  };
}

export function normalizeSceneCharacterInteractionList(value = null) {
  if (Array.isArray(value)) {
    return value
      .map(item => createEmptySceneCharacterInteraction(item))
      .filter(item => item.role && item.action && item.target);
  }
  if (value && typeof value === 'object' && Array.isArray(value.interactions)) {
    return value.interactions
      .map(item => createEmptySceneCharacterInteraction(item))
      .filter(item => item.role && item.action && item.target);
  }
  const single = createEmptySceneCharacterInteraction(value);
  return single.role && single.action && single.target ? [single] : [];
}

export function formatCharacterPromptInteractionTag(interactions = []) {
  return normalizeSceneCharacterInteractionList(interactions)
    .map(({ role, action, target }) => `[${role}:${action}->${target}]`)
    .join(' ');
}

export function formatCharacterPromptDisplayLine(prompt = '', interactions = []) {
  const cleanPrompt = String(prompt || '').trim();
  const tag = formatCharacterPromptInteractionTag(interactions);
  if (!tag) return cleanPrompt;
  return cleanPrompt ? `${tag} ${cleanPrompt}` : tag;
}

export function stripCharacterPromptDisplayTag(prompt = '') {
  return String(prompt || '').replace(/^(?:\[(?:source|target|mutual):[^\]]+\]\s*)+/i, '').trim();
}

export function formatSceneCharacterInteractionLines(interactions = []) {
  return normalizeSceneCharacterInteractionList(interactions)
    .map(({ role, action, target }) => `${role} | ${action} | ${target}`)
    .join('\n');
}

export function parseSceneCharacterInteractionLines(value = '') {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [role, action, target] = line.split('|').map(item => String(item || '').trim());
      return createEmptySceneCharacterInteraction({ role, action, target });
    })
    .filter(item => item.role && item.action && item.target);
}

export function createEmptySceneCharacter(name = '', defaults = {}) {
  return {
    name: String(name || '').trim(),
    gender: String(defaults?.gender || 'unknown').trim() || 'unknown',
    appearance: String(defaults?.appearance || '').trim(),
    clothing: String(defaults?.clothing || '').trim(),
    expression: String(defaults?.expression || '').trim(),
    pose: String(defaults?.pose || '').trim(),
    position: String(defaults?.position || '').trim()
  };
}

export function parseSceneCharacterNames(value = '') {
  return [...new Set(
    String(value || '')
      .split(/[\n,，]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

export function syncSceneCharactersFromNames(namesInput = '', existingCharacters = [], characterRegistry = {}) {
  const existingMap = new Map(
    (Array.isArray(existingCharacters) ? existingCharacters : [])
      .map((character) => {
        const name = String(character?.name || '').trim();
        if (!name) return null;
        return [name, createEmptySceneCharacter(name, character)];
      })
      .filter(Boolean)
  );

  return parseSceneCharacterNames(namesInput).map((name) => {
    const existing = existingMap.get(name);
    if (existing) return existing;

    const registryCharacter = characterRegistry?.[name];
    return createEmptySceneCharacter(name, {
      gender: registryCharacter?.gender || 'unknown'
    });
  });
}

export function syncSceneCharacterInteractions(sceneCharacters = [], existingInteractions = [], seededInteractions = []) {
  const existingByName = new Map(
    (Array.isArray(existingInteractions) ? existingInteractions : [])
      .map((interaction, index) => {
        const name = String(sceneCharacters[index]?.name || '').trim();
        if (!name) return null;
        return [name, normalizeSceneCharacterInteractionList(interaction)];
      })
      .filter(Boolean)
  );

  const seededByName = new Map(
    (Array.isArray(seededInteractions) ? seededInteractions : [])
      .map((interaction) => {
        const name = String(interaction?.name || '').trim();
        if (!name) return null;
        return [name, normalizeSceneCharacterInteractionList(interaction)];
      })
      .filter(Boolean)
  );

  return (Array.isArray(sceneCharacters) ? sceneCharacters : []).map((character) => {
    const name = String(character?.name || '').trim();
    return existingByName.get(name)
      || seededByName.get(name)
      || [];
  });
}

export function characterHasSceneDetails(character = {}) {
  return SCENE_CHARACTER_DETAIL_FIELDS.some((field) => String(character?.[field] || '').trim());
}

export function buildCharacterReferenceSummary(characterRecord = {}) {
  if (!characterRecord || typeof characterRecord !== 'object') return '';

  const features = characterRecord.features || {};
  const fragments = [];
  const gender = String(characterRecord.gender || '').trim();
  if (gender) fragments.push(gender);

  const orderedKeys = [
    '外貌标签',
    '身材标签',
    '发型标签',
    '发色标签',
    '眼睛标签',
    '肤色标签',
    '服装基底标签',
    '特殊特征标签'
  ];

  for (const key of orderedKeys) {
    const values = Array.isArray(features[key]) ? features[key].map((item) => String(item || '').trim()).filter(Boolean) : [];
    fragments.push(...values);
  }

  return [...new Set(fragments)].join(', ');
}
