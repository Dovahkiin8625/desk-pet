/**
 * 任务结果：结构化 + 送达模板。
 *
 * ## 为什么结果要结构化
 *
 * 「让模型写一句给用户听的话」这种做法有三个毛病：
 * - 失败时那句里常带着内部黑话（工具名、路径、堆栈）；
 * - 没法判断这个结果值不值得打扰用户；
 * - 没法把依据交给用户核对——「删掉了」没有说服力。
 *
 * 所以干活的那层交出的是**结果**（结论 + 事实 + 依据），
 * 送达路径用**模板**把它变成一句话。
 *
 * ## 模板化是为了什么
 *
 * 不是为了把话说得漂亮，是为了三件事：
 * - 内部黑话漏不出去；
 * - 成功与失败的句式一致，用户一眼分得清；
 * - 「这句话要不要弹出来」是个可以判断的事，不是一段散文。
 */

/** 结论最多留多少字（进气泡）。 */
const MAX_SUMMARY_CHARS = 120;

/** 失败原因最多留多少字。 */
const MAX_REASON_CHARS = 60;

/**
 * 造一个结果。
 *
 * @param {object} options
 * @param {boolean} [options.ok] 做成了吗
 * @param {string} [options.title] 这件事叫什么
 * @param {string} [options.summary] 一句话结论
 * @param {string} [options.reason] 失败原因（**用户读得懂**的那种）
 * @param {string[]} [options.facts] 查到的事实
 * @param {string[]} [options.evidence] 依据（路径、命令、命中行）
 * @param {string} [options.taskId] 任务号
 */
export function buildResult({
  ok = true,
  title = '',
  summary = '',
  reason = '',
  facts = [],
  evidence = [],
  taskId = '',
} = {}) {
  return {
    ok: Boolean(ok),
    title: String(title || '').trim(),
    // **失败的事没有结论**：留着一句「找到 3 个视频」配上「没能做完」，
    // 用户会以为结论是真的。
    summary: ok ? clip(summary, MAX_SUMMARY_CHARS) : '',
    reason: ok ? '' : clip(reason, MAX_REASON_CHARS),
    facts: toList(facts),
    evidence: toList(evidence),
    taskId: String(taskId || ''),
  };
}

/**
 * 送达用的那一句话。
 *
 * **失败也要送达**：用户需要知道这件事没做成，
 * 否则他会一直等着一个不会来的结果。
 *
 * @param {object} result
 * @returns {string}
 */
export function resultLine(result) {
  if (!result?.ok) return `没能做完：${result?.reason || '中间出了点问题'}`;
  return String(result?.summary || '').trim() || '做完了';
}

/**
 * 这个结果值不值得弹一个气泡。
 *
 * **不值得的情况**：做完了，但没什么可说的（「已完成」「好了」）。
 * 那就只写记录——桌宠自己知道就行，不必打扰用户。
 *
 * 失败一律值得：用户需要知道。
 *
 * @param {object} result
 * @returns {boolean}
 */
export function isNotable(result) {
  if (!result?.ok) return true;
  const text = String(result?.summary || '').trim();
  if (!text) return false;
  // 只有「做完了」这一类，没有新信息。
  return !/^(做完了|完成了|好了|搞定了|done)[。！!.\s]*$/i.test(text);
}

/**
 * 把一个错误变成**用户读得懂**的原因。
 *
 * 内部的东西一律不留：工具名、绝对路径、多行日志、堆栈。
 * 用户要的是「为什么没做成」，不是「哪一行崩了」。
 *
 * @param {Error|string} err
 * @returns {string} 空串表示没有可读的原因
 */
export function userReason(err) {
  // **空消息就是没有原因**：Error 的 message 为空时，
  // 退回到 String(err) 会得到 'Error'——那不是原因，是一句废话。
  const raw = String(err?.message ?? err ?? '').trim();
  if (!raw) return '';
  // 堆栈与多行日志：只留第一行。
  let text = raw.split('\n')[0];
  // 「工具「x」出错：」这种前缀：用户只关心后半句。
  text = text.replace(/^工具「[^」]*」出错[:：]\s*/, '');
  // 绝对路径：留个「那个文件」就够了，路径本身没有意义还占地方。
  text = text.replace(/[A-Za-z]:\\[^\s，。；、）)"]+/g, '那个文件');
  text = text.replace(/\/(?:[^\s，。；、）)"]+\/)+[^\s，。；、）)"]*/g, '那个位置');
  // 只留第一句。
  const at = text.search(/[。！？；]/);
  if (at > 0) text = text.slice(0, at);
  return clip(text.replace(/[。\s]+$/, ''), MAX_REASON_CHARS);
}

/** 截断。 */
function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 规整成一个字符串数组。 */
function toList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => String(v ?? '').trim()).filter(Boolean);
}
