import fs from 'fs';

// Read current tags prompt and nl prompt
const tagsPromptPath = 'docs/current_prompt_tags.txt';
const nlPromptPath = 'docs/current_prompt_nl.txt';

let tagsPrompt = fs.readFileSync(tagsPromptPath, 'utf8');
let nlPrompt = fs.readFileSync(nlPromptPath, 'utf8');

// Replacement for tags prompt Camera section
const oldTagsCamera = `## Camera And Focus
- Prefer close framing that keeps the subjects large and readable: close-up, medium close-up, cowboy shot, upper body, from waist up.
- Avoid far framing by default: wide shot, far shot, long shot, panorama, or environment-only distance views unless the scene card clearly requires them.
- Add camera/focus tags only when they clarify the image: pov, portrait, cowboy shot, close-up, lower body, head out of frame, eye focus, breast focus, foot focus.`;

const newTagsCamera = `## Camera, Lighting & Composition Architecture (电影级构图系统)

### 1. 景别分流法则 (Framing by Scene Intent)
禁止一律使用单调近景。根据场景戏剧目的选择最佳截景：
- **穿搭展示与双人体态平衡 (立绘/交互/穿搭)**: 优先使用 \`cowboy shot\` (美式七分身) 或 \`medium shot\` (半身)。这是黄金标准：既能完整展现服装、腰身曲线，又能保持精致五官不糊。配合 \`feet out of frame\` 消除脚部画崩。
- **微表情与亲密情绪 (特写/微表情/五官抗糊)**: \`close-up\`, \`medium close-up\`, \`portrait\`, \`face focus\`, \`upper body\`。用于眼泪、低语、吻戏或微表情刻画。当五官细节容易模糊时必用。
- **宏大叙事与场景烘托 (史诗/战场/废墟/大自然)**: \`wide shot\`, \`scenery focus\`, \`grand scale\`。必须搭配 \`solo focus\` 或 \`small 1girl in vast ruins\` 以及 \`vanishing point\`，防止人物消失或变成画崩的小人。
- **失衡惊悚与激烈对抗 (打斗/突袭/狂奔/失重)**: \`dutch angle\` (倾斜机位), \`tilted frame\`, \`dynamic angle\`, \`diagonal composition\`。彻底打破呆板水平线，注入动势张力。
- **透视缩短防畸变 (冲刺/扑杀/向镜头出拳刺剑)**: 当肢体或武器冲向镜头时，必须强制加入 \`foreshortening, dynamic perspective\`，防止肢体短小畸变。

### 2. 三层空间纵深法则 (Foreground - Midground - Background)
绝不生成扁平二维平面，必须在 base_prompt 构筑清晰的纵深层次：
- **前景框架与遮挡 (Foreground)**: 利用前景元素增强电影感与窥视感：\`tree branches framing\`, \`leaves framing foreground\`, \`peeking through window\`, \`viewing through doorway\`, \`blurry foreground\`。
- **中景主体 (Midground)**: 核心角色的姿态张力、四肢受力与接触互动。
- **背景光斑与景深虚化 (Background Depth)**: 通过光学景深将主体从背景剥离：\`bokeh, shallow depth of field, blurry background, distant skyline\`。

### 3. 光影结构与轮廓剥离 (Lighting as Structural Geometry)
光线是构图的骨骼，base_prompt 必须包含明确的主导光影向量：
- **边缘轮廓光 (Rim Light)**: 必备 \`1.3::rim light, backlighting::\`。在人物发丝和身躯边缘打出一圈柔亮光晕，瞬间将角色从暗部或复杂背景中剥离，提升三维质感。
- **氛围体积光**:
  - 史诗/神秘: \`volumetric lighting, visible light beams, tyndall effect, chiaroscuro, cinematic shadows\`
  - 浪漫/怀旧: \`golden hour, warm twilight, sunset glow, dappled sunlight filtering through leaves\`
  - 战斗/高反差: \`high contrast, light diffusion, chromatic aberration\`

### 4. 视线引导演绎 (Gaze Vectors)
- 破壁直击感: \`looking at viewer\`
- 沉浸叙事感 (思考/孤独/未知): \`looking away, looking at distance, looking down, closed eyes\`
- 故事叙事与背部曲线: \`back view, from behind, turning head, looking back over shoulder\`

### 5. 防多格切片铁律 (Anti-Multi-View Suppression)
复杂场景或多人时，极易退化成分镜漫画格。
- 必须在 negative_prompt 或 base_prompt 明确加入抑制：\`-1.5::multiple views::, -2::multiple views, bad multiple views, split screen, comic::\``;

tagsPrompt = tagsPrompt.replace(oldTagsCamera, newTagsCamera);

// Replacement for NL prompt
const oldNlCamera = `## Camera and Perspective Rules (Mature scenes)
对于非 SFW 场景，base_prompt 必须包含一个明确的机位描述，例如 "viewed from a three-quarter angle"、"shot from slightly above"、"side view showing both characters"。并包含至少一个空间纵深词汇，例如 "with foreground/background depth" 或 "foreshortening visible"。字数控制在 10 词以内。

## 构图方向选择规则
- "portrait"（竖图 832x1216）：仅限单人特写、半身肖像、头像，或以单个角色为主的 Solo 画面。
- "landscape"（横图 1216x832）：电影剧照、动作场景、大环境场景、战斗、远景或背景起强力烘托作用的画面。
- "square"（方图 1024x1024）：含有一到两个角色，且角色间有重要互动及部分背景 the 画面。
- "default"（默认 1024x1024）：其他常规情况。
如果场景里有两个或以上角色，优先选择 landscape 或 square。`;

const newNlCamera = `## 电影级镜头机位、光影与构图架构 (Composition & Cinematography Rules)

### 1. 景别与机位分流法则 (Framing by Scene Intent)
禁止一律使用单调大头贴近景。根据场景戏剧目的科学分流：
- **穿搭展示与立绘平衡 (日常/立绘/站姿)**: 优先使用 "cowboy shot" (美式七分身，大腿以上) 或 "medium shot" (腰部以上)。既能展示服装细节和体态曲线，又能保证面部五官精细不糊。
- **面部情绪与亲密特写 (情感/微表情/五官抗糊)**: "close-up", "portrait", "tight medium shot"。用于刻画眼角泪痕、咬唇、耳语或羞涩对视。当五官细节容易模糊时必用。
- **宏大叙事与场景烘托 (史诗/战场/废墟/大自然)**: "wide shot with grand scale", "cinematic wide angle"。必须明确主体相对位置（如 "a solitary girl in vast crumbling ruins"），防止人物被环境完全吞没。
- **动势张力与惊悚逃杀 (打斗/突袭/失控狂奔)**: "dutch angle tilted frame", "dynamic dramatic angle"。打破呆板水平线，注入强烈动势。
- **透视缩减 (向镜头冲刺/刺剑/扑杀)**: 肢体或道具朝向镜头时，必须加上 "dramatic foreshortening with deep perspective"，避免四肢畸变缩短。

### 2. 空间纵深与三层构图 (Foreground - Midground - Background)
绝不生成扁平纸片人构图，base_prompt 应尽量包含前后层次：
- **前景框架 (Foreground Framing)**: "framed by blurry tree branches in foreground"、"peeking through half-open doorway" 或 "framed by soft foreground bokeh"。
- **中景主体 (Midground)**: 角色当前的主要体态、受力点与互动接触。
- **背景虚化 (Background Depth)**: "with soft bokeh blur in background"、"diffused distant skyline"。

### 3. 光影结构与轮廓剥离 (Structural Lighting)
构图离不开主导光线走向，base_prompt 必须指定核心光源：
- **轮廓光 (Rim Light)**: 加入 "strong rim light outlining hair and shoulders" 或 "backlighting separating subjects from background"，这是将角色从暗景剥离并赋予 3D 体积感的神器。
- **电影氛围光源**:
  * 史诗/神秘: "dramatic chiaroscuro lighting, visible volumetric light beams slanting through air"
  * 温暖/日常: "golden hour twilight glow, warm sunlight filtering through trees creating dappled light"
  * 高反差/动感: "high contrast cinematic lighting, ambient glow"

### 4. 构图画幅方向规则
- "portrait"（竖图 832x1216）：单人立绘、全身/七分身肖像、竖直构图场景（如雨夜悬崖、垂直大殿、站立回眸）。
- "landscape"（横图 1216x832）：电影剧照、宏大远景、激烈打斗、双人并列交互或环境起强力烘托的画面。
- "square"（方图 1024x1024）：双人面对面亲密交互、近距离对峙等中景画面。
- "default"（默认 1024x1024）：其他常规情况。多人场景优先 landscape 或 square。

### 5. 防多视点切片 (Anti-Multiple-Views)
在 base_prompt 或 negative_prompt 中杜绝拼贴分镜：负面词加入 "-1.5::multiple views, split screen::"。`;

nlPrompt = nlPrompt.replace(oldNlCamera, newNlCamera);

// Write back to config
const cfgPath = 'illustrator_config.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

cfg.system_prompt_advanced_prompt = tagsPrompt;
cfg.system_prompt_advanced_prompt_nl = nlPrompt;

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
console.log('Successfully updated illustrator_config.json with enhanced composition system!');
