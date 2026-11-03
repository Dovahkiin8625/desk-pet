/**
 * 常用音色建议表。
 *
 * 这里的每一个 id 都**用真实接口验过**（2026-10-31，MiniMax 当前平台
 * api.minimaxi.com，speech-02-hd）——不是从文档里抄的。
 * 验不过的 id 一律不放进来：给用户一个用不了的音色，
 * 比不给建议更糟。
 *
 * 但这张表**不是白名单**：设置里的音色是自由输入 + 建议列表，
 * 用户可以填任何合法的 voice_id（新音色随时会加进来）。
 */
export const SUGGESTED_VOICES = Object.freeze([
  { id: 'female-shaonv', label: '少女音色' },
  { id: 'female-yujie', label: '御姐音色' },
  { id: 'female-tianmei', label: '甜美女性音色' },
  { id: 'female-chengshu', label: '成熟女性音色' },
  { id: 'male-qn-qingse', label: '青涩青年音色' },
  { id: 'male-qn-jingying', label: '精英青年音色' },
  { id: 'male-qn-daxuesheng', label: '青年大学生音色' },
  { id: 'male-qn-badao', label: '霸道青年音色' },
  { id: 'presenter_female', label: '女性主持人' },
  { id: 'presenter_male', label: '男性主持人' },
  { id: 'Chinese (Mandarin)_Gentleman', label: '中文绅士' },
  { id: 'Chinese (Mandarin)_Sweet_Lady', label: '中文甜心' },
  { id: 'Chinese (Mandarin)_Warm_Girl', label: '中文暖心女孩' },
  { id: 'audiobook_male_1', label: '有声读物男声' },
  { id: 'audiobook_male_2', label: '有声读物男声（低沉）' },
  { id: 'audiobook_female_1', label: '有声读物女声' },
]);

/** 音色 id → 中文标签；找不到就回显 id 本身。 */
export function voiceLabel(voiceId) {
  const hit = SUGGESTED_VOICES.find((v) => v.id === voiceId);
  return hit ? hit.label : voiceId;
}
