import { TOOL_RISK } from '../../../../shared/assistant.js';
import { safeConvo } from '../loop.js';
import { dispatchRecord } from '../record.js';

/**
 * 任务工具：交给后台继续做，以及管理已经在后台的事。
 *
 * ## 「交出去」交的是什么
 *
 * 交出去的是**当前这段对话**，不是模型重写的一段说明。
 *
 * 差别很大：用户说的原话、已经查到的结果、模型的理解，
 * 全都原样带过去。后台接着干就行，一个字都不用重写——
 * 重写就是有损，有损就会派歪，派歪了没人发现。
 *
 * 交出去的时候模型要写两样东西：
 * - **目标**（goal）：这件事到底是什么；
 * - **做完的标准**（done_when）：做到什么程度算做完。
 *
 * 标准是「准」的来源：没有它，「做完了」只是模型自己说了算。
 *
 * ## 全部免审批
 *
 * 它们全是 `risk: 'read'`：交出去、停下、补要求都不碰用户的东西。
 * 审批是给「写文件 / 跑命令」准备的，不是给「管理自己的任务」准备的。
 */

/** 目标最多几个字。 */
const GOAL_MAX_CHARS = 200;

/** 做完的标准最多几个字。 */
const CRITERIA_MAX_CHARS = 200;

/**
 * `reply` 参数：几个工具都有同一份说明。
 *
 * **为什么不带「派单」这类词**：模型会把参数说明当成自己说话的口径，
 * 说明里的话很容易被原样说给用户听。
 */
const REPLY_PARAM = Object.freeze({
  type: 'string',
  description:
    '要跟用户说的那一句话：一两句，口语。不要报告结果，不要提任何工具名。',
});

/**
 * 造这一轮的任务工具。
 *
 * @param {object} options
 * @param {object} options.tasks 任务中枢（提交 / 停止 / 归档 / 追加指令 / 列表）
 * @param {Function} options.getConvo 当前这段对话（交出去的就是它）
 * @param {string} [options.config] 大模型配置
 * @param {boolean} [options.canEscalate] 能不能交出去
 * @param {Function} [options.appendRecord] 写一条分类记录
 * @param {Function} [options.now] 取当前时刻
 */
export function createTaskTools({
  tasks = null,
  getConvo = () => [],
  config = {},
  canEscalate = true,
  appendRecord = () => {},
  now = () => Date.now(),
} = {}) {
  /**
   * 记一条记录：聊天历史页要显示这一回合的过程。
   *
   * **可见文字是宠物的说法**：工具名只留在 meta 里（审计用），
   * 「任务」这类内部词一个字都不许有——这段文字模型也会读，
   * 模型会照着说给用户听。
   */
  function record(tool, { taskId = '', taskTitle = '', action = '', brief = '' } = {}) {
    appendRecord(dispatchRecord({ tool, taskId, title: taskTitle, action, brief, at: now() }));
  }

  /**
   * 这件事叫什么：记录里要写给用户看。
   *
   * **为什么要在收起来之前查**：归档之后这件事就不在列表里了，
   * 那时再查只剩一个编号——编号是内部标识，用户看不懂。
   */
  function titleOf(taskId) {
    const list = tasks?.list?.() || [];
    const hit = list.find((t) => t?.taskId === taskId);
    return String(hit?.title || '').trim();
  }

  const tools = [
    {
      name: 'task.run',
      label: '把这件事交出去继续做',
      description:
        '这件事要跑很久（要跑很久、要试很多次、用户等不了）的时候用它。' +
        '它会带着你现在的对话继续做——用户说的原话、已经查到的东西都在里面。' +
        '把目标写清楚，把做完的标准写清楚；跟用户要说的话写在 reply 里。',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '这件事要做什么（200 字以内）' },
          done_when: { type: 'string', description: '做到什么程度算做完（200 字以内）' },
          reply: REPLY_PARAM,
        },
        required: ['goal'],
      },
      risk: TOOL_RISK.READ,
      /**
       * 这个工具**把活儿交出去了**。
       *
       * 后端靠它知道「这一轮已经交出去过了」——
       * 交出去了就不该再交一次（那是派两遍）。
       */
      handsOver: true,
      async run(args) {
        if (!canEscalate) throw new Error('现在不能把事交出去');
        const goal = String(args?.goal || '').trim();
        if (!goal) throw new Error('要交出去什么？给个 goal');
        if (goal.length > GOAL_MAX_CHARS) {
          throw new Error(`目标太长了（${goal.length} 字）：请写到 ${GOAL_MAX_CHARS} 字以内`);
        }
        const criteria = String(args?.done_when || '').trim();
        if (criteria.length > CRITERIA_MAX_CHARS) {
          throw new Error(
            `做完的标准太长了（${criteria.length} 字）：请写到 ${CRITERIA_MAX_CHARS} 字以内`
          );
        }
        const answer = String(args?.reply || '').trim();
        // **交出去的是能直接发出去的那份**：此刻对话正停在
        // 「assistant 说了要调工具、结果还没写回来」的半截上，
        // 那样发出去接口会直接 400。
        const convo = safeConvo(getConvo());
        // **这件事叫什么**：用模型写的目标，不用用户的原话。
        // 用户那句可能是「帮我弄一下那个」，看板上写「弄一下那个」
        // 谁也看不懂；目标是模型整理过的一句，看得懂。
        const name = shortTitle(goal);
        const task = tasks?.submit?.({
          prompt: goal,
          title: name,
          messages: convo,
          config,
          criteria,
        });
        if (!task?.ok) throw new Error('交不出去：运行时没有收下这件事');
        record('task.run', {
          taskId: task.taskId,
          taskTitle: name,
          action: `开始做：${name}`,
          brief: criteria ? `${goal}\n做完的标准：${criteria}` : goal,
        });
        return {
          text: '交出去了，做完会告诉你。',
          data: { taskId: task.taskId, queued: Boolean(task.queued), answer },
        };
      },
    },

    {
      name: 'task.cancel',
      label: '让一件事停下',
      description: '让一件正在做的事停下。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '那件事的编号' },
          reply: REPLY_PARAM,
        },
        required: ['taskId'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const answer = String(args?.reply || '').trim();
        const taskId = String(args?.taskId || '').trim();
        if (!taskId) throw new Error('要停哪一件？给个编号');
        const name = titleOf(taskId);
        const res = tasks.cancel(taskId);
        if (!res?.ok) throw new Error(res?.message || '停不下来');
        record('task.cancel', { taskId, taskTitle: name, action: `停掉了：${name || taskId}` });
        return { text: '停掉了。', data: { taskId, answer } };
      },
    },

    {
      name: 'task.steer',
      label: '给一件事补要求',
      description: '给一件正在做的事补一句要求（不改它原本要做什么）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '那件事的编号' },
          note: { type: 'string', description: '要追加的那句话' },
          reply: REPLY_PARAM,
        },
        required: ['taskId', 'note'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const answer = String(args?.reply || '').trim();
        const taskId = String(args?.taskId || '').trim();
        const note = String(args?.note || '').trim();
        if (!taskId) throw new Error('要给哪一件追加要求？给个编号');
        if (!note) throw new Error('要追加什么？给句话。');
        const name = titleOf(taskId);
        const res = tasks.steer(taskId, note);
        if (!res?.ok) throw new Error(res?.message || '追加不了');
        // 任务刚好结束：那句追加没送出去（**不是错误**，是时序问题）。
        // 但要**如实说**——说成「已追加」的话，模型会跟着跟用户说谎。
        const dropped = Boolean(res.dropped);
        record('task.steer', {
          taskId,
          taskTitle: name,
          action: dropped
            ? '那件事已经结束了，这句要求没送出去'
            : '给那件事补了一句要求',
        });
        return {
          text: dropped ? '那件事已经结束了，这句要求没送出去' : '要求送到了。',
          data: { taskId, note, answer },
        };
      },
    },

    {
      name: 'task.delete',
      label: '把一件事收起来',
      description: '把一件已经结束的事收起来（记录仍然留着）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '那件事的编号' },
          reply: REPLY_PARAM,
        },
        required: ['taskId'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const answer = String(args?.reply || '').trim();
        const taskId = String(args?.taskId || '').trim();
        if (!taskId) throw new Error('要收起来哪一件？给个编号');
        // **先查名字再收起来**：收起来之后这件事就不在列表里了。
        const name = titleOf(taskId);
        const res = tasks.archive(taskId);
        if (!res?.ok) throw new Error(res?.message || '收不起来');
        record('task.delete', { taskId, taskTitle: name, action: `收起来了：${name || taskId}` });
        return { text: '收起来了。', data: { taskId, answer } };
      },
    },
  ];

  // **不能交出去的时候**：连工具都不给。
  // 给了模型它就会去调，然后被拒——白白浪费一轮。
  return canEscalate ? tools : tools.filter((t) => t.name !== 'task.run');
}

/** 取一句话说明：太长了就截断。 */
function shortTitle(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}
