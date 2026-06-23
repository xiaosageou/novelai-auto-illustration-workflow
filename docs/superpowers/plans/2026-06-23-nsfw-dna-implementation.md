# NSFW DNA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated `NSFW标签` structured DNA field for stable private-body traits and make it participate in character DNA extraction, editing, persistence, and prompt inheritance.

**Architecture:** Extend the existing `features` pipeline rather than creating a parallel storage path. The implementation touches the character DNA schema prompt, extraction cleanup/merge order, frontend feature editor ordering, and prompt-builder composition-aware inheritance filters.

**Tech Stack:** Node.js, Express, React, Vite, `node:test`

---

### Task 1: Add focused failing tests for `NSFW标签`

**Files:**
- Modify: `server/test/prompt-pipeline.test.js`
- Test: `server/test/prompt-pipeline.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test('character dna cleanup keeps stable nsfw traits and drops transient ones', async () => {
  // mock extractCharacterDNA LLM response with NSFW标签 containing stable + transient values
});

test('normal scene prompt inherits stable nsfw dna traits', () => {
  // buildFinalImagePrompt should include large breasts / large penis in normal scene prompts
});

test('portrait composition excludes nsfw dna traits', () => {
  // 构建角色锚点注入提示词 should not leak NSFW标签 into portrait-style output
});

test('chest close-up can inherit chest-related nsfw dna traits', () => {
  // chest close-up should keep chest-related NSFW标签
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern "nsfw dna|stable nsfw|portrait composition excludes nsfw|chest close-up can inherit" server/test/prompt-pipeline.test.js`

Expected: FAIL because `NSFW标签` is not yet recognized by cleanup, editor ordering, or prompt inheritance logic.

- [ ] **Step 3: Commit the failing tests**

```bash
git add server/test/prompt-pipeline.test.js
git commit -m "test: cover nsfw dna feature behavior"
```

### Task 2: Wire `NSFW标签` through extraction and prompt generation

**Files:**
- Modify: `server/utils/default-prompts.js`
- Modify: `server/services/llm-extractor.js`
- Modify: `server/services/prompt-builder.js`
- Test: `server/test/prompt-pipeline.test.js`

- [ ] **Step 1: Update the character DNA extraction prompt contract**

```js
// Add "NSFW标签" to the fixed structured feature buckets.
// Document that it only accepts stable private-body traits and forbids state words.
```

- [ ] **Step 2: Run the extraction-related tests and keep them failing only on implementation**

Run: `node --test --test-name-pattern "character dna cleanup keeps stable nsfw traits" server/test/prompt-pipeline.test.js`

Expected: FAIL because cleanup and merge order do not yet include `NSFW标签`.

- [ ] **Step 3: Implement minimal extraction cleanup and merge-order support**

```js
const orderedKeys = [
  "外貌标签",
  "身材标签",
  "胸部标签",
  "NSFW标签",
  "发型标签",
  "发色标签",
  "眼睛标签",
  "肤色标签",
  "年龄感标签",
  "服装基底标签",
  "特殊特征标签"
];
```

- [ ] **Step 4: Implement composition-aware prompt inheritance for `NSFW标签`**

```js
// Portrait: exclude NSFW标签
// Chest close-up: allow chest-related NSFW traits
// Normal scene / half-body / standing illustration: include NSFW标签
```

- [ ] **Step 5: Run the focused tests to verify they pass**

Run: `node --test --test-name-pattern "nsfw dna|stable nsfw|portrait composition excludes nsfw|chest close-up can inherit" server/test/prompt-pipeline.test.js`

Expected: PASS

- [ ] **Step 6: Commit the backend implementation**

```bash
git add server/utils/default-prompts.js server/services/llm-extractor.js server/services/prompt-builder.js server/test/prompt-pipeline.test.js
git commit -m "feat: add stable nsfw dna traits"
```

### Task 3: Expose `NSFW标签` in the frontend structured DNA editor

**Files:**
- Modify: `client/src/App.jsx`
- Test: `client/src/App.jsx`

- [ ] **Step 1: Add `NSFW标签` to the frontend feature ordering**

```js
const dnaFeatureOrder = [
  '外貌标签',
  '身材标签',
  '胸部标签',
  'NSFW标签',
  '发型标签',
  '发色标签',
  '眼睛标签',
  '肤色标签',
  '年龄感标签',
  '服装基底标签',
  '特殊特征标签'
];
```

- [ ] **Step 2: Keep editor serialization unchanged except for the new key**

```js
// emptyCharacterFeatures, featuresToEditorState, editorStateToFeatures, and renderDnaFeatures
// should automatically include the new field once dnaFeatureOrder is extended
```

- [ ] **Step 3: Build the frontend to verify it still compiles**

Run: `npm run build`

Working directory: `client`

Expected: PASS

- [ ] **Step 4: Commit the frontend wiring**

```bash
git add client/src/App.jsx
git commit -m "feat: expose nsfw dna feature field"
```

### Task 4: Final verification

**Files:**
- Modify: none
- Test: `server/test/prompt-pipeline.test.js`

- [ ] **Step 1: Re-run the focused backend test suite**

Run: `node --test --test-name-pattern "advanced prompt receives lightweight scene-card context fields|NSFW advanced prompt asks for camera choice|directional sex actions add natural language|directional sex actions ignore mutual|penetration scenes only keep inset|final negative prompt includes mosaic|multi-character prompts keep scale|interactive two-character prompt avoids|V4.5 prompt budget keeps interaction|character prompts follow left-to-right|nsfw dna|stable nsfw|portrait composition excludes nsfw|chest close-up can inherit" server/test/prompt-pipeline.test.js`

Expected: PASS

- [ ] **Step 2: Re-run frontend build**

Run: `npm run build`

Working directory: `client`

Expected: PASS

- [ ] **Step 3: Commit any final verification fallout**

```bash
git add -A
git commit -m "test: verify nsfw dna feature integration"
```
