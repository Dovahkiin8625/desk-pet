/**
 * 人设名：整个程序凡是指代「它」的地方，都用这个。
 *
 * 默认叫「小桌」；用户在设置里改了人设名之后，
 * 界面与插件里凡是原先写死「桌宠 / 桌面宠物」的地方，
 * 读的都是改后的名字（主进程在这里存一份当前值，
 * 渲染层各自再用 src/renderer/ui/persona.js 维护一份）。
 */
import { DEFAULT_LLM } from './assistant.js';

/** 人设名缺省值（设置里没填时）。 */
export const DEFAULT_PERSONA_NAME = DEFAULT_LLM?.persona?.name || '小桌';

/** 当前生效的人设名（主进程内共享一份）。 */
let current = DEFAULT_PERSONA_NAME;

/** 从助理状态里取人设名；拿不到 / 全空就回退到默认。 */
export function personaName(state) {
  const raw = state?.llm?.persona?.name;
  const n = String(raw ?? '').trim();
  return n || DEFAULT_PERSONA_NAME;
}

/** 人设名变了时主进程调一下：同进程里的插件读到的就是新名字。 */
export function setCurrentPersonaName(name) {
  const n = String(name ?? '').trim();
  current = n || DEFAULT_PERSONA_NAME;
  return current;
}

/** 当前生效的人设名。 */
export function currentPersonaName() {
  return current;
}

/**
 * 界面文案里的「桌宠 / 桌面宠物」统一换成人设名。
 *
 * 也认 `{name}` 占位符（HTML 里写不出动态名字，用它代替）。
 */
export function personaText(text) {
  if (text == null) return '';
  return String(text)
    .replaceAll('{name}', current)
    .replaceAll('桌面宠物', current)
    .replaceAll('桌宠', current);
}
