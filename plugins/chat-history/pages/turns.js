/**
 * 把一堆散着的聊天记录归成「一次发话」的块。
 *
 * ## 为什么要有这一步
 *
 * 记录是照着**发生了什么**写的：模型说了什么、调了什么快工具、派了哪个后台任务、
 * 任务到哪一步了。散着看是一堆噪音；按「用户发了一次话」合起来，
 * 才是「这件事干到哪了」。
 *
 * 一块里分两段：**桌宠这边**（前台这一回合的过程）与**后台那边**（派出去的任务）。
 * 后台任务晚完成时，结果要回到**派单它的那一块**——用户是按「我那句话说的事」
 * 找结果的，不是按完成那一刻。
 *
 * ## 纯函数
 *
 * 页面在渲染层跑，这里在普通 node 里跑——所以不碰 DOM，
 * 归属的规矩能直接被测。
 */

import { TASK_FINAL_STATUS, TASK_STATUS } from '../../../src/shared/assistant.js';

/** 到终态就算跑完了。 */
const FINAL_STATUS = new Set(TASK_FINAL_STATUS);

/** 这三种记录带着任务号，归后台那边。 */
const BACK_KINDS = new Set(['task', 'step', 'approval']);

/**
 * 把记录归成块，再按时间分组。
 *
 * @param {Array} entries 聊天记录（按时间先后）
 * @param {object} [options]
 * @param {number} [options.now] 「今天」的基准时刻（测试里传固定值）
 * @returns {Array} 分组
 */
export function buildTurns(entries, { now = Date.now() } = {}) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  list.sort((a, b) => timeOf(a) - timeOf(b));

  const blocks = [];
  const cards = new Map();
  const dispatchedIn = new Map();
  let current = null;

  for (const entry of list) {
    const kind = kindOf(entry);
    const taskId = taskIdOf(entry);

    if (taskId && (BACK_KINDS.has(kind) || kind === 'reply')) {
      cardOf(cards, entry, kind);
      continue;
    }

    if (kind === 'user') {
      current = newBlock(entry, 'user');
      blocks.push(current);
      continue;
    }
    if (kind === 'reply' && entry?.proactive) {
      current = newBlock(entry, 'pet');
      blocks.push(current);
      continue;
    }
    if (!current) {
      current = newBlock(entry, 'pet');
      current.orphan = true;
      blocks.push(current);
    } else {
      current.entries.push(entry);
    }
    if (kind === 'dispatch' && taskId && !dispatchedIn.has(taskId)) {
      dispatchedIn.set(taskId, current);
    }
  }

  for (const card of cards.values()) {
    const owner = dispatchedIn.get(card.taskId);
    if (owner) {
      owner.back.push(card);
      continue;
    }
    const block = newBlock(card.first, 'pet', []);
    block.title = card.title;
    block.back.push(card);
    blocks.push(block);
  }

  for (const block of blocks) {
    block.front = frontLines(block);
    block.title = titleOf(block);
    block.badge = badgeOf(block);
    delete block.entries;
  }

  return groupByTime(blocks, now);
}

/** 记录的分类。 */
function kindOf(entry) {
  return String(entry?.kind || '');
}

/** 记录带的任务号。 */
function taskIdOf(entry) {
  return String(entry?.meta?.taskId || '');
}

/** 记录的时刻。 */
function timeOf(entry) {
  const at = Number(entry?.at);
  return Number.isFinite(at) ? at : 0;
}

/** 记录的正文。 */
function textOf(entry) {
  return String(entry?.text || '');
}

/** 新开一块。 */
function newBlock(first, opener, entries) {
  return {
    id: `turn:${String(first?.id || '')}`,
    at: timeOf(first),
    opener,
    title: '',
    badge: 'failed',
    orphan: false,
    front: [],
    back: [],
    entries: entries || [first],
  };
}

/** 取（或建）某个任务号的任务卡。 */
function cardOf(cards, entry, kind) {
  const taskId = taskIdOf(entry);
  let card = cards.get(taskId);
  if (!card) {
    card = {
      taskId,
      title: '',
      statuses: [],
      steps: [],
      approvals: [],
      result: null,
      first: entry,
    };
    cards.set(taskId, card);
  }
  if (kind === 'task') {
    card.statuses.push(entry);
    if (!card.title) card.title = String(entry?.meta?.title || '');
  } else if (kind === 'step') {
    card.steps.push(entry);
  } else if (kind === 'approval') {
    card.approvals.push(entry);
  } else {
    card.result = entry;
  }
  return card;
}

/** 「桌宠这边」的一行行。 */
function frontLines(block) {
  const models = block.entries.filter((entry) => kindOf(entry) === 'model');
  const lines = [];
  for (const entry of block.entries) {
    const kind = kindOf(entry);
    if (kind === 'user') continue;
    if (kind === 'model') {
      lines.push({
        type: 'model',
        text: textOf(entry),
        index: Number(entry?.meta?.index) || 0,
        model: String(entry?.meta?.model || ''),
      });
      continue;
    }
    if (kind === 'step') {
      lines.push({
        type: 'call',
        tool: String(entry?.meta?.tool || ''),
        args: entry?.meta?.args ?? null,
        result: entry?.meta?.result ?? '',
        error: entry?.meta?.error ?? '',
      });
      continue;
    }
    if (kind === 'dispatch') {
      lines.push({
        type: 'dispatch',
        tool: String(entry?.meta?.tool || ''),
        action: String(entry?.meta?.action || ''),
        title: String(entry?.meta?.title || ''),
        brief: String(entry?.meta?.brief || ''),
        taskId: taskIdOf(entry),
      });
      continue;
    }
    if (kind === 'reply') {
      lines.push({
        type: 'reply',
        text: textOf(entry),
        rounds: roundsOf(entry, models),
        model: modelNameOf(entry, models),
      });
    }
  }
  return lines;
}

/** 答复带不走轮数时，用这块里模型说话的条数兜底。 */
function roundsOf(entry, models) {
  const rounds = Number(entry?.meta?.rounds);
  if (Number.isFinite(rounds) && rounds > 0) return rounds;
  return models.length;
}

/** 答复带不走模型名时，用最后一条模型记录的模型名兜底。 */
function modelNameOf(entry, models) {
  const name = String(entry?.meta?.model || '');
  if (name) return name;
  for (let i = models.length - 1; i >= 0; i -= 1) {
    const model = String(models[i]?.meta?.model || '');
    if (model) return model;
  }
  return '';
}

/** 块的标题。 */
function titleOf(block) {
  if (block.title) return block.title;
  if (block.opener === 'user') {
    const user = block.entries.find((entry) => kindOf(entry) === 'user');
    if (user) return textOf(user);
  }
  for (const entry of block.entries) {
    const text = textOf(entry);
    if (text) return text;
  }
  return '';
}

/** 块的徽标。 */
function badgeOf(block) {
  if (block.back.length) {
    let failed = false;
    for (const card of block.back) {
      const last = card.statuses[card.statuses.length - 1];
      const status = String(last?.meta?.status || '');
      if (!status) {
        if (!card.result) return 'running';
        continue;
      }
      if (!FINAL_STATUS.has(status)) return 'running';
      if (status === TASK_STATUS.FAILED) failed = true;
    }
    return failed ? 'failed' : 'done';
  }
  return block.front.some((line) => line.type === 'reply') ? 'answered' : 'failed';
}

/** 按时间分组：今天 / 昨天 / 更早按月。 */
function groupByTime(blocks, now) {
  const base = Number(now);
  const moment = Number.isFinite(base) ? base : Date.now();
  const today = dayOf(moment);
  const yesterday = dayOf(moment - 86400000);
  const groups = new Map();

  for (const block of blocks) {
    const day = dayOf(block.at);
    let key;
    if (sameDay(day, today)) {
      key = 'today';
    } else if (sameDay(day, yesterday)) {
      key = 'yesterday';
    } else {
      key = `${day.year}-${pad(day.month)}`;
    }
    if (!groups.has(key)) groups.set(key, { key, turns: [] });
    groups.get(key).turns.push(block);
  }

  const list = [...groups.values()];
  list.sort((a, b) => orderOf(a.key) - orderOf(b.key));
  for (const group of list) {
    if (group.key === 'today') {
      group.label = '今天';
      continue;
    }
    if (group.key === 'yesterday') {
      group.label = '昨天';
      continue;
    }
    const [year, month] = group.key.split('-').map(Number);
    group.label = year === today.year ? `${month}月` : `${year}年${month}月`;
  }
  for (const group of list) {
    group.turns.sort((a, b) => a.at - b.at);
  }
  return list;
}

/** 分组之间按新的在前排。 */
function orderOf(key) {
  if (key === 'today') return -Number.MAX_SAFE_INTEGER;
  if (key === 'yesterday') return -Number.MAX_SAFE_INTEGER + 1;
  return -Date.parse(`${key}-01T00:00:00`);
}

/** 时刻落在哪一天。 */
function dayOf(at) {
  const date = new Date(at);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function sameDay(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function pad(value) {
  return String(value).padStart(2, '0');
}
