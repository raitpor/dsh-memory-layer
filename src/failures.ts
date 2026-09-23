/**
 * 失败经验层：把「同一个错误」跨会话认出来，并按重复次数升级处置。
 *
 * 本模块只做**纯函数**判断（归一化、指纹、升级、渲染），不碰磁盘也不碰事件 ——
 * 事件捕获在 `index.ts`，存储在 `store.ts`。这样指纹的稳定性可以单独测试，
 * 而它正是整个特性的技术核心。
 *
 * 为什么指纹要「剥离易变成分」：同一个错误在不同项目里，路径、行号、内存地址、
 * 变量取值、端口、耗时都不会一样。若原样入指纹，就永远认不出「又犯了同一个错」，
 * 特性直接失效。
 *
 * @module dsh-memory-layer/failures
 */

import { createHash } from 'node:crypto'
import { semanticKey } from './store.js'
import { tokenize } from './recall.js'
import { stacksCompatible } from './stack/index.js'
import { redact, sanitizeForText } from './redact.js'
import type { FailureFingerprint, FailureRecord, GuardSpec, StackProfile } from './types.js'

/** 归一化模板的默认字符上限。 */
export const TEMPLATE_MAX_CHARS = 200

/** 失败现象的字符上限。 */
export const SYMPTOM_MAX_CHARS = 300

/**
 * 本插件自身产生的拒绝标记（错误码）。
 *
 * 关键作用：阻止**自我强化循环**。若把自己的拒绝也当成一次失败观测，
 * 就会出现「拒绝一次 → 计数 +1 → 更容易拒绝」的正反馈。
 */
export const SELF_DENIAL_CODE = 'MEMORY_LAYER_FAILURE_GUARD'

/** 拦截理由里的可见标记：文本匹配用（管道拒绝不带错误码）。 */
export const SELF_DENIAL_MARKER = SELF_DENIAL_CODE

/** 自动推导守卫时优先取用的参数名（命令类工具）。 */
const GUARD_ARG_KEYS = ['command', 'cmd', 'script', 'input'] as const

/** 自动推导守卫时允许的工具默认值。 */
export const DEFAULT_GUARD_TOOLS: readonly string[] = ['bash']

/**
 * 判断一条工具结果是否来自本插件自己的拒绝。
 *
 * 必须同时匹配**消息文本**：dsh 的工具管道把 `deny` 物化成 `error.message`，
 * 并不带 `error.name` / `error.code`（那对字段只有工具自己附加失败身份时才有）。
 * 只查 code 会漏掉我们自己的拒绝，从而触发自我强化循环。
 *
 * @param errorCode - 结果的错误码。
 * @param errorName - 结果的错误名。
 * @param message - 结果文本。
 * @returns 是本插件的拒绝时为 `true`。
 */
export function isSelfDenial(
  errorCode: string | undefined,
  errorName: string | undefined,
  message = '',
): boolean {
  return errorCode === SELF_DENIAL_CODE
    || errorName === SELF_DENIAL_CODE
    || message.includes(SELF_DENIAL_MARKER)
}

/**
 * 把错误消息归一化成**跨会话稳定**的模板。
 *
 * 处理顺序刻意从「最具体」到「最泛化」：先抹掉哈希/UUID/地址这类长且唯一的串，
 * 再抹路径与文件名，最后才处理裸数字 —— 顺序反过来会让 `1.20.1` 之类的版本号
 * 提前变成 `N.N.N`，破坏版本差异的区分度。
 *
 * @param message - 原始错误文本（可多行，只取首个非空行）。
 * @param maxChars - 结果字符上限。
 * @returns 归一化模板。
 */
export function normalizeErrorTemplate(message: string, maxChars: number = TEMPLATE_MAX_CHARS): string {
  const firstLine = message
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => line.length > 0) ?? ''

  const normalized = firstLine
    // 长十六进制串（哈希、commit、digest）与 UUID 先处理：它们最长且最唯一。
    .replace(/\b[0-9a-fA-F]{32,}\b/gu, 'HASH')
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gu, 'UUID')
    // 内存地址与指针。
    .replace(/\b0x[0-9a-fA-F]+\b/gu, 'ADDR')
    // 「路径 + 文件名 + 可选 file:line[:col]」必须**一条规则**吃掉。
    // 若先折叠路径再处理文件名，`index.js:12:3` 会先变成 `PATH:12:3`，
    // 冒号后的行号就会被后面的端口规则误判成端口，导致行号无法归一。
    .replace(
      /(?:\/[\w.@-]+)*[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|java|kt|kts|py|go|rs|rb|php|cs|cpp|c|h|md|txt|yml|yaml|toml|xml|gradle|properties|sql)(?::\d+(?::\d+)?)?/giu,
      'FILE',
    )
    // 其余（无已知扩展名）的 Windows 与 POSIX 路径。
    .replace(/\b[A-Za-z]:\\(?:[\w .@-]+\\)+[\w .@-]+/gu, 'PATH')
    .replace(/(?:\/[\w.@-]+){2,}\/?/gu, 'PATH')
    .replace(/\bline \d+\b/giu, 'line N')
    .replace(/\b(?:at|in) \d+:\d+\b/gu, 'at N:N')
    // 时间与耗时。
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/gu, 'TIMESTAMP')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|us|ns|s|sec|seconds|minutes)\b/giu, 'DURATION')
    // 端口（`:8080` / `:3000`），必须在裸数字之前。
    .replace(/:(?:6553[0-5]|655[0-2]\d|65[0-4]\d|6[0-4]\d{2}|[1-5]\d{3}|[1-9]\d{2}|[1-9]\d)(?![\d.])/gu, ':PORT')
    // 引号内字面量：具体模块名/参数值会变，但「引号里有东西」不变。
    .replace(/"[^"]{0,120}"/gu, 'LITERAL')
    .replace(/'[^']{0,120}'/gu, 'LITERAL')
    .replace(/`[^`]{0,120}`/gu, 'LITERAL')
    // 点分版本号先收敛成同一形状（`1.20.1` 与 `1.21.0` 属于同一类错误），
    // 再处理裸数字；否则裸数字规则会把版本次第吃掉、留下无意义的 N.N.N。
    .replace(/\b\d+\.\d+(?:\.\d+)*\b/gu, 'VER')
    // 最后才是裸数字（行号、计数、大小）。
    .replace(/\b\d+\b/gu, 'N')
    .replace(/\s+/gu, ' ')
    .trim()

  return clip(normalized, maxChars)
}

/**
 * 计算机械指纹。
 *
 * @param parts - 工具名、错误名、错误码与归一化模板。
 * @returns 稳定的十六进制指纹键。
 */
export function machineFingerprintKey(parts: {
  tool?: string
  errorName?: string
  errorCode?: string
  template?: string
}): string {
  const material = [
    parts.tool ?? '',
    parts.errorName ?? '',
    parts.errorCode ?? '',
    parts.template ?? '',
  ].join('|')
  return createHash('sha1').update(material).digest('hex').slice(0, 32)
}

/**
 * 由一次工具失败构造机械指纹。模板为空时返回 `undefined`（没有可比较的信号，
 * 宁可漏掉一次观测，也不要造一个会误合并所有空错误的指纹）。
 *
 * @param input - 工具名、错误名、错误码与原始消息。
 * @param maxChars - 模板字符上限。
 * @returns 指纹；无法构造时 `undefined`。
 */
export function machineFingerprint(
  input: { tool?: string; errorName?: string; errorCode?: string; message: string },
  maxChars: number = TEMPLATE_MAX_CHARS,
): FailureFingerprint | undefined {
  const template = normalizeErrorTemplate(input.message, maxChars)
  if (template.length === 0) return undefined
  return {
    kind: 'machine',
    key: machineFingerprintKey({
      ...(input.tool === undefined ? {} : { tool: input.tool }),
      ...(input.errorName === undefined ? {} : { errorName: input.errorName }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      template,
    }),
    ...(input.tool === undefined ? {} : { tool: input.tool }),
    ...(input.errorName === undefined ? {} : { errorName: input.errorName }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    template,
  }
}

/**
 * 由用户纠偏一类非结构化信号构造语义指纹。
 *
 * 语义指纹刻意**只做精确归一化匹配**（不引入相似度阈值）：误合并会导致误拦截，
 * 代价高于漏报。相似度匹配留给后续阶段，并且只允许驱动 L1 预警。
 *
 * @param text - 用户纠偏原文。
 * @returns 语义指纹；文本无可比较内容时 `undefined`。
 */
export function semanticFingerprint(text: string): FailureFingerprint | undefined {
  const normalized = semanticKey(text)
  if (normalized.length < 4) return undefined
  const template = clip(redact(text.trim().replace(/\s+/gu, ' ')), TEMPLATE_MAX_CHARS)
  return {
    kind: 'semantic',
    key: createHash('sha1').update(`sem:${normalized}`).digest('hex').slice(0, 32),
    template,
    tokens: [...new Set(tokenize(text))].slice(0, 40),
  }
}

/** 一次失败观测：指纹 + 可读现象。 */
export interface FailureObservation {
  /** 指纹。 */
  fingerprint: FailureFingerprint
  /** 现象：最近一次的具体错误首行（已脱敏）。 */
  symptom: string
}

/**
 * 从一次工具失败中提取观测。
 *
 * @param input - 工具名、错误名/码与结果文本。
 * @param maxChars - 模板字符上限。
 * @returns 观测；无法构造指纹时 `undefined`。
 */
export function observeToolFailure(
  input: { tool?: string; errorName?: string; errorCode?: string; message: string },
  maxChars: number = TEMPLATE_MAX_CHARS,
): FailureObservation | undefined {
  const fingerprint = machineFingerprint(input, maxChars)
  if (fingerprint === undefined) return undefined
  const symptom = clip(redact(firstLine(input.message)), SYMPTOM_MAX_CHARS)
  return { fingerprint, symptom }
}

/** 升级阈值：达到 `warn` 次开始预警，达到 `ask` 次开始询问（P2），达到 `block` 次开始拦截（P2）。 */
export interface EscalationThresholds {
  /** 第几次开始注入预警。 */
  warn: number
  /** 第几次开始在派发前询问（P2）。 */
  ask: number
  /** 第几次开始硬拦截（P2）；`0` 表示从不。 */
  block: number
}

/**
 * 按重复次数推导处置强度。
 * @param occurrences - 累计发生次数。
 * @param thresholds - 阈值。
 * @returns 处置强度。
 */
export function enforcementFor(
  occurrences: number,
  thresholds: EscalationThresholds,
): FailureRecord['enforcement'] {
  if (thresholds.block > 0 && occurrences >= thresholds.block) return 'block'
  if (occurrences >= thresholds.ask) return 'ask'
  return 'warn'
}

/**
 * 判断一条失败记录是否该进入预警。
 *
 * 三个条件缺一不可：达到重复阈值、未被解决、技术栈适用。
 *
 * @param record - 失败记录。
 * @param thresholds - 阈值。
 * @returns 应预警时为 `true`。
 */
export function shouldWarn(record: FailureRecord, thresholds: EscalationThresholds): boolean {
  if (record.status === 'deprecated') return false
  return record.occurrences >= thresholds.warn
}

/**
 * 渲染拦截理由。
 *
 * 三条硬约束在这里落地：**必须给出可执行的下一步**（remedy 或明确的替代动作）、
 * **必须告诉 agent 逃生舱在哪**（`failure_forgive`），以及**带自身拒绝标记**，
 * 使这次拒绝不会被记为又一次失败。
 *
 * @param record - 失败记录。
 * @returns 拒绝理由。
 */
export function failureDenialReason(record: FailureRecord): string {
  const remedy = record.remedy.length > 0
    ? record.remedy
    : '先定位根因并换一种做法，不要原样重复上一次操作'
  return [
    `[${SELF_DENIAL_MARKER}] Blocked: this repeats a known mistake (${record.occurrences}x) — ${record.symptom}.`,
    `Correct approach: ${remedy}.`,
    `If the user explicitly asked to proceed anyway, call failure_forgive with id ${record.id} first.`,
  ].join(' ')
}

/**
 * 从失败调用的参数里推导一个**足够窄**的守卫字面量。
 *
 * 窄性刻意用一群否决条件来保证，而不是靠长度：
 * 含路径、含凭据（脱敏会改变内容）或过短/过长一律**放弃守卫**。
 * 宁可这条失败不拦截，也不能造出一个会挡住正常操作的守卫。
 *
 * @param args - 已解析的工具参数。
 * @param maxChars - 字面量长度上限。
 * @returns 可用作 `allOf` 的字面量；不适用时 `undefined`。
 */
export function guardLiteralFromArguments(args: unknown, maxChars = 120): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  let candidate: string | undefined
  for (const key of GUARD_ARG_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      candidate = value
      break
    }
  }
  if (candidate === undefined) {
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        candidate = value
        break
      }
    }
  }
  if (candidate === undefined) return undefined

  const line = (candidate.split(/\r?\n/u).find(part => part.trim().length > 0) ?? '').trim()
  if (line.length < 4 || line.length > maxChars) return undefined
  if (/[/\\]/u.test(line)) return undefined
  if (redact(line) !== line) return undefined
  return line
}

/**
 * 由失败的调用推导守卫条件。
 * @param tool - 失败发生的工具名。
 * @param args - 该次调用的参数。
 * @param guardTools - 允许自动守卫的工具白名单。
 * @returns 守卫条件；不适用时 `undefined`。
 */
export function deriveGuard(
  tool: string | undefined,
  args: unknown,
  guardTools: readonly string[] = DEFAULT_GUARD_TOOLS,
): GuardSpec | undefined {
  if (tool === undefined || !guardTools.includes(tool)) return undefined
  const literal = guardLiteralFromArguments(args)
  if (literal === undefined) return undefined
  return { tool, allOf: [literal] }
}

/**
 * 渲染一行失败预警。
 *
 * 预警**必须给出可执行的下一步**：知道 remedy 就给 remedy；不知道时至少给出
 * 「重复次数 + 现场文件」并明确要求先定位根因，而不是只说「别犯错」。
 *
 * @param record - 失败记录。
 * @param recentFiles - 最近一次失败现场涉及的文件（工作区相对路径）。
 * @returns 单行文本。
 */
export function failureWarningLine(record: FailureRecord, recentFiles: readonly string[] = []): string {
  const parts = [
    `[已重复 ${record.occurrences} 次] ${record.symptom}`,
  ]
  if (record.remedy.length > 0) parts.push(`正确做法：${record.remedy}`)
  else parts.push('先定位根因再重试，不要原样重复上一次操作')
  if (recentFiles.length > 0) parts.push(`上次现场：${recentFiles.slice(0, 4).join(', ')}`)
  if (record.fingerprint.tool !== undefined) parts.push(`工具：${record.fingerprint.tool}`)
  parts.push(`id ${record.id}`)
  return parts.join(' — ')
}

/**
 * 为一个**机械**失败推导粗粒度的触发方式。
 *
 * 机械观测只知道「哪个工具、报了什么」，说不出「在什么情形下会撞上」—— 那需要模型。
 * 这里给出的是**可用但不精确**的兜底描述（工具 + 归一化错误模板），用途有两个：
 * 让 `failure_resolve` 没写 trigger 时也有东西可用于场景匹配，以及让 `failure_list`
 * 不至于在触发方式一栏留空。语义纠偏的 trigger 由模型直接给出，不走这里。
 *
 * @param input - 工具名、错误名与归一化模板。
 * @returns 触发方式描述；三者皆空时返回 `undefined`。
 */
export function deriveTrigger(input: {
  tool?: string
  errorName?: string
  template?: string
}): string | undefined {
  const subject = [input.tool, input.errorName].filter((part): part is string => part !== undefined && part.length > 0)
  const symptom = (input.template ?? '').trim()
  if (subject.length === 0 && symptom.length === 0) return undefined
  const where = subject.length === 0 ? '调用工具时' : `使用 ${subject.join(' ')} 时`
  return symptom.length === 0 ? where : `${where}遇到「${symptom}」这类情况`
}

/**
 * 渲染一条**已解决**失败的提前提醒。
 *
 * 与 {@link failureWarningLine} 的区别在语气与用途：那条是「你又犯了」，这条是
 * 「这个场景以前踩过、已经解决，动手前先把结论拿走」。因此它不报重复次数，而是给出
 * 触发方式与解决方案；若解决之后又被触发过，则据实说明 —— 那正是「修复没守住」的
 * 信号，比单纯的复现次数更有价值。
 *
 * @param record - 已解决的失败记录。
 * @returns 单行文本。
 */
export function failureLessonLine(record: FailureRecord): string {
  const relapsed = record.occurrencesAtResolve === undefined
    ? 0
    : Math.max(0, record.occurrences - record.occurrencesAtResolve)
  const parts = [`[已解决${relapsed > 0 ? `·解决后又触发 ${relapsed} 次` : ''}]`]
  const trigger = failureTrigger(record)
  if (trigger !== undefined) parts.push(`触发场景：${trigger}`)
  parts.push(`现象：${record.symptom}`)
  parts.push(record.remedy.length > 0 ? `当时的做法：${record.remedy}` : '当时的记录没写做法，动手前再确认一遍')
  parts.push(`id ${record.id}`)
  return parts.join(' — ')
}

/**
 * 取一条失败记录的触发方式：显式字段优先，缺失时退回 {@link deriveTrigger}。
 * @param record - 失败记录。
 * @returns 触发方式描述；无从推导时 `undefined`。
 */
export function failureTrigger(record: FailureRecord): string | undefined {
  if (record.trigger !== undefined && record.trigger.trim().length > 0) return record.trigger
  return deriveTrigger({
    ...(record.fingerprint.tool === undefined ? {} : { tool: record.fingerprint.tool }),
    ...(record.fingerprint.errorName === undefined ? {} : { errorName: record.fingerprint.errorName }),
    ...(record.fingerprint.template === undefined ? {} : { template: record.fingerprint.template }),
  })
}

/**
 * 判断一条**已解决**的记录是否值得在当前场景提前提醒。
 *
 * 判据刻意做成两条确定性规则，而不是一个可调的相似度阈值 —— 失败层通常只有个位数
 * 记录，BM25 的 idf 在这种小语料上没有区分度，阈值只会变成没人能解释的魔数：
 *
 * 1. **工具命中**：当前会话用过同一个工具。工具名是强信号，直接放行；
 * 2. **词面重合 ≥2 个词**：`trigger` + 解决方案与当前上下文（最近用户输入、文件、
 *    工具名）的重合词数。单个词太容易偶合 —— 「文件」「错误」这类词遍地都是。
 *
 * @param record - 已解决的失败记录。
 * @param contextTokens - 当前上下文的词集合（调用方用 `tokenize` 生成）。
 * @param sessionTools - 当前会话用过的工具名。
 * @returns 值得提醒时为 `true`。
 */
export function lessonMatches(
  record: FailureRecord,
  contextTokens: ReadonlySet<string>,
  sessionTools: ReadonlySet<string>,
): boolean {
  const tool = record.fingerprint.tool
  if (tool !== undefined && sessionTools.has(tool)) return true
  const tokens = new Set(tokenize(`${failureTrigger(record) ?? ''} ${record.remedy}`))
  let shared = 0
  for (const token of tokens) {
    if (!contextTokens.has(token)) continue
    shared += 1
    if (shared >= 2) return true
  }
  return false
}

/**
 * 渲染一条失败记录的完整正文（供 `failure_list` 使用）。
 * @param record - 失败记录。
 * @returns 多行文本。
 */
export function failureDetail(record: FailureRecord): string {
  const lines = [
    `${record.symptom} [${record.id}]`,
    `Fingerprint: ${record.fingerprint.kind}/${record.fingerprint.key}`,
    `Occurrences: ${record.occurrences} | Prevented: ${record.prevented} | Enforcement: ${record.enforcement}`,
    `Status: ${record.status} | First seen: ${new Date(record.firstSeen).toISOString()} | Last seen: ${new Date(record.lastSeen).toISOString()}`,
    `Remedy: ${record.remedy.length > 0 ? record.remedy : '(尚未记录正确做法，可用 failure_resolve 补充)'}`,
  ]
  const trigger = failureTrigger(record)
  if (trigger !== undefined) lines.push(`Trigger: ${trigger}`)
  if (record.resolvedAt !== undefined) {
    const relapsed = record.occurrencesAtResolve === undefined
      ? 0
      : Math.max(0, record.occurrences - record.occurrencesAtResolve)
    lines.push(`Resolved at: ${new Date(record.resolvedAt).toISOString()}${relapsed > 0 ? `（解决后又触发 ${relapsed} 次）` : ''}`)
  }
  if (record.fingerprint.template !== undefined) lines.push(`Template: ${record.fingerprint.template}`)
  if (record.sessions.length > 0) lines.push(`Sessions: ${record.sessions.join(', ')}`)
  if (record.evidence.length > 0) {
    lines.push(`Evidence: ${record.evidence.map(item => [item.kind, item.repo, item.role, item.hint].filter(Boolean).join('/')).join(', ')}`)
  }
  return sanitizeForText(lines.join('\n'))
}

/**
 * 判断一次新的观测是否命中已有的守卫条件（P2 的派发前拦截使用）。
 *
 * 匹配**必须窄**：只认具体工具 + 明确的参数子串，禁止通配，
 * 否则会把正常操作一起挡掉。
 *
 * @param guard - 守卫条件。
 * @param tool - 即将执行的工具名。
 * @param args - 已解析的参数对象。
 * @returns 命中时为 `true`。
 */
export function guardMatches(guard: GuardSpec, tool: string, args: unknown): boolean {
  if (guard.tool !== tool) return false
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  if (guard.argKeys !== undefined && !guard.argKeys.every(key => key in record)) return false
  const haystack = JSON.stringify(record)
  if (guard.allOf !== undefined && !guard.allOf.every(needle => haystack.includes(needle))) return false
  if (guard.pattern !== undefined) {
    try {
      if (!new RegExp(guard.pattern, 'u').test(haystack)) return false
    } catch {
      return false
    }
  }
  return guard.argKeys !== undefined || guard.allOf !== undefined || guard.pattern !== undefined
}

/**
 * 判断失败记录是否适用于当前技术栈。
 *
 * 与技巧层共用 `stacksCompatible`：两套知识必须同一套口径，
 * 否则会出现「技巧被过滤掉、但关于它的失败预警却照常注入」的错配。
 *
 * @param record - 失败记录。
 * @param current - 当前项目栈。
 * @returns 适用时为 `true`。
 */
export function failureApplies(record: FailureRecord, current: StackProfile | undefined): boolean {
  return stacksCompatible(record.stack, current)
}

/** 取文本首行并压掉多余空白。 */
function firstLine(text: string): string {
  return (text.split(/\r?\n/u).find(line => line.trim().length > 0) ?? '').trim().replace(/\s+/gu, ' ')
}

/** 按字符数裁剪。 */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}
