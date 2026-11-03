/**
 * 待办清单：纯函数状态机。
 *
 * 状态就是一个数组，每条待办形如
 * `{ id, text, done, createdAt }`。
 * 所有操作都返回**新数组**，不改原对象——这样单测能直接比较前后差异，
 * 也不会出现「加了一条之后旧数组也被改了」的幽灵 bug。
 */

let seq = 0;

/** 生成一个待办 id。时间戳保证跨会话不撞，随机段保证同一毫秒内也不撞。 */
export function makeTodoId(now = Date.now()) {
  seq += 1;
  return `t-${now}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 新建一条待办；文本为空时返回 null（不加空待办）。 */
export function createTodo(text, now = Date.now(), id = makeTodoId(now)) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  return { id, text: trimmed, done: false, createdAt: now };
}

/** 加一条待办。 */
export function addTodo(todos, text, now = Date.now()) {
  const todo = createTodo(text, now);
  if (!todo) return { todos, added: null };
  return { todos: [...todos, todo], added: todo };
}

/** 勾选/取消勾选。id 不存在时原样返回。 */
export function toggleTodo(todos, id) {
  return todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
}

/** 删一条。 */
export function removeTodo(todos, id) {
  return todos.filter((t) => t.id !== id);
}

/** 清掉已完成的。 */
export function clearDone(todos) {
  return todos.filter((t) => !t.done);
}

/** 还没做完的条数。 */
export function pendingCount(todos) {
  return todos.filter((t) => !t.done).length;
}
