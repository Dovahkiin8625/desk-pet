import { appendMessage, normalizeChatEntry } from './memory.js';

/**
 * 聊天记录的写入口。
 *
 * 「写一条记录」要做三件事：追加、按分类截断、**通知订阅者**
 * （插件的聊天记录界面要实时更新——写一条就推一条）。
 *
 * ## 为什么单独一个文件
 *
 * `assistant/index.js` 引了 electron，在普通 node 里测不了；
 * 而「写一条就通知一次」这条规矩必须有人守。
 * 所以整件事搬到这里：不碰 electron，测得了。
 */
export function createRecordSink({
  getMessages = () => [],
  setMessages = () => {},
  onEntry = () => {},
} = {}) {
  /**
   * 写一条记录。
   *
   * @returns {object} 规整后的那一条（订阅者拿到的就是它）
   */
  return function write(entry) {
    const normalized = normalizeChatEntry(entry);
    setMessages(appendMessage(getMessages(), normalized));
    onEntry(normalized);
    return normalized;
  };
}
