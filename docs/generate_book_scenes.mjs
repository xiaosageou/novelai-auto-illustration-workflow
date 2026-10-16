import fs from 'fs';
import path from 'path';
import { ProxyAgent, setGlobalDispatcher } from '../server/node_modules/undici/index.js';
import { NovelAIClient } from '../server/services/nai-client.js';
import { globalCooldownManager } from '../server/utils/cooldown.js';

const config = JSON.parse(fs.readFileSync('illustrator_config.json', 'utf8'));

if (config.proxy_url) {
  setGlobalDispatcher(new ProxyAgent(config.proxy_url));
}

// 设定安全防抖间隔 (6秒)
globalCooldownManager.setBaseCooldownSeconds(6);

const client = new NovelAIClient({
  token: config.nai_token,
  baseUrl: config.nai_url || 'https://image.novelai.net'
});

const outDir = path.join(process.cwd(), 'docs', 'generated_scenes');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// 三大核心画师串配方
const RECIPES = {
  RECIPE_A: '0.6::mignon, artist:quasarcake, artist:houkisei, artist:kedama milk, 40hara::, piromizu, [ke-ta], [modare], year 2024, year 2025, fine fabric emphasis, clean lineart, soft shading',
  RECIPE_B: '-3::artist collaboration::, 1.2::misaka_12003-gou::, 0.8::dino_(dinoartforame), wanke, liduke::, 1.3::artist:raita::, artist:ningen_mame, artist:nixeu, dnd, fantasy, dramatic lighting, chiaroscuro, cinematic shadows',
  RECIPE_C: '1.05::artist:yoneyama mai::, 0.95::hyulla::, 0.85::momokumo::, 0.8::mx2j::, 0.8::freng::, 0.9::artist:blue gk::, chromatic aberration, light diffusion, vibrant colors, dynamic pose, year 2025, year 2026'
};

const NEGATIVE_PROMPT = 'nsfw, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, logo, too many watermarks, negative space, blank page';

// 精选各书最具代表性的 2 个场景
const TASKS = [
  // 1. 《琼明神女录》 (东方修仙 / 寒宫剑雪)
  {
    book: '琼明神女录',
    sceneName: '大雪纷飞寒宫殿前剑光漫天',
    fileName: '01_qiongming_snow_sword_recipeC.png',
    recipeKey: 'RECIPE_C',
    prompt: `1girl, solo, pei yuhan, white hanfu dress, red and white cloak, long flowing black hair, delicate pale skin, holding glowing dao sword, wielding sword, dancing with sword, black and white sword light slashing through air, heavy snow, snowflakes falling, ancient frozen palace background, winter, blizzard, cold atmosphere, dynamic angle, ${RECIPES.RECIPE_C}, masterpiece, best quality, ultra-detailed`
  },
  {
    book: '琼明神女录',
    sceneName: '幽暗古老石室素衣少年抚锈剑',
    fileName: '02_qiongming_stone_room_recipeB.png',
    recipeKey: 'RECIPE_B',
    prompt: `1boy, solo, ye linyuan, handsome, delicate features, pure white robe, sitting on ground in quiet dark stone chamber, looking down, touching a rusty old iron sword, dust motes in dim light beam, ancient stone wall, mysterious quiet atmosphere, close-up, ${RECIPES.RECIPE_B}, masterpiece, best quality, ultra-detailed`
  },

  // 2. 《神话生物攻略手册》 (西幻魔物 / 猫娘飞扑 & 祭坛古卷)
  {
    book: '神话生物攻略手册',
    sceneName: '破门飞扑而出的雪白女仆装猫娘',
    fileName: '03_shenhua_catgirl_pounce_recipeC.png',
    recipeKey: 'RECIPE_C',
    prompt: `1girl, solo, charlotte, cat girl, white cat ears, white fluffy tail, maid dress, white maid apron, ruffled collar, jumping forward towards camera, intense aggressive expression, bared fangs, claws out, leaping through broken wooden door, splintered wood particles, dynamic action pose, foreshortening, ${RECIPES.RECIPE_C}, masterpiece, best quality, ultra-detailed`
  },
  {
    book: '神话生物攻略手册',
    sceneName: '幽蓝符文黑色石质祭坛上的神秘古籍',
    fileName: '04_shenhua_altar_grimoire_recipeB.png',
    recipeKey: 'RECIPE_B',
    prompt: `no humans, ancient thick leather grimoire book, glowing blue magical runes on cover, resting on an obsidian stone altar, dark chamber, ancient mystical sanctuary, glowing magic particles, ethereal blue luminescence, dramatic chiaroscuro lighting, highly intricate details, ${RECIPES.RECIPE_B}, masterpiece, best quality, 8k wallpaper`
  },

  // 3. 《[迷男]_红楼遗秘_》 (古典中式宅院 / 闺阁晨曦)
  {
    book: '[迷男]_红楼遗秘_',
    sceneName: '秦可卿半跪雕花红木床沿娇羞掩襟',
    fileName: '05_honglou_qin_keqing_recipeA.png',
    recipeKey: 'RECIPE_A',
    prompt: `1girl, solo, qin keqing, voluptuous mature female, ancient chinese noblewoman, delicate beauty, flushed cheeks, bashful shy smile, wearing thin white silk undergarment, sheer chemise, cleavage, bare shoulders, kneeling on elaborate carved rosewood canopy bed, red silk sheets, soft morning sunlight, opulent bedchamber, ${RECIPES.RECIPE_A}, masterpiece, best quality, soft lighting`
  },
  {
    book: '[迷男]_红楼遗秘_',
    sceneName: '贾府深闺红木罗帐拉手对视',
    fileName: '06_honglou_bedchamber_couple_recipeC.png',
    recipeKey: 'RECIPE_C',
    prompt: `1girl, 1boy, couple, ancient chinese bedchamber, luxurious red silk canopy, carved wooden bed, boy sitting up gripping girl's slender delicate wrist, girl looking back with blushing bashful expression, intricate silk embroidery, candle light glow, intimate atmosphere, beautiful face, ${RECIPES.RECIPE_C}, masterpiece, best quality`
  },

  // 4. 《楠楠的暴露》 (现代都市日常 / 宿舍私密)
  {
    book: '楠楠的暴露',
    sceneName: '酒红丝绸睡袍轻系微羞开门',
    fileName: '07_nannan_silk_robe_door_recipeA.png',
    recipeKey: 'RECIPE_A',
    prompt: `1girl, solo, nannan, college student, beautiful young woman, wearing wine red silk bathrobe, loosely tied silk belt, slight cleavage, bare feet on floor, hand holding doorknob, shy hesitant expression, slight blush, college dormitory doorway, warm indoor lighting, medium shot, ${RECIPES.RECIPE_A}, masterpiece, best quality, fine fabric`
  },
  {
    book: '楠楠的暴露',
    sceneName: '半掩窗帘穿衣镜前侧身回眸',
    fileName: '08_nannan_mirror_reflection_recipeA.png',
    recipeKey: 'RECIPE_A',
    prompt: `1girl, solo, nannan, slender curvy body, side view, standing in front of full-length standing mirror, turning head, looking at her own reflection with curious playful smile, sheer silk slip dress, dormitory room, half-closed curtains, soft diffused afternoon sunlight, tender atmosphere, ${RECIPES.RECIPE_A}, masterpiece, best quality`
  },

  // 5. 《骑士的血脉》 (中世纪战争 / 火枪与雨夜城墙)
  {
    book: '骑士的血脉',
    sceneName: '细雨连绵灰蒙石砌城墙上披蓑衣军曹',
    fileName: '09_knight_wall_sergeant_recipeB.png',
    recipeKey: 'RECIPE_B',
    prompt: `1man, solo, gruff battle-hardened sergeant, rough facial hair, scarred face, wearing traditional straw raincoat, medieval infantry uniform, standing on ancient wet stone battlements, medieval fortress wall, wet muskets leaning against stone, smoky campfire in corner, drizzling rain, misty grey cloudy sky, atmospheric, gritty realism, ${RECIPES.RECIPE_B}, masterpiece, best quality`
  },
  {
    book: '骑士的血脉',
    sceneName: '顶楼昏暗办公室窄小天窗前凝望阴云',
    fileName: '10_knight_colonel_window_recipeB.png',
    recipeKey: 'RECIPE_B',
    prompt: `1man, solo, colonel marvin, middle-aged officer, dignified, military uniform with gold epaulets, back view, standing beside narrow attic dormer window, looking out at stormy overcast sky, dimly lit vintage military office, wooden desk with maps and medical vials, dramatic rim lighting, cinematic shadows, ${RECIPES.RECIPE_B}, masterpiece, best quality`
  },

  // 6. 《全班地铁求生》 (末日废土 / 车厢惊变)
  {
    book: '全班地铁求生',
    sceneName: '昏暗破败末班地铁车厢警惕持械少年',
    fileName: '11_subway_carriage_vigilant_recipeB.png',
    recipeKey: 'RECIPE_B',
    prompt: `1boy, solo, high school student, nervous determined expression, dirty school uniform, gripping a heavy metal steel pipe weapon with two hands, crouching in a dark abandoned subway train car, flickering fluorescent light overhead, smashed broken glass, ominous black fog outside train window, survival thriller atmosphere, dutch angle, ${RECIPES.RECIPE_B}, masterpiece, best quality`
  },
  {
    book: '全班地铁求生',
    sceneName: '废弃月台摇曳篝火旁的避难少女',
    fileName: '12_subway_platform_campfire_recipeC.png',
    recipeKey: 'RECIPE_C',
    prompt: `1girl, solo, high school girl, exhausted yet relieved, sitting on ground beside makeshift campfire on empty dark underground subway platform, hugging knees, warm orange firelight reflecting on face and clothes, cold dark shadows behind, floating fire embers, volumetric smoke, cinematic lighting, ${RECIPES.RECIPE_C}, masterpiece, best quality`
  },

  // 7. 《我的隐蔽做爱xp系统-角色图》 (现代校园 / 角色立绘)
  {
    book: '我的隐蔽做爱xp系统',
    sceneName: '娇小清纯妹妹小涵黑长直白嫩立绘',
    fileName: '13_xpsystem_xiaohan_portrait_recipeA.png',
    recipeKey: 'RECIPE_A',
    prompt: `1girl, solo, xiaohan, 18 years old, petite loli-like girl, height 142cm, waist-length straight black hair, blunt bangs, fair snow-white skin, large watery brown eyes, delicate cute face, gentle sweet smile, wearing oversized cozy knitted pastel sweater, bare thighs, cowboy shot, clean background, ${RECIPES.RECIPE_A}, masterpiece, best quality, highly aesthetic`
  },
  {
    book: '我的隐蔽做爱xp系统',
    sceneName: '甜美运动型安昕堂姐活力网球裙',
    fileName: '14_xpsystem_anxin_tennis_recipeA.png',
    recipeKey: 'RECIPE_A',
    prompt: `1girl, solo, anxin, 21 years old, beautiful athletic woman, slender waist, curvy hips, radiant energetic smile, high ponytail, wearing white sporty tennis polo shirt and pleated tennis skirt, holding tennis racket, sunny outdoor court, glistening sweat drops, bright vibrant sunlight, cowboy shot, ${RECIPES.RECIPE_A}, masterpiece, best quality`
  }
];

async function runAll() {
  console.log(`[Start] Processing ${TASKS.length} scene image generations across projects...`);

  for (let i = 0; i < TASKS.length; i++) {
    const t = TASKS[i];
    const targetFile = path.join(outDir, t.fileName);
    if (fs.existsSync(targetFile) && fs.statSync(targetFile).size > 10000) {
      console.log(`[${i+1}/${TASKS.length}] Skipping existing: ${t.fileName}`);
      continue;
    }

    console.log(`\n------------------------------------------------------------`);
    console.log(`[${i+1}/${TASKS.length}] Generating for 《${t.book}》: ${t.sceneName}`);
    console.log(`配方: ${t.recipeKey} -> 输出: ${t.fileName}`);
    console.log(`Prompt: ${t.prompt.slice(0, 120)}...`);

    const t0 = Date.now();
    try {
      const res = await client.generateImage(t.prompt, {
        model: config.nai_model || 'nai-diffusion-4-5-full',
        negativePrompt: NEGATIVE_PROMPT,
        width: 832,
        height: 1216,
        steps: 28,
        scale: 6.0,
        sampler: 'k_euler_ancestral',
        noiseSchedule: 'karras'
      });

      if (res && res.imageBytes) {
        fs.writeFileSync(targetFile, Buffer.from(res.imageBytes));
        const sizeKB = (fs.statSync(targetFile).size / 1024).toFixed(1);
        const cost = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[Success] Generated ${t.fileName} (${sizeKB} KB) in ${cost}s!`);
      } else {
        console.error(`[Error] No imageBytes returned for ${t.fileName}`);
      }
    } catch (e) {
      console.error(`[Failed] Error generating ${t.fileName}:`, e.message);
    }
  }

  console.log('\n[All Tasks Complete!]');
}

runAll();
