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

import {
  CHAT_KIND,
  chatKindOf,
  TASK_FINAL_STATUS,
  TASK_STATUS,
} from '../../../src/shared/assistant.js';

/** 到终态就算跑完了。 */
const FINAL_STATUS = new Set(TASK_FINAL_STATUS);

/** 这三种记录带着任务号，归后台那边。 */
const BACK_KINDS = new Set([CHAT_KIND.TASK, CHAT_KIND.STEP, CHAT_KIND.APPROVAL]);

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
  const firstDispatch = new Map();
  const entryBlocks = new Map();
  const petTurns = [];
  let current = null;

  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    const kind = chatKindOf(entry);
    const taskId = taskIdOf(entry);

    if (taskId && (BACK_KINDS.has(kind) || kind === CHAT_KIND.REPLY)) {
      cardOf(cards, entry, kind);
      continue;
    }

    if (kind === CHAT_KIND.USER) {
      current = newBlock(entry, 'user');
      blocks.push(current);
      entryBlocks.set(entry, current);
      continue;
    }
    if (kind === CHAT_KIND.REPLY && entry?.proactive) {
      current = newBlock(entry, 'pet');
      blocks.push(current);
      entryBlocks.set(entry, current);
      petTurns.push({ entry, index: i, block: current });
      continue;
    }
    if (!current) {
      current = newBlock(entry, 'pet');
      current.orphan = true;
      blocks.push(current);
    } else {
      current.entries.push(entry);
    }
    entryBlocks.set(entry, current);
    if (kind === CHAT_KIND.DISPATCH && taskId && !firstDispatch.has(taskId)) {
      firstDispatch.set(taskId, entry);
    }
  }

  // 主动搭话自己那一轮的过程记录挪到它那块；它之前那一轮没答上来的记录留着不动。
  for (const pet of petTurns) {
    for (const entry of petRoundEntries(list, pet.index, pet.entry)) {
      const from = entryBlocks.get(entry);
      if (!from || from.orphan || from === pet.block) continue;
      from.entries = from.entries.filter((e) => e !== entry);
      pet.block.entries.push(entry);
      entryBlocks.set(entry, pet.block);
    }
  }

  for (const [taskId, entry] of firstDispatch) {
    dispatchedIn.set(taskId, entryBlocks.get(entry));
  }

  for (const block of blocks) {
    block.entries.sort((a, b) => timeOf(a) - timeOf(b));
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

  const kept = blocks.filter((block) => block.entries.length || block.back.length);
  for (const block of kept) {
    block.front = frontLines(block);
    block.title = titleOf(block);
    block.badge = badgeOf(block);
    delete block.entries;
  }

  return groupByTime(kept, now);
}

/**
 * 主动搭话那一轮的过程记录。
 *
 * 从主动答复往前找那串连续的过程记录（遇到用户发话或另一条答复就停），
 * 再按答复带的轮数切出最后几轮——那是主动搭话自己跑的；
 * 更早的那些属于上一轮（那一轮可能还没答上来），留在原地。
 */
function petRoundEntries(list, index, reply) {
  const chain = [];
  for (let i = index - 1; i >= 0; i -= 1) {
    const entry = list[i];
    const kind = chatKindOf(entry);
    if (kind === CHAT_KIND.USER || kind === CHAT_KIND.REPLY) break;
    // 后台任务的记录不归前台；派单记录（dispatch）算前台的。
    if (taskIdOf(entry) && BACK_KINDS.has(kind)) continue;
    chain.push(entry);
  }
  const rounds = Number(reply?.meta?.rounds);
  if (!Number.isFinite(rounds) || rounds <= 0) return chain;
  let seen = 0;
  const out = [];
  for (const entry of chain) {
    out.push(entry);
    if (chatKindOf(entry) !== CHAT_KIND.MODEL) continue;
    seen += 1;
    if (seen >= rounds) break;
  }
  return out;
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
  if (kind === CHAT_KIND.TASK) {
    card.statuses.push(entry);
    if (!card.title) card.title = String(entry?.meta?.title || '');
  } else if (kind === CHAT_KIND.STEP) {
    card.steps.push(entry);
  } else if (kind === CHAT_KIND.APPROVAL) {
    card.approvals.push(entry);
  } else {
    card.result = entry;
  }
  return card;
}

/** 「桌宠这边」的一行行。 */
function frontLines(block) {
  const models = block.entries.filter((entry) => chatKindOf(entry) === CHAT_KIND.MODEL);
  const lines = [];
  for (const entry of block.entries) {
    const kind = chatKindOf(entry);
    if (kind === CHAT_KIND.USER) continue;
    if (kind === CHAT_KIND.MODEL) {
      lines.push({
        type: 'model',
        text: textOf(entry),
        index: Number(entry?.meta?.index) || 0,
        model: String(entry?.meta?.model || ''),
      });
      continue;
    }
    if (kind === CHAT_KIND.STEP) {
      lines.push({
        type: 'call',
        tool: String(entry?.meta?.tool || ''),
        args: entry?.meta?.args ?? null,
        result: entry?.meta?.result ?? '',
        error: String(entry?.meta?.error || ''),
      });
      continue;
    }
    if (kind === CHAT_KIND.TASK) {
      lines.push({
        type: 'task',
        taskId: taskIdOf(entry),
        status: String(entry?.meta?.status || ''),
        title: String(entry?.meta?.title || ''),
        text: textOf(entry),
      });
      continue;
    }
    if (kind === CHAT_KIND.APPROVAL) {
      lines.push({
        type: 'approval',
        taskId: taskIdOf(entry),
        tool: String(entry?.meta?.tool || ''),
        args: entry?.meta?.args ?? null,
        risk: String(entry?.meta?.risk || ''),
        decision: String(entry?.meta?.decision || ''),
        text: textOf(entry),
      });
      continue;
    }
    if (kind === CHAT_KIND.DISPATCH) {
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
    if (kind === CHAT_KIND.REPLY) {
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
    const user = block.entries.find((entry) => chatKindOf(entry) === CHAT_KIND.USER);
    if (user) return textOf(user);
  }
  if (block.opener === 'pet' && !block.orphan) {
    const reply = block.entries.find((entry) => chatKindOf(entry) === CHAT_KIND.REPLY);
    if (reply && textOf(reply)) return textOf(reply);
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
  const yesterday = previousDay(moment);
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
    group.turns.sort((a, b) => b.at - a.at);
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

/** 按日历日回退一天（不减 24 小时——夏令时那天会分错）。 */
function previousDay(at) {
  const date = new Date(at);
  return dayOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1).getTime());
}

function sameDay(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function pad(value) {
  return String(value).padStart(2, '0');
}
