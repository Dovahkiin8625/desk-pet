import { LLM_BASE_URLS } from '../../../shared/assistant.js';

/**
 * OpenAI 兼容协议的大模型客户端。
 *
 * 接口形态：
 *   POST {baseUrl}/chat/completions
 *   Authorization: Bearer <API_KEY>
 *   { model, messages, temperature, max_tokens, stream }
 *
 * 五个容易踩的坑：
 *
 * 1. **地址要自己拼**：OpenAI 兼容的 `base_url` 指向 `/v1`，
 *    客户端负责补 `/chat/completions`。填了完整地址就原样用。
 * 2. **流式是 SSE**：`data: {json}\n\n` 一帧一帧，`data: [DONE]` 结束。
 *    有的帧只带 `role` 不带 `content`，必须判空。
 * 3. **中文会跨块**：一个汉字 3 字节，网络分块边界可能切在中间。
 *    必须用带状态的 `TextDecoder`（`{stream:true}`），
 *    每个 chunk 单独 `toString()` 会得到 `��`。
 * 4. **错误分类**：401/403 鉴权、429 限流、400/404/422 请求本身不对、5xx 服务端。
 *    鉴权失败**要**换域名重试——MiniMax 的 key 是分区域的。
 * 5. **`max_tokens` 与 `max_completion_tokens` 不能同时发**，
 *    `stream_options` 同理（严格的服务端会报「未知字段」直接 400）。
 */

/** 接口的错误分类。 */
export const LLM_ERRORS = Object.freeze({
  /** 没配 key / 地址 / 模型。 */
  CONFIG: 'config',
  /** 鉴权失败（401/403）。 */
  AUTH: 'auth',
  /** 限流（429）。 */
  RATE_LIMIT: 'rate_limit',
  /** 请求本身不对（400/404/422）：换个地址也是一样的结果。 */
  BAD_REQUEST: 'bad_request',
  /** 服务端出错了（5xx）。 */
  SERVER: 'server',
  /** 连不上。 */
  NETWORK: 'network',
  /** 超时。 */
  TIMEOUT: 'timeout',
  /** 200 但返回的不是我们认得的协议。 */
  MALFORMED: 'malformed',
});

/**
 * 把工具描述符转成 OpenAI 兼容的 `tools` 字段。
 *
 * 我们自己的工具描述符是 `{name, label, description, parameters, risk, run}`，
 * 接口只认 `{name, description, parameters}`——`label`（给人看的）与
 * `risk`（审批用）**不能**发出去：有的服务端见到不认识的字段直接 400。
 */
export function toRequestTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  return list
    .filter((t) => t && typeof t.name === 'string' && t.name !== '')
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: String(t.description || ''),
        parameters:
          t.parameters && typeof t.parameters === 'object'
            ? t.parameters
            : { type: 'object', properties: {} },
      },
    }));
}

/**
 * 流式 `tool_calls` 的累积器。
 *
 * **这是整个 tools 支持里最容易做错的地方。**
 * `choices[].delta.tool_calls[]` 里的 `function.arguments` 是一段被网络切碎的
 * JSON 字符串，按 `index` 到达：
 *
 * - 每帧单独 parse 必然失败（JSON 是碎的）；
 * - 按**到达顺序**拼接而不看 index 也必然错位（并行调用会交错到达）。
 *
 * 所以：按 `index` 归堆，参数按到达顺序拼进同一堆，最后按 index 升序输出。
 *
 * （T0 的探针实测过：MiniMax 一次流式响应就把两个并行调用的参数切成了 3 块。）
 */
export function createToolCallAccumulator() {
  const byIndex = new Map();
  return {
    /** 收一帧的 `delta.tool_calls`。 */
    push(deltaCalls) {
      for (const call of Array.isArray(deltaCalls) ? deltaCalls : []) {
        const index = Number.isFinite(call?.index) ? call.index : 0;
        const current = byIndex.get(index) || {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (typeof call?.id === 'string' && call.id) current.id = call.id;
        if (typeof call?.type === 'string' && call.type) current.type = call.type;
        const name = call?.function?.name;
        if (typeof name === 'string' && name) {
          if (!current.function.name) {
            current.function.name = name;
          } else if (name !== current.function.name && !current.function.name.endsWith(name)) {
            // 名字也可能是碎的：只在不是重复、也不是已收到的后缀时才续上。
            current.function.name += name;
          }
        }
        const args = call?.function?.arguments;
        if (typeof args === 'string') current.function.arguments += args;
        byIndex.set(index, current);
      }
    },
    /** 按 index 升序返回完整的调用。 */
    calls() {
      return [...byIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => ({ ...call, function: { ...call.function } }));
    },
    get size() {
      return byIndex.size;
    },
  };
}

export class LlmError extends Error {
  constructor(message, { code = null, status = null, body = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
    // 接口的原文：用户要看得懂「模型没开通」这类错误。
    this.body = body;
  }
}

/** 把用户填的地址变成完整的请求地址。 */
export function buildUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  // 已经填了完整地址就别动它。
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** 组装请求体。 */
export function buildRequestBody({
  model,
  messages,
  temperature,
  maxTokens,
  maxTokensField = 'max_tokens',
  stream = false,
  tools = [],
} = {}) {
  // 只发一个 token 字段：两个都发的话有的服务端会直接 400。
  const field = maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';
  const body = {
    model: String(model || ''),
    messages: Array.isArray(messages) ? messages : [],
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    [field]: Number.isFinite(maxTokens) ? Math.round(maxTokens) : 800,
    stream: Boolean(stream),
  };
  // **空数组不发**：有的服务端见到 `tools: []` 直接 400。
  const requestTools = toRequestTools(tools);
  if (requestTools.length) body.tools = requestTools;
  return body;
}

/** HTTP 状态码 → 错误分类。 */
export function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return LLM_ERRORS.AUTH;
  if (status === 429) return LLM_ERRORS.RATE_LIMIT;
  if (status >= 500) return LLM_ERRORS.SERVER;
  return LLM_ERRORS.BAD_REQUEST;
}

/**
 * 把 SSE 缓冲切成若干帧。
 *
 * 帧之间用空行分隔（`\n\n` 或 `\r\n\r\n`）。
 * 注释帧（`: keep-alive`）与 `event:`/`id:` 行直接跳过——
 * 我们只关心 `data:`。
 *
 * @returns {{frames: string[], rest: string}} frames 是去掉 `data: ` 前缀后的内容
 */
export function splitSseFrames(buffer) {
  const parts = String(buffer || '').split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  const frames = [];
  for (const part of parts) {
    for (const line of part.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data:')) continue;
      frames.push(trimmed.slice(5).trim());
    }
  }
  return { frames, rest };
}

/**
 * 解析一帧 SSE，返回正文与 tool_calls 分片。
 *
 * 兼容三种形态：`delta.content`（流式）、`message.content`（非流式）、
 * `text`（老接口）。
 *
 * **不读 `reasoning_content`**：那是推理模型的心里的想法，
 * 而且可能夹着我们约定的元数据——显示出来既奇怪又可能泄底。
 */
export function parseFrame(frame) {
  const text = String(frame ?? '').trim();
  if (!text || text === '[DONE]') return { content: '', toolCalls: [] };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LlmError('接口返回的不是合法的 JSON', { code: LLM_ERRORS.MALFORMED });
  }
  if (data?.error) {
    const message = data.error?.message || '接口返回错误';
    throw new LlmError(message, { code: classifyErrorCode(data.error?.code ?? data.error?.type) });
  }
  const choice = data?.choices?.[0];
  if (!choice) return { content: '', toolCalls: [] };
  const content = choice.delta?.content ?? choice.message?.content ?? choice.text ?? '';
  const toolCalls = choice.delta?.tool_calls ?? choice.message?.tool_calls ?? [];
  return {
    content: typeof content === 'string' ? content : '',
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
  };
}

/** 从一帧里取出增量文本（只要正文的那部分）。 */
export function extractDelta(frame) {
  return parseFrame(frame).content;
}

/** 接口在 200 的 body 里报的错误码 → 错误分类。 */
export function classifyErrorCode(code) {
  const text = String(code || '').toLowerCase();
  if (text.includes('rate_limit') || text.includes('429')) return LLM_ERRORS.RATE_LIMIT;
  if (text.includes('auth') || text.includes('key') || text.includes('1004')) return LLM_ERRORS.AUTH;
  if (text.includes('model') || text.includes('1039')) return LLM_ERRORS.BAD_REQUEST;
  return LLM_ERRORS.SERVER;
}

/**
 * 把接口地址**脱敏**后再写进错误消息。
 *
 * 有人会把密钥写在地址里（Azure 风格的 `?api-key=…`、
 * 或者 `https://key@host` 这种 userinfo 形式）——
 * 那些东西不该跟着错误消息跑到气泡里、跑到终端里。
 */
export function redactUrl(url) {
  const text = String(url || '');
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '';
    }
    // 查询串里可能有密钥：整个丢掉，只留主机与路径。
    parsed.search = '';
    return parsed.toString();
  } catch {
    // 不是合法 URL：只把 `?` 之后的部分去掉。
    return text.split('?')[0];
  }
}

/** 从响应头里取值（兼容 Headers 对象与普通对象）。 */
function headerValue(res, name) {
  const headers = res?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const lower = name.toLowerCase();
  return String(headers[lower] ?? headers[name] ?? '');
}

/** 网络错误 → 错误分类。 */
function networkError(err) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return new LlmError(
    timedOut ? '请求超时' : `请求失败：${err?.message || err}`,
    { code: timedOut ? LLM_ERRORS.TIMEOUT : LLM_ERRORS.NETWORK }
  );
}

/**
 * 把响应体读成一串字节块。
 *
 * 有 `body` 就按流读（真的流式）；没有就整块读回来
 * （这样单测的桩可以简单一点）。
 */
async function* readChunks(res) {
  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  const text = await res.text();
  yield new TextEncoder().encode(text);
}

/**
 * 从一整段 JSON 里取正文与 tool_calls（非流式响应）。
 *
 * 返回 null 表示这根本不是合法 JSON。
 */
function parseCompletionBody(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? choice?.delta?.content ?? choice?.text ?? '';
  const toolCalls = choice?.message?.tool_calls ?? choice?.delta?.tool_calls ?? [];
  return {
    content: typeof content === 'string' ? content : '',
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
    raw: data,
  };
}

/**
 * 一次**非流式**调用。
 *
 * @returns {Promise<{text: string, raw: object, toolCalls: object[]}>}
 */
export async function chatCompletion(params, fetchImpl = fetch) {
  const { apiKey, baseUrl, model, messages, temperature, maxTokens, maxTokensField, tools } = params;
  if (!apiKey) throw new LlmError('没有配置 API Key', { code: LLM_ERRORS.CONFIG });
  const url = buildUrl(baseUrl);
  if (!url) throw new LlmError('没有配置接口地址', { code: LLM_ERRORS.CONFIG });
  if (!model) throw new LlmError('没有配置模型名', { code: LLM_ERRORS.CONFIG });

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(
        buildRequestBody({ model, messages, temperature, maxTokens, maxTokensField, stream: false, tools })
      ),
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    throw networkError(err);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LlmError(`接口返回 HTTP ${res.status}`, {
      code: classifyHttpStatus(res.status),
      status: res.status,
      body: String(body).slice(0, 500),
    });
  }

  const text = await res.text();
  const parsed = parseCompletionBody(text);
  if (!parsed) {
    throw new LlmError('接口没有返回内容', {
      code: LLM_ERRORS.MALFORMED,
      body: String(text).slice(0, 500),
    });
  }
  // **正文为空不一定是错**：模型可能只调工具、不说话。
  if (!parsed.content && !parsed.toolCalls.length) {
    throw new LlmError('接口没有返回内容', {
      code: LLM_ERRORS.MALFORMED,
      body: String(text).slice(0, 500),
    });
  }
  const accumulator = createToolCallAccumulator();
  accumulator.push(parsed.toolCalls);
  return { text: parsed.content, raw: parsed.raw, toolCalls: accumulator.calls() };
}

/**
 * 一次**流式**调用。`onDelta(delta)` 会被逐字调用。
 *
 * @returns {Promise<{text: string, toolCalls: object[]}>} 累积起来的完整正文与工具调用
 */
export async function chatCompletionStream(params, { fetchImpl = fetch, onDelta, signal } = {}) {
  const { apiKey, baseUrl, model, messages, temperature, maxTokens, maxTokensField, tools } = params;
  if (!apiKey) throw new LlmError('没有配置 API Key', { code: LLM_ERRORS.CONFIG });
  const url = buildUrl(baseUrl);
  if (!url) throw new LlmError('没有配置接口地址', { code: LLM_ERRORS.CONFIG });
  if (!model) throw new LlmError('没有配置模型名', { code: LLM_ERRORS.CONFIG });

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(
        buildRequestBody({ model, messages, temperature, maxTokens, maxTokensField, stream: true, tools })
      ),
      signal: signal || AbortSignal.timeout(120000),
    });
  } catch (err) {
    throw networkError(err);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LlmError(`接口返回 HTTP ${res.status}`, {
      code: classifyHttpStatus(res.status),
      status: res.status,
      body: String(body).slice(0, 500),
    });
  }

  // 有些服务端无视 stream:true，直接回一整段 JSON。
  // 与其报错，不如把它当成非流式处理——用户照样能看到回复。
  const contentType = headerValue(res, 'content-type');
  if (!contentType.includes('text/event-stream')) {
    const text = await res.text();
    const whole = parseCompletionBody(text);
    if (whole && (whole.content || whole.toolCalls.length)) {
      if (whole.content) onDelta?.(whole.content);
      const accumulator = createToolCallAccumulator();
      accumulator.push(whole.toolCalls);
      return { text: whole.content, toolCalls: accumulator.calls() };
    }
    throw new LlmError('接口返回的不是 SSE 也不是 JSON', {
      code: LLM_ERRORS.MALFORMED,
      body: String(text).slice(0, 500),
    });
  }

  // **带状态的解码器**：一个汉字 3 字节，分块边界可能切在中间。
  // 每个 chunk 单独 toString() 会得到乱码。
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let done = false;
  const toolAccumulator = createToolCallAccumulator();

  try {
    for await (const bytes of readChunks(res)) {
      buffer += decoder.decode(bytes, { stream: true });
      const { frames, rest } = splitSseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame === '[DONE]') {
          done = true;
          break;
        }
        const { content, toolCalls } = parseFrame(frame);
        if (toolCalls.length) toolAccumulator.push(toolCalls);
        if (content) {
          full += content;
          onDelta?.(content);
        }
      }
      if (done) break;
    }
  } catch (err) {
    // 流到一半断了：也要归类，不然地址探测会以为「还没吐过字」而重试——
    // 用户会看到重复的半句。
    if (err instanceof LlmError) throw err;
    throw new LlmError(`连接中断：${err?.message || err}`, { code: LLM_ERRORS.NETWORK });
  }

  if (!done) {
    // 冲掉解码器里的残留字节，并处理「最后一帧后面没有空行」的情况。
    buffer += decoder.decode();
    const { frames } = splitSseFrames(`${buffer}\n\n`);
    for (const frame of frames) {
      if (frame === '[DONE]') break;
      const { content, toolCalls } = parseFrame(frame);
      if (toolCalls.length) toolAccumulator.push(toolCalls);
      if (content) {
        full += content;
        onDelta?.(content);
      }
    }
  }

  return { text: full, toolCalls: toolAccumulator.calls() };
}

/**
 * 依次尝试多个地址，返回第一个能用的。
 *
 * 哪些错误值得换地址再试：
 * - **鉴权失败（401/403）**：key 是**分区域**的，
 *   大陆的 key 在国际域名上会失败——换个域名说不定就对了。
 * - **网络错误 / 限流 / 服务端错误**：这个地址现在不伺候我们，换一个。
 * - **请求本身不对（400/404/422）与格式错误**：换地址也是同样的结果，
 *   立刻失败，把错误原样报给用户。
 *
 * **流已经开始之后失败不重来**：用户已经看到半句了，重来会重复。
 */
export async function chatCompletionStreamWithProbe(
  params,
  { fetchImpl = fetch, baseUrls = LLM_BASE_URLS, onDelta } = {},
) {
  const tried = [];
  let emitted = 0;
  const list = (Array.isArray(baseUrls) ? baseUrls : []).filter(Boolean);
  for (const baseUrl of list) {
    try {
      const result = await chatCompletionStream({ ...params, baseUrl }, {
        fetchImpl,
        onDelta: (delta) => {
          emitted += 1;
          onDelta?.(delta);
        },
      });
      // 工具调用也算「已经开始吐东西」：只调工具的轮次正文是空的。
      if (result.toolCalls?.length) emitted += 1;
      return { ...result, baseUrl };
    } catch (err) {
      tried.push(`${redactUrl(baseUrl)}（${err?.message || err}）`);
      if (emitted > 0) throw err;
      if (
        err instanceof LlmError &&
        (err.code === LLM_ERRORS.BAD_REQUEST ||
          err.code === LLM_ERRORS.MALFORMED ||
          err.code === LLM_ERRORS.CONFIG)
      ) {
        throw err;
      }
    }
  }
  throw new LlmError(`没有可用的接口地址：${tried.join('；')}`, { code: LLM_ERRORS.NETWORK });
}

/**
 * 非流式的地址探测版。
 *
 * @returns {Promise<{text: string, baseUrl: string}>}
 */
export async function chatCompletionWithProbe(
  params,
  { fetchImpl = fetch, baseUrls = LLM_BASE_URLS } = {},
) {
  const tried = [];
  const list = (Array.isArray(baseUrls) ? baseUrls : []).filter(Boolean);
  for (const baseUrl of list) {
    try {
      const result = await chatCompletion({ ...params, baseUrl }, fetchImpl);
      return { ...result, baseUrl };
    } catch (err) {
      tried.push(`${redactUrl(baseUrl)}（${err?.message || err}）`);
      if (
        err instanceof LlmError &&
        (err.code === LLM_ERRORS.BAD_REQUEST ||
          err.code === LLM_ERRORS.MALFORMED ||
          err.code === LLM_ERRORS.CONFIG)
      ) {
        throw err;
      }
    }
  }
  throw new LlmError(`没有可用的接口地址：${tried.join('；')}`, { code: LLM_ERRORS.NETWORK });
}
