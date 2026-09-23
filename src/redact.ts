/**
 * 敏感信息脱敏（redaction）与文本净化（sanitize）。
 *
 * 记忆库是**长期明文存储**，其内容还会被注入 system prompt 与工具返回值，
 * 因此进入记忆库之前必须先剔除凭据、并在离开记忆库注入上下文之前净化文本。
 *
 * 两条防线：
 *
 * 1. {@link redact} / {@link redactMemory} —— 写入前：把高熵凭据与赋值式机密替换为占位符。
 * 2. {@link sanitizeForPrompt} —— 注入前：剥离控制字符/ANSI 序列，并中性化可与注入结构混淆的符号。
 *
 * @module dsh-memory-layer/redact
 */

import type { DistilledMemory, TechniqueDraft } from './types.js'

/** 占位符前缀，便于在记忆库中识别被脱敏的位置。 */
export const REDACTED_PREFIX = '[REDACTED'

/**
 * 凭据识别规则。
 *
 * 只保留「高置信度」模式：要么有厂商前缀、要么是高熵长串、要么是明确的赋值式机密，
 * 以免把普通技术文本误伤成 `[REDACTED]`。
 */
export const REDACTION_RULES: readonly { name: string; pattern: RegExp }[] = [
  { name: 'private-key', pattern: /-----BEGIN[^\n-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^\n-]{0,40}PRIVATE KEY-----/gu },
  { name: 'openai-key', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/gu },
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gu },
  { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu },
  { name: 'aws-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu },
  { name: 'google-key', pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/gu },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/gu },
  {
    name: 'named-secret',
    pattern: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?[^\s"',;]{6,}/giu,
  },
  { name: 'uri-credentials', pattern: /:\/\/[^\s:@/]+:[^\s:@/]{4,}@/gu },
] as const

/** 控制字符（C0 除 \t 之外、DEL、C1）。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu

/** ANSI CSI 序列（如 `\u001b[31m`）。 */
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu

/** ANSI OSC 序列（如 `\u001b]0;title\u0007`）。 */
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu

/** 其余 ESC 引导的短序列。 */
const ANSI_OTHER = /\u001b[@-Z\\-_]/gu

/**
 * 用于替换可与注入块结构混淆的列表标记。
 *
 * 必须换成**不含** `-` / `*` 的符号：用反斜杠转义（`\- [`）仍保留 `- [` 子串，
 * 无法阻止内容冒充注入块的层级标签。
 */
const BULLET_MARK = '•'

/**
 * 注入块用来标识层级的标签词表。
 *
 * 与 `index.ts` 的 `recallLabel()` 可能产出的标签保持一致（语义层按 `kind` 细分成
 * fact / preference / decision / constraint），另收 `long-term` / `episodic` 这类早期别名。
 * `redact.test.ts` 有一条用例遍历「层 × 类别」的全部组合来验证，因此词表漂移会被测试抓住。
 */
const INJECTION_LABEL_WORDS: readonly string[] = [
  'past session',
  'long-term fact',
  'long-term preference',
  'long-term decision',
  'long-term constraint',
  'long-term',
  'recurring failure',
  'technique',
  'episodic',
  'semantic',
  'transient',
  'failure',
]

/** 把一个字面量转成正则安全的形式。 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * 「列表标记 + 层级标签」的伪造形态，例如 `- [long-term]`。
 *
 * 刻意**只**匹配标签词表里的词，而不是任意 `- [X]`：真实世界里的 `- [X]` 大量是
 * 代码而非标签 —— PlantUML 的隐藏连线 `-[hidden]->`、组件连线 `DA - [First Component]`、
 * 任务清单 `- [x]` 都会被「见 `- [` 就改写」的宽规则改坏（实测存量技巧里有 18 个字段
 * 被改坏）。伪造面是**冒充本插件的层级标签**，所以按词表精确匹配即可，代价是
 * `- [system-prompt]` 这类自造标签不会被改写 —— 但它并不对应任何真实层级。
 */
const FORGED_LABEL_MARKER = new RegExp(
  `([-*+])(\\s*\\[\\s*(?:${INJECTION_LABEL_WORDS.map(escapeRegExp).join('|')})\\b)`,
  'giu',
)

/**
 * 把文本中的凭据替换为占位符。
 *
 * @param text - 任意文本。
 * @returns 脱敏后的文本；无命中时返回原字符串。
 */
export function redact(text: string): string {
  if (text.length === 0) return text
  let output = text
  for (const rule of REDACTION_RULES) {
    output = output.replace(rule.pattern, `${REDACTED_PREFIX}:${rule.name}]`)
  }
  return output
}

/**
 * 判断文本是否含被脱敏的痕迹。
 * @param text - 任意文本。
 * @returns 含占位符时为 `true`。
 */
export function isRedacted(text: string): boolean {
  return text.includes(REDACTED_PREFIX)
}

/**
 * 对一组字符串逐条脱敏。
 * @param items - 字符串数组。
 * @returns 脱敏后的数组（保持顺序与长度）。
 */
export function redactAll(items: readonly string[]): string[] {
  return items.map(item => redact(item))
}

/**
 * 对一条技巧草稿脱敏：正文、步骤、示例代码、调用面与标签。
 * @param draft - 技巧草稿。
 * @returns 脱敏后的新对象。
 */
export function redactTechnique(draft: TechniqueDraft): TechniqueDraft {
  return {
    ...draft,
    name: redact(draft.name),
    when: redact(draft.when),
    summary: redact(draft.summary),
    ...(draft.steps === undefined ? {} : { steps: redactAll(draft.steps) }),
    ...(draft.invariants === undefined ? {} : { invariants: redactAll(draft.invariants) }),
    ...(draft.api === undefined
      ? {}
      : {
        api: draft.api.map(surface => ({
          symbol: redact(surface.symbol),
          ...(surface.signature === undefined ? {} : { signature: redact(surface.signature) }),
          ...(surface.notes === undefined ? {} : { notes: redact(surface.notes) }),
        })),
      }),
    ...(draft.example === undefined
      ? {}
      : { example: { ...draft.example, code: redact(draft.example.code) } }),
    pitfalls: redactAll(draft.pitfalls),
    verify: redactAll(draft.verify),
    tags: redactAll(draft.tags),
    ...(draft.domain === undefined ? {} : { domain: redact(draft.domain) }),
  }
}

/**
 * 对整个提炼产物脱敏：标题、摘要、决定、待办、文件、事实、纠偏与技巧。
 * @param memory - 提炼结果。
 * @returns 脱敏后的新对象。
 */
export function redactMemory(memory: DistilledMemory): DistilledMemory {
  return {
    title: redact(memory.title),
    summary: redact(memory.summary),
    decisions: redactAll(memory.decisions),
    todos: redactAll(memory.todos),
    files: redactAll(memory.files),
    tags: redactAll(memory.tags),
    facts: memory.facts.map(fact => ({ kind: fact.kind, text: redact(fact.text) })),
    techniques: memory.techniques.map(redactTechnique),
    // 纠偏的三段文本都会进入全局失败层并被注入，必须与其它层同一道脱敏。
    corrections: memory.corrections.map(correction => ({
      trigger: redact(correction.trigger),
      wrong: redact(correction.wrong),
      correctApproach: redact(correction.correctApproach),
    })),
  }
}

/**
 * 文本净化：剥离 ANSI 转义与控制字符，并把**冒充注入块层级标签**的列表标记
 * 改写为中性符号 `•`（如 `- [long-term]` → `• [long-term]`），但**保留换行**。
 *
 * 只有标签词表（见 {@link INJECTION_LABEL_WORDS}）里的词会被改写，因此
 * `-[hidden]->`、`DA - [First Component]` 这类代码形态原样保留 —— 防注入变换
 * 一旦改写合法内容，记忆就会在读取路径上被悄悄改坏。
 *
 * 适合多行内容（如技巧的完整正文）——`sanitizeForPrompt` 会压平换行，
 * 那对单行注入行是对的，对结构化正文则会破坏排版。
 *
 * @param text - 任意文本。
 * @returns 可安全回显的文本。
 */
export function sanitizeForText(text: string): string {
  const stripped = text
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_OTHER, '')
    .replace(CONTROL_CHARS, '')
  return stripped.replace(FORGED_LABEL_MARKER, `${BULLET_MARK}$2`)
}

/**
 * 注入 system prompt 前的净化：
 *
 * 1. 剥离 ANSI 转义与控制字符 —— 记忆库是纯文本且常被 `cat`/日志/UI 回显，
 *    未剥离的转义序列可操纵终端并污染模型上下文。
 * 2. 把可与注入块结构混淆的列表标记（`- [x]` / `* [x]`）改写为中性符号 `•`，
 *    避免记忆正文冒充高可信层级标签。注意不能用反斜杠转义 —— 那仍保留原文子串。
 * 3. 压平换行，防止正文伪造块结构。
 *
 * @param text - 记忆正文。
 * @returns 可安全注入的文本。
 */
export function sanitizeForPrompt(text: string): string {
  return sanitizeForText(text).replace(/\s+/gu, ' ').trim()
}

/**
 * 注入 system prompt 前的净化 **+ 模板中和** —— 凡是要塞进 prompt section 的文本都走这里。
 *
 * DSH 会把每个 prompt section / context 的正文过一遍 `{{name}}` 变量插值
 * （`@deepseek-ai/dsh-system-prompt` 的 `interpolate()`）。记忆正文里只要出现字面的
 * `{{`，插值器就抛 `malformed prompt variable reference`（`{{name}}` 形式则抛
 * `unknown prompt variable`），**整个回合直接失败**。
 *
 * 更糟的是它会自我维持：那句错误文本本身会被会话捕获、提炼回情景层，于是摘要里也带上
 * `{{`，之后每一轮召回注入都再抛一次 —— 实测在 PlantUML Salt 的 `{{` 语法上触发过。
 *
 * 只中和 `{{`：插值扫描由 `{{` 触发，`}}` 单独出现无害，不动它可以让正文尽量保真。
 * 实现上必须按**整段连续花括号**处理（`\{{2,}` → 逐字空格隔开），不能写成
 * `replace(/\{\{/, '{ {')` —— 那样在 `{{{{` 上两次替换的交界处会重新拼出一个 `{{`。
 * 工具输出（`technique_get` / `memory_search`）不走这条路径，保持原文可复制。
 *
 * @param text - 记忆正文。
 * @returns 可安全注入的文本。
 */
export function sanitizeForInjection(text: string): string {
  return sanitizeForPrompt(text).replace(/\{{2,}/gu, run => run.split('').join(' '))
}
