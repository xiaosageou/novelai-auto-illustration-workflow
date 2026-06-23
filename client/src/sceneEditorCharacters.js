export const SCENE_CHARACTER_DETAIL_FIELDS = ['appearance', 'clothing', 'expression', 'pose', 'position'];

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
