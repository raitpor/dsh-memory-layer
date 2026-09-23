/**
 * 提炼层：把一次会话的要点压成情景摘要与语义事实。
 *
 * 两条路径：
 *
 * 1. {@link distillWithModel} —— 由模型提炼（首选）。调用方注入 {@link LlmTextCaller}，
 *    本模块不直接依赖 `ctx.llm`，因此可单独测试。
 * 2. {@link distillWithRules} —— 无模型可用（或模型调用失败/超时）时的本地规则回退，
 *    保证「记忆」这一功能在任何 profile 下都不会静默失效。
 *
 * 两条路径产出同一个 {@link DistilledMemory} 形状，调用方无需分支。
 *
 * @module dsh-memory-layer/distill
 */

import { HOST_CONTEXT_MARKERS, INJECTION_BLOCKS } from './injection.js'
import { redactMemory } from './redact.js'
import { MAX_SUMMARY_CHARS } from './store.js'
import type {
  ApiSurface,
  CorrectionDraft,
  DistilledMemory,
  ExtractionSource,
  LiveTurn,
  SemanticDraft,
  SemanticKind,
  Sensitivity,
  StackProfile,
  TechniqueDraft,
  TechniqueExample,
  TechniqueKind,
} from './types.js'

/** 一次提炼的输入：会话工作目录、当前技术栈与已捕获的轮次要点。 */
export interface Transcript {
  /** 会话工作目录，仅在需要判断项目归属时使用。 */
  cwd?: string
  /** 当前项目的技术栈画像，作为提炼出的技巧的适用栈。 */
  stack?: StackProfile
  /** 已捕获的轮次要点。 */
  turns: readonly LiveTurn[]
}

/** 模型调用抽象：给定系统提示与用户提示，返回模型文本输出。 */
export type LlmTextCaller = (system: string, user: string) => Promise<string>

/** 提炼结果与来源的合并产物。 */
export interface DistillResult {
  /** 三层沉淀中的情景摘要与语义草稿。 */
  memory: DistilledMemory
  /** 实际生效的提炼路径。 */
  source: ExtractionSource
  /** 模型路径失败时的原因，便于诊断；规则路径为 undefined。 */
  fallbackReason?: string
}

/** 提炼提示：要求模型只返回一个 JSON 对象。 */
export const DISTILL_SYSTEM_PROMPT = [
  'You distill one AI coding-assistant session into long-term memory.',
  'Return ONE JSON object and nothing else, using this exact shape:',
  '{"title":string,"summary":string,"decisions":string[],"todos":string[],"files":string[],"tags":string[],"facts":[{"kind":"fact"|"preference"|"decision"|"constraint","text":string}],"corrections":[{"trigger":string,"wrong":string,"correctApproach":string}],"techniques":[{"kind":"api-usage"|"business-rule"|"procedure"|"pitfall"|"env-recipe","name":string,"when":string,"summary":string,"steps":string[],"api":[{"symbol":string,"signature":string,"notes":string}],"example":{"language":string,"kind":"usage"|"signature"|"config","code":string},"pitfalls":string[],"verify":string[],"domain":string,"tags":string[]}]}',
  'Rules:',
  '- title: one short line naming what the session was about, in the language of the session.',
  '- summary: 1-3 sentences of durable context; skip greetings, tool noise and dead ends.',
  '- decisions/todos: only concrete, self-contained statements, each citing its subject.',
  '- files: repository-relative paths that the session actually read or changed.',
  '- tags: 1-6 lowercase keywords for later retrieval.',
  '- facts: long-lived facts and user preferences worth remembering across sessions.',
  '  Write each fact as a standalone sentence that still makes sense without this session.',
  '  Prefer a stable, canonical phrasing so repeated observations collapse into one fact.',
  '- corrections: ONLY when the user pushed back on what you did or said (a mistake, a wrong',
  '  assumption, "no, do it this way"): the local keyword filter has already flagged such a',
  '  turn, so decide from the actual exchange whether it really was a correction. An ordinary',
  '  new requirement, a follow-up task, or a neutral "try again" is NOT a correction — when in',
  '  doubt, return an empty array. Getting this wrong pollutes a global, cross-project store.',
  '  * trigger: the situation or action that brings the mistake about, phrased as a condition',
  '    ("when editing a file that was not read first"). Future sessions match on this text.',
  '  * wrong: what actually went wrong, normalised — do NOT paste the user sentence verbatim.',
  '  * correctApproach: the concrete step to take instead, phrased as an instruction.',
  '- techniques: reusable KNOWLEDGE, not code. Emit one entry only when the session',
  '  established something a future session could apply elsewhere.',
  '  * name: a one-line statement of the technique, not a task description.',
  '  * when: the trigger — the symptom, intent or task type that should recall it.',
  '  * summary: 2-4 sentences of the actual method; this is the payload.',
  '  * steps: optional ordered prose steps (never code blocks).',
  '  * api: for api-usage entries, the canonical call form as symbol + one-line signature + a note.',
  '  * example: AT MOST 8 lines and never a full implementation; illustrate, do not transcribe.',
  '    Replace project-specific identifiers with <Placeholder> names.',
  '  * pitfalls/verify: what goes wrong, and how to tell it worked.',
  '  * Never invent a technique that the session did not actually demonstrate.',
  '- Use empty arrays when a field has nothing. Never invent file paths.',
].join('\n')

/** 单个字段的长度上限，防止模型输出撑爆存储与注入。 */
const FIELD_LIMITS = {
  title: 120,
  summary: MAX_SUMMARY_CHARS,
  item: 400,
  items: 20,
  files: 40,
  tags: 8,
  /** 摘要里「请求」一行的字符上限。 */
  request: 200,
  /** 摘要里「结果」一行的字符上限。 */
  result: 240,
  /** 摘要里「过程」一行最多列出几类工具。 */
  processTools: 8,
  techniqueName: 160,
  techniqueWhen: 240,
  techniqueSummary: 600,
  techniqueSteps: 12,
  techniqueApi: 12,
  techniqueExampleLines: 8,
  techniqueExampleChars: 480,
  techniques: 5,
  correctionTrigger: 200,
  correctionWrong: 240,
  correctionApproach: 300,
  corrections: 3,
} as const

/**
 * 用模型提炼一次会话。
 *
 * 输入先被序列化成 JSON 再交给模型，避免用户文本里的分隔符破坏结构；
 * 模型输出解析失败时抛出，由 {@link distill} 决定是否回退。
 *
 * @param call - 模型调用函数。
 * @param transcript - 会话要点。
 * @param signal - 取消信号。
 * @returns 提炼出的记忆（来源为 `model`）。
 */
export async function distillWithModel(
  call: LlmTextCaller,
  transcript: Transcript,
  signal?: AbortSignal,
): Promise<DistilledMemory> {
  signal?.throwIfAborted()
  const payload = transcript.turns.map(turn => ({
    turn: turn.turn,
    user: turn.user,
    assistant: turn.assistant,
    tools: turn.tools,
    files: turn.files,
  }))
  const output = await call(
    DISTILL_SYSTEM_PROMPT,
    `Distill this session transcript (JSON):\n${JSON.stringify({
      cwd: transcript.cwd,
      stack: transcript.stack,
      turns: payload,
    })}`,
  )
  signal?.throwIfAborted()
  return redactMemory(normalize(parseDistillJson(output), transcript.stack))
}

/**
 * 提炼入口：优先走模型，失败或未配置模型时回退到本地规则。
 * @param transcript - 会话要点。
 * @param options - 模型调用函数、超时与取消信号。
 * @returns 记忆内容 + 实际生效的提炼路径。
 */
export async function distill(
  transcript: Transcript,
  options: { call?: LlmTextCaller; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DistillResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  if (options.call === undefined) {
    return { memory: distillWithRules(transcript), source: 'rule', fallbackReason: 'no model route configured' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('distill timeout')), timeoutMs)
  const abort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const memory = await distillWithModel(options.call, transcript, controller.signal)
    return { memory, source: 'model' }
  } catch (error) {
    return {
      memory: distillWithRules(transcript),
      source: 'rule',
      fallbackReason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

/** 从模型输出中截出第一个完整 JSON 对象并解析。 */
function parseDistillJson(output: string): unknown {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('distill: model output contains no JSON object')
  try {
    return JSON.parse(output.slice(start, end + 1))
  } catch (error) {
    throw new Error(`distill: model output is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** 把模型输出的原始产物收敛成形状确定、长度受控的记忆。 */
function normalize(input: unknown, stack: StackProfile | undefined): DistilledMemory {
  const record = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const summary = clip(string(record.summary), FIELD_LIMITS.summary)
  const title = clip(string(record.title), FIELD_LIMITS.title) || clip(summary, FIELD_LIMITS.title) || 'untitled session'
  return {
    title,
    summary,
    decisions: strings(record.decisions, FIELD_LIMITS.items, FIELD_LIMITS.item),
    todos: strings(record.todos, FIELD_LIMITS.items, FIELD_LIMITS.item),
    files: strings(record.files, FIELD_LIMITS.files, 240),
    tags: strings(record.tags, FIELD_LIMITS.tags, 48).map(tag => tag.toLowerCase()),
    facts: facts(record.facts),
    techniques: normalizeTechniqueDrafts(record.techniques, stack),
    corrections: corrections(record.corrections),
  }
}

/**
 * 校验并裁剪模型给出的**纠偏**认定。
 *
 * 三字段缺一即丢弃：只有「什么场景触发 / 错在哪 / 该怎么做」齐全，这条记录才能在
 * 将来既当预警又当提醒 —— 半条纠偏只会在全局库里留噪音。
 *
 * @param input - 模型输出里的 `corrections` 字段。
 * @returns 校验后的纠偏列表。
 */
function corrections(input: unknown): CorrectionDraft[] {
  if (!Array.isArray(input)) return []
  const out: CorrectionDraft[] = []
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const trigger = clip(string(record.trigger), FIELD_LIMITS.correctionTrigger)
    const wrong = clip(string(record.wrong), FIELD_LIMITS.correctionWrong)
    const correctApproach = clip(string(record.correctApproach), FIELD_LIMITS.correctionApproach)
    if (trigger.length === 0 || wrong.length === 0 || correctApproach.length === 0) continue
    out.push({ trigger, wrong, correctApproach })
    if (out.length >= FIELD_LIMITS.corrections) break
  }
  return out
}

/**
 * 校验并裁剪模型给出的技巧草稿。
 *
 * 导出供代码挖掘（`mine.ts`）复用：两条路径产出的技巧必须过同一套校验，
 * 否则「反思入库的技巧」与「挖掘入库的技巧」会在形状与限额上分叉。
 *
 * 校验刻意严格：**名称、触发条件、说明三者缺一即丢弃**。技巧是「可直接执行的操作」，
 * 残缺条目进入全局域后只会污染注入，不如不要。
 *
 * @param input - 模型输出里的 `techniques` 字段。
 * @param stack - 当前项目的技术栈，作为这些技巧的适用栈。
 * @returns 校验后的草稿数组。
 */
export function normalizeTechniqueDrafts(input: unknown, stack: StackProfile | undefined): TechniqueDraft[] {
  if (!Array.isArray(input)) return []
  const out: TechniqueDraft[] = []
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = clip(string(record.name), FIELD_LIMITS.techniqueName)
    const when = clip(string(record.when), FIELD_LIMITS.techniqueWhen)
    const summary = clip(string(record.summary), FIELD_LIMITS.techniqueSummary)
    if (name.length === 0 || when.length === 0 || summary.length === 0) continue

    const steps = strings(record.steps, FIELD_LIMITS.techniqueSteps, FIELD_LIMITS.item)
    const api = apiSurfaces(record.api)
    const example = techniqueExample(record.example)
    const domain = clip(string(record.domain), 48)
    out.push({
      kind: techniqueKind(record.kind),
      name,
      when,
      summary,
      ...(steps.length === 0 ? {} : { steps }),
      ...(api.length === 0 ? {} : { api }),
      ...(example === undefined ? {} : { example }),
      pitfalls: strings(record.pitfalls, FIELD_LIMITS.techniqueSteps, FIELD_LIMITS.item),
      verify: strings(record.verify, FIELD_LIMITS.techniqueSteps, FIELD_LIMITS.item),
      stack: stack ?? { languages: [] },
      ...(domain.length === 0 ? {} : { domain }),
      tags: strings(record.tags, FIELD_LIMITS.tags, 48).map(tag => tag.toLowerCase()),
      // 证据由提炼管线补上会话来源，不采信模型自述。
      evidence: [],
      sensitivity: sensitivity(record.sensitivity),
      status: 'draft',
    })
    if (out.length >= FIELD_LIMITS.techniques) break
  }
  return out
}

/** 校验并裁剪调用面。 */
function apiSurfaces(input: unknown): ApiSurface[] {
  if (!Array.isArray(input)) return []
  const out: ApiSurface[] = []
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const symbol = clip(string(record.symbol), 160)
    if (symbol.length === 0) continue
    const signature = clip(string(record.signature), FIELD_LIMITS.item)
    const notes = clip(string(record.notes), FIELD_LIMITS.item)
    out.push({
      symbol,
      ...(signature.length === 0 ? {} : { signature }),
      ...(notes.length === 0 ? {} : { notes }),
    })
    if (out.length >= FIELD_LIMITS.techniqueApi) break
  }
  return out
}

/** 校验并**强力裁剪**示例：行数与字符数双重上限。 */
function techniqueExample(input: unknown): TechniqueExample | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  const raw = clip(string(record.code), FIELD_LIMITS.techniqueExampleChars)
  const lines = raw.split(/\r?\n/u).slice(0, FIELD_LIMITS.techniqueExampleLines)
  const code = clip(lines.join('\n').trim(), FIELD_LIMITS.techniqueExampleChars)
  if (code.length === 0) return undefined
  const language = clip(string(record.language), 24) || 'text'
  const kind = record.kind === 'signature' || record.kind === 'config' ? record.kind : 'usage'
  return { language, kind, code }
}

/** 归一化技巧形态，未知取值按 `procedure` 处理。 */
function techniqueKind(value: unknown): TechniqueKind {
  return value === 'api-usage' || value === 'business-rule' || value === 'procedure'
    || value === 'pitfall' || value === 'env-recipe'
    ? value
    : 'procedure'
}

/** 归一化敏感级别；缺省为 `internal`（业务规则默认不外扬）。 */
function sensitivity(value: unknown): Sensitivity {
  return value === 'public' || value === 'confidential' ? value : 'internal'
}

/** 校验并裁剪 facts 数组。 */
function facts(input: unknown): SemanticDraft[] {
  if (!Array.isArray(input)) return []
  const out: SemanticDraft[] = []
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const text = clip(string(record.text), FIELD_LIMITS.item)
    if (text.length === 0) continue
    out.push({ kind: kind(record.kind), text })
    if (out.length >= FIELD_LIMITS.items) break
  }
  return out
}

/** 归一化事实类别，未知取值按 `fact` 处理。 */
function kind(value: unknown): SemanticKind {
  return value === 'preference' || value === 'decision' || value === 'constraint' || value === 'fact'
    ? value
    : 'fact'
}

/** 取字符串数组的前 N 项并按长度裁剪。 */
function strings(input: unknown, limit: number, perItem: number): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const entry of input) {
    const text = clip(string(entry), perItem)
    if (text.length === 0) continue
    if (!out.includes(text)) out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/** 宽松取字符串：非字符串返回空串（模型偶尔会用数字或 null 填字段）。 */
function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 按字符数裁剪。 */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** 偏好/约束类陈述的触发词。 */
const PREFERENCE_MARKERS = [
  '我喜欢', '我偏好', '我习惯', '我更愿意', '请用', '请使用', '不要', '别用', '禁止',
  '必须', '一定要', 'always', 'never', 'prefer', 'do not', "don't", 'must not',
]

/** 决定类陈述的触发词。 */
const DECISION_MARKERS = ['决定', '确定用', '就用', '采用', '选定', '最终选', 'decided to', 'we will use', 'go with']

/** 待办类陈述的触发词。 */
const TODO_MARKERS = ['下一步', '接下来', '待办', 'todo', '剩下', '后续要', '还需要', 'next step', 'not yet']

/** 文件路径：仓库相对路径或绝对路径，带常见源码后缀时才算。 */
const FILE_RE = /(?:^|[\s“"'([])((?:[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|py|go|rs|java|kt|sh|sql|css|html|vue))(?=[\s”"'),:;]|$)/gu

/**
 * 注入块的起始标记。
 *
 * **从块定义派生，不再手抄**：dsh 会把运行时快照、本插件的召回/技巧/失败三段注入都作为
 * `user/message` 事件发出，它们是框架输出、不是用户说的话，捕获端必须整条挡掉。标记若与
 * 块首各写一份，改块首时漏同步就会让整段注入被重新捕获（并随「召回 → 再捕获」自我放大）；
 * 技巧块的块首此前正是漏在表外的那一个。见 `injection.ts`。
 */
const INJECTED_CONTEXT_MARKERS: readonly string[] = [
  ...HOST_CONTEXT_MARKERS,
  ...INJECTION_BLOCKS.map(block => block.header[0] as string),
]

/**
 * 判断一条 user/message 是否整条都是宿主注入的上下文块。
 *
 * 只认开头：真正的用户请求可能**提到**这些词（例如「刚才那段 Recalled memory 是什么意思」），
 * 但不会以块首标记起头。按前缀判定既能挡住注入块，也不会误伤这类提问。
 *
 * @param text - 该条 user/message 的纯文本。
 * @returns 整条都是注入块时为 true。
 */
export function isInjectedContext(text: string): boolean {
  const head = text.trimStart()
  return head.length > 0 && INJECTED_CONTEXT_MARKERS.some(marker => head.startsWith(marker))
}

/**
 * 本地规则提炼：不调用模型，从轮次要点的文本里抽取结构化记忆。
 *
 * 摘要按「请求 → 过程 → 结果」组织，三者都可能是跨会话有用的信息：请求说明要做什么，
 * 过程记录动了哪些工具，结果给出最后落点。**过程只留去重后的工具类别**，重复调用不重复
 * 记账 —— 原始工具流水既撑爆注入窗口，又会在召回后被下一轮会话重新捕获、逐次放大。
 *
 * 规则只做「有明确措辞标记」的抽取，宁可少记也不臆造；因此它产出的
 * `facts` 通常比模型路径少，但绝不引入会话里没出现过的内容。
 *
 * @param transcript - 会话要点。
 * @returns 提炼出的记忆（来源为 `rule`）。
 */
export function distillWithRules(transcript: Transcript): DistilledMemory {
  const files = new Set<string>()
  const decisions: string[] = []
  const todos: string[] = []
  const facts: SemanticDraft[] = []
  const tools = new Set<string>()
  const userTexts: string[] = []
  const assistantTexts: string[] = []

  for (const turn of transcript.turns) {
    if (turn.user.length > 0) userTexts.push(turn.user)
    if (turn.assistant.length > 0) assistantTexts.push(turn.assistant)
    for (const file of turn.files) files.add(file)
    for (const tool of turn.tools) tools.add(tool)

    for (const sentence of sentences(turn.user)) {
      if (push(facts.map(item => item.text), sentence, PREFERENCE_MARKERS)) {
        facts.push({ kind: 'preference', text: clip(sentence, FIELD_LIMITS.item) })
      } else if (push(decisions, sentence, DECISION_MARKERS)) {
        decisions.push(clip(sentence, FIELD_LIMITS.item))
      } else if (push(todos, sentence, TODO_MARKERS)) {
        todos.push(clip(sentence, FIELD_LIMITS.item))
      }
      collectFiles(sentence, files)
    }
    for (const sentence of sentences(turn.assistant)) {
      collectFiles(sentence, files)
    }
  }

  const request = userTexts[0] ?? ''
  const result = assistantTexts.at(-1) ?? ''
  const title = clip(firstLine(request), FIELD_LIMITS.title) || 'untitled session'
  const summary = clip(
    [
      `会话共 ${transcript.turns.length} 轮。`,
      request.length > 0 ? `请求：${clip(collapse(request), FIELD_LIMITS.request)}` : '',
      processLine(tools),
      result.length > 0 ? `结果：${clip(collapse(result), FIELD_LIMITS.result)}` : '',
      decisions.length > 0 ? `决定：${decisions.slice(0, 3).join(' ｜ ')}` : '',
      todos.length > 0 ? `待办：${todos.slice(0, 3).join(' ｜ ')}` : '',
      files.size > 0 ? `文件：${[...files].slice(0, 8).join(', ')}` : '',
    ]
      .filter(part => part.length > 0)
      .join(' '),
    FIELD_LIMITS.summary,
  )

  return redactMemory({
    title,
    summary,
    decisions: dedupe(decisions).slice(0, FIELD_LIMITS.items),
    todos: dedupe(todos).slice(0, FIELD_LIMITS.items),
    files: [...files].slice(0, FIELD_LIMITS.files),
    // 检索标签只放技术栈这类稳定、可复用的关键词。工具名不再进 tags：过程信息已经作为
    // 「过程」一行进入摘要（`episodicText` 会索引 summary），再进 tags 只会让召回块被
    // bash/read/edit 这类通用词淹没，并随「召回 → 再捕获」循环自我放大。
    tags: stackTags(transcript.stack),
    facts: facts.slice(0, FIELD_LIMITS.items),
    // 规则路径不产出技巧：技巧需要跨会话可复用的抽象，靠会话末的模型反思或代码挖掘产出。
    techniques: [],
    // 同理，规则路径**不认定纠偏语义**：本地关键词只能证明「这句话长得像纠偏」，
    // 证明不了它真是纠偏，所以只留给模型判（见 `index.ts` 的两段式筛选）。
    corrections: [],
  })
}

/** 「过程」一行：只列去重后的工具类别，超出上限时补一个总数。 */
function processLine(tools: ReadonlySet<string>): string {
  const list = [...tools]
  if (list.length === 0) return ''
  const shown = list.slice(0, FIELD_LIMITS.processTools)
  const rest = list.length - shown.length
  return `过程：${shown.join('、')}${rest > 0 ? ` 等 ${list.length} 类工具` : ''}`
}

/** 规则路径的检索标签：只取技术栈语言，画像缺失时留空。 */
function stackTags(stack: StackProfile | undefined): string[] {
  return (stack?.languages ?? [])
    .map(language => language.toLowerCase())
    .slice(0, FIELD_LIMITS.tags)
}

/** 把一段文本压成单行：折叠全部空白，便于放进摘要的一行里。 */
function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** 命中任一标记即返回 true，用于把一句话归入某一类。 */
function push(target: readonly string[], sentence: string, markers: readonly string[]): boolean {
  const lower = sentence.toLowerCase()
  const hit = markers.some(marker => lower.includes(marker.toLowerCase()))
  if (!hit) return false
  return !target.includes(clip(sentence, FIELD_LIMITS.item))
}

/** 从一句话里抽取文件路径。 */
function collectFiles(sentence: string, into: Set<string>): void {
  for (const match of sentence.matchAll(FILE_RE)) {
    const path = match[1]
    if (path !== undefined && !path.startsWith('http')) into.add(path)
  }
}

/** 把一段文本按中英文标点切成句子。 */
function sentences(text: string): string[] {
  return text
    .split(/[。！？；\n\r]|(?<=[.!?;])\s+/gu)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 4)
}

/** 取首行并压掉多余空白。 */
function firstLine(text: string): string {
  return (text.split(/[\n\r]/u)[0] ?? '').replace(/\s+/gu, ' ').trim()
}

/** 保序去重。 */
function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)]
}
