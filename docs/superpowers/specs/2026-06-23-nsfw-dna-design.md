# NSFW DNA Feature Design

## Goal

Add a dedicated structured DNA feature field named `NSFW标签` for stable private-body traits that should persist across scenes and be injected into prompt generation by default.

This field is for stable character attributes only. It must not store scene state, temporary body state, or act-specific content.

## Scope

Affected areas:

- Character DNA extraction prompt and post-processing
- Character DNA frontend editor and feature display
- Character DNA persistence through existing `features` editing APIs
- Prompt builder DNA injection logic
- Focused backend tests for extraction cleanup and prompt inheritance

Out of scope:

- No migration of legacy storage keys such as `tags` or `llm_nai_tags_*`
- No redesign of scene cards
- No change to global prompt routing behavior

## Data Model

Extend `character.features` with one additional key:

- `NSFW标签: string[]`

Semantics:

- Stores stable private-body traits only
- Intended examples: `large breasts`, `huge breasts`, `flat chest`, `small penis`, `large penis`, `thick penis`, `long penis`
- Forbidden examples: `nude`, `erection`, `wet`, `orgasm`, `cum`, `sweat`, `spread legs`

The existing flattened `char.tags` string remains for compatibility and will include cleaned `NSFW标签` values during reassembly.

## Extraction Rules

Update the character DNA system prompt so the model outputs `NSFW标签` as a fixed structured feature bucket.

Rules:

- `NSFW标签` is only for long-term physical traits
- It must never contain temporary exposure, arousal, fluid, orgasm, or pose terms
- It may contain explicit but stable anatomy descriptors when supported by text or conservative completion rules

Post-processing in `extractCharacterDNA()` will:

- Continue filtering feature arrays through the transient-tag cleanup path
- Include `NSFW标签` in the deterministic feature merge order used to rebuild `char.tags`

## Prompt Injection

`NSFW标签` should participate in character DNA prompt inheritance by default, with composition-aware filtering:

- `头像`: never inject `NSFW标签`
- `部位特写`:
  - `胸部` may inherit chest-related `NSFW标签`
  - other part close-ups should stay conservative unless the existing part-specific filter naturally allows the term
- normal scene, half-body, and standing illustration compositions: inject `NSFW标签` alongside other stable DNA features

This still respects existing scene-state override and cleanup logic. The new field provides stable anatomy bias, not scene-state instructions.

## Frontend

Add `NSFW标签` to `dnaFeatureOrder` so it appears in:

- character feature display
- structured DNA editor
- empty editor state
- serialization back to the `/features` API

UI behavior stays the same:

- comma-separated input
- autosaved only when the user clicks save
- no extra control surface

## Validation

The implementation should add focused tests for:

- extraction cleanup keeps stable values like `large breasts`
- extraction cleanup removes transient values like `erection`
- normal scene prompt inheritance includes stable NSFW DNA traits
- portrait composition excludes `NSFW标签`
- chest close-up can inherit chest-related NSFW DNA traits

## Risks

- If filtering is too loose, scene-state explicit terms could leak into persistent DNA
- If filtering is too strict, valid stable anatomy traits may be dropped
- Portrait and close-up composition filters must remain conservative to avoid accidental camera drift

## Recommendation

Implement `NSFW标签` as a single new structured feature bucket and wire it through the existing `features` pipeline without changing legacy compatibility fields.
