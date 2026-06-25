export const SCENE_CHARACTER_DETAIL_FIELDS = ['appearance', 'clothing', 'expression', 'pose', 'position'];

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
