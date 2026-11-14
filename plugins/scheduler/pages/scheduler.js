// plugins/scheduler/pages/scheduler.js
/**
 * 定时任务的面板（面板工作台与独立窗口里是同一份）。
 *
 * 页面只管三件事：
 *
 * - **画**：主进程给什么就画什么（首份、周期推来的、动作的回包）；
 * - **送动作**：新增、删除、开关、立刻跑，都交给主进程；
 * - **报高度**：面板里报一个定值（plugin.json 的 window.height），数据再多也不变。
 *
 * **表单是页面自己的**：主进程只管数据，填了一半的表单不能被推来的数据冲掉，
 * 所以列表与表单分开画——列表跟着数据走，表单只跟着用户走。
 */
import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { createDrawer } from '/src/renderer/ui/drawer.js';
import { hydrateIcons } from '/src/renderer/ui/icons.js';

const surface = bindSurface();

// 页面里的占位图标换成真的 SVG（图标只有一份，见 src/shared/icons.js）。
hydrateIcons();
document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));

const el = {
  list: document.getElementById('list'),
  info: document.getElementById('info'),
  gear: document.getElementById('gearBtn'),
  formTitle: document.getElementById('formTitle'),
  name: document.getElementById('fName'),
  type: document.getElementById('fType'),
  content: document.getElementById('fContent'),
  contentLabel: document.getElementById('fContentLabel'),
  sched: document.getElementById('fSched'),
  pInterval: document.getElementById('pInterval'),
  pDaily: document.getElementById('pDaily'),
  pCron: document.getElementById('pCron'),
  minutes: document.getElementById('fMinutes'),
  at: document.getElementById('fAt'),
  cron: document.getElementById('fCron'),
  save: document.getElementById('fSave'),
  cancel: document.getElementById('fCancel'),
};

/** 主进程给的任务清单。 */
let tasks = [];
/** 上一次的版本号：变了才重画列表。 */
let rev = -1;
/** 正在改哪一条（空 = 新建）。 */
let editingId = '';

/** 表单现在选的是什么。 */
let formType = 'command';
let formSched = 'interval';

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

/** 分段控件：按下去的那个高亮。 */
function pick(root, value) {
  for (const btn of root.querySelectorAll('button[data-v]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.v === value));
  }
}

/** 两种活，说的与填的不一样。 */
function updateTypeLabel() {
  const isCommand = formType === 'command';
  el.contentLabel.textContent = isCommand ? '命令' : '要做什么';
  el.content.placeholder = isCommand
    ? 'python D:\\scripts\\backup.py'
    : '把下载目录里一周没动过的文件挪到归档目录';
}

/** 定时方式换了，只显示该填的那几栏。 */
function updateSchedFields() {
  el.pInterval.hidden = formSched !== 'interval';
  el.pDaily.hidden = formSched !== 'daily';
  el.pCron.hidden = formSched !== 'cron';
}

el.type.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-v]');
  if (!btn) return;
  formType = btn.dataset.v;
  pick(el.type, formType);
  updateTypeLabel();
});

el.sched.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-v]');
  if (!btn) return;
  formSched = btn.dataset.v;
  pick(el.sched, formSched);
  updateSchedFields();
});

/** 把一条任务填进表单（改它的时候）。 */
function fillForm(task) {
  editingId = task.id;
  el.formTitle.textContent = `改「${task.name}」`;
  el.name.value = task.name;
  formType = task.type;
  pick(el.type, formType);
  updateTypeLabel();
  el.content.value = task.content || '';
  const schedule = task.schedule || {};
  formSched = schedule.kind || 'interval';
  pick(el.sched, formSched);
  updateSchedFields();
  if (schedule.kind === 'interval') el.minutes.value = String(schedule.everyMinutes);
  if (schedule.kind === 'daily') el.at.value = schedule.at;
  if (schedule.kind === 'cron') el.cron.value = schedule.expr;
  el.cancel.hidden = false;
  el.name.focus();
}

/** 回到「新建」的样子。 */
function resetForm() {
  editingId = '';
  el.formTitle.textContent = '新建定时任务';
  el.name.value = '';
  el.content.value = '';
  formType = 'command';
  pick(el.type, formType);
  updateTypeLabel();
  formSched = 'interval';
  pick(el.sched, formSched);
  updateSchedFields();
  el.minutes.value = '30';
  el.at.value = '09:00';
  el.cron.value = '';
  el.cancel.hidden = true;
}

/** 表单现在填的是什么。 */
function readForm() {
  const schedule = { kind: formSched };
  if (formSched === 'interval') schedule.everyMinutes = Number(el.minutes.value);
  else if (formSched === 'daily') schedule.at = el.at.value;
  else schedule.expr = el.cron.value;
  return {
    id: editingId,
    name: el.name.value,
    type: formType,
    content: el.content.value,
    schedule,
  };
}

el.save.addEventListener('click', async () => {
  const res = await send('save', readForm());
  if (res?.ok) resetForm();
});

el.cancel.addEventListener('click', () => resetForm());

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

/** 一个按钮。 */
function button(label, act, extra = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = extra ? `dp-button ${extra}` : 'dp-button';
  b.textContent = label;
  b.dataset.act = act;
  return b;
}

/** 那一条现在怎么样。 */
function resultText(task) {
  const bits = [];
  if (task.agentStatusText) {
    // 派单型的：现在是什么状态（agent 那边报什么就是什么）。
    bits.push(task.agentStatusText);
    if (task.agentResult) bits.push(task.agentResult);
  } else {
    if (task.lastStatusText) bits.push(`上次：${task.lastStatusText}`);
    if (task.lastResult) bits.push(task.lastResult);
  }
  return bits.join(' · ');
}

/** 一条任务。 */
function taskRow(task) {
  const row = document.createElement('div');
  row.className = task.enabled ? 'task' : 'task off';
  row.dataset.id = task.id;

  const head = document.createElement('div');
  head.className = 'head';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = task.name;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = task.type === 'command' ? '命令' : '派单';
  head.append(name, badge);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = task.enabled
    ? `${task.scheduleText} · 下次 ${task.nextText}`
    : `${task.scheduleText} · 已关掉`;

  const result = document.createElement('div');
  result.className = 'result';
  result.textContent = resultText(task);

  const acts = document.createElement('div');
  acts.className = 'acts';
  acts.append(
    button('立即运行', 'run'),
    button('编辑', 'edit'),
    button(task.enabled ? '停用' : '启用', 'toggle'),
    button('删除', 'remove', 'danger')
  );

  row.append(head, meta, result, acts);
  return row;
}

/** 画整个列表。 */
function renderList() {
  el.list.textContent = '';
  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有定时任务。上面填一条，存下就行。';
    el.list.append(empty);
  } else {
    for (const task of tasks) el.list.append(taskRow(task));
  }
  updateInfo();
}

/** 底下那行字：开着几条，下一次是什么时候。 */
function updateInfo() {
  const on = tasks.filter((t) => t.enabled && t.nextAt);
  if (!on.length) {
    el.info.textContent = tasks.length ? '没有开着的任务' : '还没有定时任务';
    return;
  }
  const soonest = on.reduce((a, b) => (a.nextAt <= b.nextAt ? a : b));
  el.info.textContent = `${on.length} 条开着 · 下一次 ${soonest.nextText}`;
}

el.list.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.task')?.dataset.id;
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  if (btn.dataset.act === 'edit') {
    fillForm(task);
    return;
  }
  if (btn.dataset.act === 'toggle') {
    void send('toggle', { id, enabled: !task.enabled });
    return;
  }
  if (btn.dataset.act === 'remove') {
    void send('remove', { id });
    return;
  }
  void send('run', { id });
});

// ---------------------------------------------------------------------------
// 设置（抽屉）
// ---------------------------------------------------------------------------

const drawer = createDrawer({ button: el.gear });

const notifyField = document.createElement('label');
notifyField.className = 'dp-field';
const notifyName = document.createElement('span');
notifyName.textContent = '跑完告诉我一声';
const notifyOnFinish = document.createElement('input');
notifyOnFinish.id = 'notifyOnFinish';
notifyOnFinish.type = 'checkbox';
notifyField.append(notifyName, notifyOnFinish);

const notifyHint = document.createElement('p');
notifyHint.className = 'dp-field-hint';
notifyHint.textContent = '命令跑完（或没跑成）时，桌宠在气泡里说一声。';

const timeoutField = document.createElement('label');
timeoutField.className = 'dp-field';
const timeoutName = document.createElement('span');
timeoutName.textContent = '命令最长跑多久（分钟）';
const timeoutMinutes = document.createElement('input');
timeoutMinutes.id = 'timeoutMinutes';
timeoutMinutes.type = 'number';
timeoutMinutes.min = '1';
timeoutMinutes.className = 'dp-input';
timeoutField.append(timeoutName, timeoutMinutes);

const timeoutHint = document.createElement('p');
timeoutHint.className = 'dp-field-hint';
timeoutHint.textContent = '超过这个时间就把命令停掉。';

drawer.body.append(notifyField, notifyHint, timeoutField, timeoutHint);

notifyOnFinish.addEventListener('change', () => {
  void send('setting', { key: 'notifyOnFinish', value: notifyOnFinish.checked });
});

timeoutMinutes.addEventListener('change', () => {
  void send('setting', { key: 'commandTimeoutMinutes', value: Number(timeoutMinutes.value) });
});

// ---------------------------------------------------------------------------
// 数据与动作
// ---------------------------------------------------------------------------

/** 送一个动作给主进程，把回来的数据画上去。 */
async function send(actionId, payload) {
  try {
    const next = await surface.act(actionId, payload);
    apply(next);
    if (next?.message) surface.setStatus(next.message);
    return next;
  } catch (err) {
    surface.setStatus(`做不了：${err?.message || err}`);
    return null;
  }
}

/** 主进程给的数据。 */
function apply(next) {
  if (!next) return;
  if (typeof next.rev === 'number' && next.rev !== rev) {
    rev = next.rev;
    tasks = Array.isArray(next.tasks) ? next.tasks : [];
    renderList();
  }
  if (next.settings) {
    // **正在改的那个不碰**：每两秒推一次数据，
    // 一路改也会把用户刚敲的字冲掉。
    const want = Boolean(next.settings.notifyOnFinish);
    if (notifyOnFinish.checked !== want && document.activeElement !== notifyOnFinish) {
      notifyOnFinish.checked = want;
    }
    const minutes = String(next.settings.commandTimeoutMinutes);
    if (timeoutMinutes.value !== minutes && document.activeElement !== timeoutMinutes) {
      timeoutMinutes.value = minutes;
    }
  }
}

surface.onData((data) => apply(data));
surface.onTick((data) => apply(data));
void surface.data().then((data) => apply(data));

// ---------------------------------------------------------------------------
// 高度
// ---------------------------------------------------------------------------

/** 面板里插件页面的固定高度（= plugin.json 的 window.height）。 */
const PANEL_HEIGHT = 620;
/** 面板里只报一次：任务条数再多高度也不再变。 */
let panelHeightReported = false;

/**
 * 报高度。
 *
 * 面板里报一个定值（plugin.json 的 window.height）：任务条数再多，
 * 窗口也不跟着变长，多出来的在页面里滚。
 */
function reportHeight() {
  if (surface.inPanel) {
    if (panelHeightReported) return;
    panelHeightReported = true;
    surface.setHeight(PANEL_HEIGHT);
    return;
  }
  requestAnimationFrame(() => {
    const rect = document.body.getBoundingClientRect();
    surface.setHeight(Math.ceil(Math.max(rect.height, document.body.scrollHeight)));
  });
}

if (!surface.inPanel && typeof ResizeObserver === 'function') {
  new ResizeObserver(() => reportHeight()).observe(document.body);
}
window.addEventListener('resize', reportHeight);
reportHeight();
