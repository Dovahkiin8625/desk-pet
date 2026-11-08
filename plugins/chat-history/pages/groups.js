/**
 * 把聊天记录分成块（页面照着块画）。
 *
 * ## 为什么要分组
 *
 * 记录有六种，看的人不一样：
 * - `user` / `reply`：对话，一句一条；
 * - `dispatch`：前台派了一个后台任务；
 * - `task` / `step` / `approval`：**同一个任务**的过程——
 *   散着看是一堆噪音，合起来才是「这件事干到哪了」。
 *
 * ## 纯函数
 *
 * 页面在渲染层跑，这里在普通 node 里跑——所以不碰 DOM，
 * 分组的规矩能直接被测。
 */

/** 这三种记录按任务号归到一块。 */
const TASK_KINDS = new Set(['task', 'step', 'approval']);

/**
 * 把记录分成块。
 *
 * @param {Array} entries 聊天记录（按时间先后）
 * @returns {Array} 块
 */
export function groupEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const blocks = [];
  const taskBlocks = new Map();

  for (const entry of list) {
    const kind = String(entry?.kind || '');
    const taskId = String(entry?.meta?.taskId || '');

    if (TASK_KINDS.has(kind) && taskId) {
      let block = taskBlocks.get(taskId);
      if (!block) {
        block = {
          type: 'task',
          id: `task:${taskId}`,
          taskId,
          title: '',
          statuses: [],
          steps: [],
          approvals: [],
        };
        taskBlocks.set(taskId, block);
        blocks.push(block);
      }
      if (kind === 'task') {
        block.statuses.push(entry);
        if (!block.title) block.title = String(entry?.meta?.title || '');
      } else if (kind === 'step') {
        block.steps.push(entry);
      } else {
        block.approvals.push(entry);
      }
      continue;
    }

    if (kind === 'user' || kind === 'reply') {
      blocks.push({ type: 'chat', id: String(entry?.id || ''), entry });
      continue;
    }
    blocks.push({ type: kind || 'other', id: String(entry?.id || ''), entry });
  }

  return blocks;
}
