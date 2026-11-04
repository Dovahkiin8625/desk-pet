/**
 * 常用音色建议表。
 *
 * **这张表只放女声**——桌宠的声音就该是好听的女性声音。
 * 男声、老大妈一类的都不在这里（清单外的 id 仍可以自己填，见下）。
 *
 * 这里的每一个 id 都**用真实接口验过**（2026-10-31 与 2026-11-04 两轮，
 * MiniMax 当前平台 api.minimaxi.com，speech-02-hd）——不是从文档里抄的。
 * 验不过的 id 一律不放进来：给用户一个用不了的音色，
 * 比不给建议更糟。
 *
 * 验的方法是 `node scripts/verify-voices.mjs`（见那个脚本的说明）：
 * 用真实的 key 真合成一遍，文档里有不等于你的账号能用——
 * 音色分大区，还有的只支持特定模型。
 *
 * 但这张表**不是白名单**：设置里的音色是自由输入 + 建议列表，
 * 用户可以填任何合法的 voice_id（新音色随时会加进来）。
 *
 * 顺序按「角色气质」分组的：下拉框里二十多条挨个看，
 * 混着排是找不到的。
 */
export const SUGGESTED_VOICES = Object.freeze([
  // ---- 女声：系统音色 ----
  { id: 'female-shaonv', label: '少女音色' },
  { id: 'female-yujie', label: '御姐音色' },
  { id: 'female-tianmei', label: '甜美女性音色' },
  { id: 'female-chengshu', label: '成熟女性音色' },

  // ---- 女声：甜心 / 少女 ----
  { id: 'lovely_girl', label: '萌萌女童' },
  { id: 'tianxin_xiaoling', label: '甜心小玲' },
  { id: 'qiaopi_mengmei', label: '俏皮萌妹' },
  { id: 'diadia_xuemei', label: '嗲嗲学妹' },
  { id: 'Chinese (Mandarin)_Sweet_Lady', label: '中文甜心' },
  { id: 'Chinese (Mandarin)_Warm_Girl', label: '中文暖心女孩' },
  { id: 'Chinese (Mandarin)_Crisp_Girl', label: '中文清脆少女' },
  { id: 'Chinese (Mandarin)_Soft_Girl', label: '中文柔和少女' },
  { id: 'Chinese (Mandarin)_Warm_Bestie', label: '中文温暖闺蜜' },

  // ---- 女声：御姐 / 成熟 ----
  { id: 'wumei_yujie', label: '妩媚御姐' },
  { id: 'Chinese (Mandarin)_Mature_Woman', label: '中文傲娇御姐' },
  { id: 'Arrogant_Miss', label: '嚣张小姐' },
  { id: 'presenter_female', label: '女性主持人' },
  { id: 'audiobook_female_1', label: '有声读物女声' },

  // ---- 女声：知性 / 职业 ----
  { id: 'danya_xuejie', label: '淡雅学姐' },
  { id: 'Chinese (Mandarin)_Gentle_Senior', label: '中文温柔学姐' },
  { id: 'Chinese (Mandarin)_Wise_Women', label: '中文阅历姐姐' },
  { id: 'Chinese (Mandarin)_News_Anchor', label: '中文新闻女声' },
  { id: 'Chinese (Mandarin)_HK_Flight_Attendant', label: '中文港普空姐' },
]);

/** 音色 id → 中文标签；找不到就回显 id 本身。 */
export function voiceLabel(voiceId) {
  const hit = SUGGESTED_VOICES.find((v) => v.id === voiceId);
  return hit ? hit.label : voiceId;
}
