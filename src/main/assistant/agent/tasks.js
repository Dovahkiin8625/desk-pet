import { createAgentRuntime } from './runtime.js';
import { createApprovalGate } from './approval.js';
import { approvalRecord, stepRecord, taskRecord } from './record.js';
import { AGENT_EVENT, APPROVAL_DECISION, TASK_STATUS } from '../../../shared/assistant.js';

/** 终态：这些任务已经结束了，停不掉也不该停。 */
const FINAL_STATUS = new Set([
  TASK_STATUS.DONE,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.INTERRUPTED,
]);

/**
 * agent 任务的中枢。
 *
 * 把五样东西缝在一起：
 * - **运行时**（runtime.js）：队列、并发、取消；
 * - **闸门**（approval.js）：要不要用户点头；
 * - **后端**（chat/agent.js）：真正跑那个多步循环；
 * - **记录**（record.js）：任务、步骤、审批写进聊天记录；
 * - **通知**：任务做完了/失败了要告诉用户。
 *
 * ## 为什么它不引 electron
 *
 * 这一层是整条链路（提交 → 审批 → 执行 → 记录 → 通知）的枢纽，
 * 必须能在普通 node 里跑一遍——不然「审批拒绝了任务还能不能继续」
 * 这种最要紧的事只能靠手点。
 */

/**
 * 看板里每个任务最多留几步（详情页那条时间线）。
 *
 * 每秒推一份快照，步骤是唯一会长大的部分——留太多，界面会被压垮。
 */
const MAX_BOARD_STEPS = 20;

/** 一步的结果最多留多少字。 */
const MAX_STEP_RESULT_CHARS = 120;

/** 步骤参数最多留几个键、每个值最多留多少字。 */
const MAX_STEP_ARG_KEYS = 2;
const MAX_STEP_ARG_CHARS = 60;

/**
 * 造一个任务中枢。
 *
 * @param {object} options
 * @param {object} options.backend agent 后端（chat/agent.js 造出来的那个）
 * @param {Function} [options.ask] 问用户：({taskId, tool, args, risk}) → Promise<'allow'|'deny'|'always'|'cancel'>
 * @param {Function} [options.getMessages] 后台任务的对话上下文
 * @param {Function} [options.appendRecord] 写一条分类记录
 * @param {Function} [options.notify] 通知用户：({ title, text, ok, taskId })
 * @param {Function} [options.onEvent] 事件转发（给插件）
 * @param {Function} [options.getMaxConcurrent] 同时跑几个任务
 * @param {Function} [options.getPolicy] 审批策略
 * @param {Function} [options.getAllowAlways] 永久放行的工具名
 */
export function createAgentTasks({
  backend = null,
  ask = null,
  getMessages = null,
  appendRecord = () => {},
  notify = () => {},
  onEvent = () => {},
  getMaxConcurrent = () => 1,
  getPolicy = () => 'graded',
  getAllowAlways = () => [],
  logger = console,
  now = () => Date.now(),
} = {}) {
  /** 把一个事件转成记录。 */
  function recordFor(event) {
    if (event.type === AGENT_EVENT.STEP) {
      return stepRecord({
        taskId: event.taskId,
        index: event.index,
        tool: event.tool,
        args: event.args,
        result: event.result,
        error: event.error,
        label: event.label,
        at: event.at,
      });
    }
    if (event.type === AGENT_EVENT.APPROVAL) {
      return approvalRecord({
        taskId: event.taskId,
        tool: event.tool,
        args: event.args,
        risk: event.risk,
        decision: event.decision,
        at: event.at,
      });
    }
    if (event.type === AGENT_EVENT.TASK) {
      return taskRecord({
        taskId: event.taskId,
        status: event.status,
        title: event.title,
        at: event.at,
      });
    }
    return null;
  }

  /** 每个任务最近一步的摘要（给「看看任务」用）。 */
  const lastSteps = new Map();
  /**
   * 每个任务的步骤清单（给任务看板的详情页用）。
   *
   * 只留最近的几步：老步骤没人看，留着白占内存。
   */
  const stepLogs = new Map();

  /** 记一步。 */
  function recordStep(taskId, step) {
    const list = stepLogs.get(taskId) || [];
    list.push(step);
    if (list.length > MAX_BOARD_STEPS) list.splice(0, list.length - MAX_BOARD_STEPS);
    stepLogs.set(taskId, list);
  }

  /** 事件往外走一份、往记录里落一份。 */
  function publish(event) {
    // **记最近一步**：给人看的列表要能说出「它到哪一步了」。
    // 记在事件往外走之前：订阅者拿到的事件与这里记的是同一份。
    if (event?.type === AGENT_EVENT.STEP) {
      const name = String(event.tool || '工具');
      lastSteps.set(event.taskId, {
        tool: name,
        label: String(event.label || ''),
        index: Number(event.index) || 0,
        failed: Boolean(event.error),
      });
      // **记下这一步**：详情页那条竖向时间线从这里来。
      recordStep(event.taskId, {
        index: Number(event.index) || 0,
        tool: name,
        args: clipArgs(event.args),
        result: event.error ? '' : clipText(event.result, MAX_STEP_RESULT_CHARS),
        error: String(event.error || ''),
        label: String(event.label || ''),
        at: Number(event.at) || 0,
      });
    }
    try {
      onEvent?.(event);
    } catch (err) {
      logger?.warn?.('[desk-pet] agent 事件的订阅者出错：', err?.message);
    }
    const entry = recordFor(event);
    if (entry) {
      try {
        appendRecord(entry);
      } catch (err) {
        logger?.warn?.('[desk-pet] agent 记录写不进去：', err?.message);
      }
    }
  }

  const runtime = createAgentRuntime({
    getMaxConcurrent,
    onEvent: publish,
    logger,
    now,
  });

  /** 一个任务的简报（给模型看的那份）。 */
  function brief(task) {
    const step = lastSteps.get(task.id);
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      lastStep: step ? (step.failed ? `${step.tool} 出错` : step.tool) : '',
      // **人话标签**：提示词里不许出现工具名；失败的这一步不算（没做成的事不能说成做成了）。
      lastStepLabel: step && !step.failed ? String(step.label || '') : '',
      stepIndex: step?.index || 0,
      result: task.result?.text ? String(task.result.text).slice(0, 200) : '',
      error: task.error ? String(task.error?.message || task.error) : '',
      elapsedMs: (task.finishedAt || now()) - task.createdAt,
    };
  }

  return {
    /** 运行时（插件与设置界面要看任务列表时用）。 */
    runtime,

    /**
     * 提交一个任务。
     *
     * @param {object} job
     * @param {string} job.prompt 任务的内容
     * @param {string} [job.title] 一句话说明
     * @param {Array} [job.messages] 对话上下文（不给就用 getMessages 造）
     * @param {object} [job.config] 大模型配置
     * @param {Function} [job.onDelta] 流式增量
     * @returns {{ok: boolean, taskId: string, done: Promise<object>}}
     */
    submit({
      prompt = '',
      title = '',
      messages = null,
      config = {},
      onDelta = null,
    } = {}) {
      const text = String(prompt || '');
      const job = runtime.submit({
        title: title || shortTitle(text),
        prompt: text,
        run: async (scope) => {
          // 闸门是**每个任务一个**：「自动」是任务级的。
          //
          // **没有问用户的渠道就不给闸门**：闸门的作用是去问用户，
          // 没有渠道时它只会一律拒绝——而后端自己也有兜底
          // （写与执行类工具不执行）。少一层，少一处说不清的拒绝理由。
          const gate =
            typeof ask === 'function'
              ? createApprovalGate({
                  getPolicy,
                  getAllowAlways,
                  ask,
                  hooks: scope.hooks,
                  taskId: scope.taskId,
                  // 请求一发出就留一笔「等你点头」：
                  // 任务卡在审批上时，记录里要看得见它还卡着（规格 §15）。
                  onRequest: (info) =>
                    publish({
                      type: AGENT_EVENT.APPROVAL,
                      taskId: scope.taskId,
                      at: now(),
                      ...info,
                      decision: APPROVAL_DECISION.PENDING,
                    }),
                  onDecision: (decision) =>
                    publish({
                      type: AGENT_EVENT.APPROVAL,
                      taskId: scope.taskId,
                      at: now(),
                      ...decision,
                    }),
                  // 用户在审批气泡上点「取消」：真的把任务停掉。
                  cancelTask: () => runtime.cancel(scope.taskId),
                })
              : null;
          const convo = Array.isArray(messages)
            ? messages
            : typeof getMessages === 'function'
              ? getMessages(text)
              : [{ role: 'user', content: text }];
          return backend.chat({
            messages: convo,
            config,
            onDelta,
            onEvent: (event) => publish({ ...event, taskId: scope.taskId, at: now() }),
            gate,
            signal: scope.signal,
            // 任务号：工具（外部 harness）要靠它写日志。
            taskId: scope.taskId,
            // 追加的要求：执行层在步骤边界取走。
            // scope.steer 取走即清空（见 runtime.js）。
            steer: scope.steer,
            trigger: 'user',
          });
        },
      });

      // `done` 兑现的是**后端的返回**（与 backend.chat 一样）。
      //
      // **谁在读它**：下面那个失败处理分支（`void done.then(…)`）——
      // 它靠 `done` 抛出的东西分辨「失败」与「被取消」。
      // 前台不再消费它（前台走的是交互层，不走 `tasks.submit`）。
      const done = job.done.then((outcome) => {
        if (outcome.ok) return outcome.result;
        const cancelled = outcome.status === TASK_STATUS.CANCELLED;
        // **取消不是失败**：单独标出来，通知时别当成「没做成」。
        //
        // **不写进原错误对象**：后端抛出来的可能是字符串或数字（不是对象），
        // 给原始值挂属性在严格模式下会抛 TypeError，把真实原因弄丢；
        // 而且那是 runtime 还持有的同一个对象，标记会漏进记录里。
        const raw = outcome.error;
        const error = new Error(raw?.message || String(raw || '这件事没做成'));
        if (raw) error.cause = raw;
        error.cancelled = cancelled;
        throw error;
      });

      // 后台任务做完了要告诉用户。
      //
      // **两边的处理器都挂上**：不然没人接的失败会变成「未处理的拒绝」。
      void done.then(
        (result) => {
          notify({
            title: job.title,
            text: result?.text || '这件事做完了',
            ok: true,
            // **带上任务号**：页面要靠它把结果归回发起它的那一块。
            taskId: job.taskId,
            // **情绪与记忆也带回去**：后台任务学到的东西，
            // 桌宠自己得知道（规格 §5.1）。
            emotion: String(result?.emotion || ''),
            mood: Number(result?.mood) || 0,
            memories: Array.isArray(result?.memories) ? result.memories : [],
          });
        },
        (err) => {
          // 取消是用户自己要求的：他知道结果，不用再补一句「没做成」。
          if (err?.cancelled) return;
          notify({
            title: job.title,
            text: `这件事没做成：${err?.message || err}`,
            ok: false,
            // 失败同样要带任务号：失败的块也得归回原来那一块。
            taskId: job.taskId,
            // 失败没有情绪也没有记忆——那是 agent 没交卷，不是它不想说。
            emotion: '',
            mood: 0,
            memories: [],
          });
        }
      );

      return {
        ok: job.ok,
        taskId: job.taskId,
        position: job.position,
        // 排队中吗：排队了要告诉用户「排第 N 位」（规格 §7.2）。
        queued: job.queued,
        done,
      };
    },

    /** 取消一个任务。 */
    cancel(taskId) {
      return runtime.cancel(taskId);
    },

    /**
     * 把所有**没做完**的任务停掉。
     *
     * 切到「只聊天」时用：桌宠不再接新活，手上正在做的事也得停下来。
     * **已经结束的任务不动**——它们的结果还在记录里，停不掉也没必要停。
     *
     * @returns {{stopped: number}} 停掉几个
     */
    cancelAll() {
      let stopped = 0;
      for (const task of runtime.list()) {
        if (FINAL_STATUS.has(task.status)) continue;
        const res = runtime.cancel(task.id);
        if (res?.ok) stopped += 1;
      }
      return { stopped };
    },

    /**
     * 任务列表：**给模型看的精简视图**。
     *
     * 不给内部字段（run / scope / controller）——
     * 它们是实现细节，露出去只会被误用。
     *
     * **不带步骤**：模型要的是「到哪一步了」，
     * 整条时间线只会撑爆它的上下文（要细节的是界面，见 `board()`）。
     */
    list() {
      return runtime.list().map(brief);
    },

    /**
     * 任务看板的视图：**给人看的完整版**。
     *
     * 比 `list()` 多三样：创建时刻、完整结果、步骤时间线——
     * 那是任务板详情页要的。
     */
    board() {
      return runtime.list().map((task) => ({
        ...brief(task),
        // 详情页要看到整句话，不是前 200 字。
        result: task.result?.text ? String(task.result.text) : '',
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        steps: stepLogs.get(task.id) || [],
      }));
    },

    /**
     * 在跑的和排队的各有几个。
     *
     * **归档的不算**：归档就是「从列表里收起来」，
     * 它不该继续占着提示词里的「正在跑 N 个」（规格 §6.2）。
     */
    counts() {
      let running = 0;
      let queued = 0;
      for (const task of runtime.list()) {
        if (task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.WAITING_APPROVAL) {
          running += 1;
        } else if (task.status === TASK_STATUS.QUEUED) {
          queued += 1;
        }
      }
      return { running, queued };
    },

    /** 给正在跑的任务追加一句要求。 */
    steer(taskId, note) {
      return runtime.steer(taskId, note);
    },

    /** 归档一个已结束的任务。 */
    archive(taskId) {
      const r = runtime.archive(taskId);
      // 归档了就不再有人看它：这个任务的步骤清单也别留着。
      if (r?.ok) {
        stepLogs.delete(taskId);
        lastSteps.delete(taskId);
      }
      return r;
    },
  };
}

/** 取一句话说明：太长了就截断。 */
function shortTitle(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

/** 一段文字截到多少字。 */
function clipText(text, limit) {
  const s = String(text ?? '');
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/**
 * 步骤参数：只留几个键、每个值截一段。
 *
 * 参数可能是整个文件的内容（fs.write）——原样留着，
 * 每秒推一份快照就能把界面压垮。
 */
function clipArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const out = {};
  let n = 0;
  for (const [key, value] of Object.entries(args)) {
    if (n >= MAX_STEP_ARG_KEYS) break;
    if (value === undefined || value === null || value === '') continue;
    const text = typeof value === 'string' ? value : safeJson(value);
    if (!text) continue;
    out[key] = clipText(text, MAX_STEP_ARG_CHARS);
    n += 1;
  }
  return Object.keys(out).length ? out : null;
}

/** JSON.stringify 不炸的那一版。 */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
