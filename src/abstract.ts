/**
 * 抽象与去标识化：把「项目私有」的信息从知识里剥离。
 *
 * 在「默认全局」的前提下，跨项目隔离不再由目录分桶承担，而是**前移到入库环节**：
 * 进入全局域的文本必须先经过这里，把项目私有标识替换为**种类化占位符**，
 * 保留可复用的结构（库/SDK 符号、注解、调用顺序、错误处理）。
 *
 * 本模块是 P0 的**最小实现**：凭据脱敏 + 显式标识符替换 + 自动识别常见私有标识 +
 * 外部绝对路径擦除。完整的「模型归纳 + 泄漏校验」属于 P3，接口保持不变以便替换。
 *
 * @module dsh-memory-layer/abstract
 */

import { redact } from './redact.js'
import type { TechniqueDraft, TechniqueEvidence } from './types.js'

/** 占位符种类：只暴露「这是个什么」，不暴露「它叫什么」。 */
export type PlaceholderKind = 'Class' | 'pkg' | 'CONST' | 'id'

/** 抽象选项。 */
export interface AbstractOptions {
  /** 显式给出的项目私有标识（来自仓库画像或调用方）。 */
  identifiers?: readonly string[]
  /**
   * 是否启用自动识别（**默认关闭**）。
   *
   * 默认关闭是刻意的：自动识别会连库/SDK 的类名一起抹掉，而库符号恰恰是技巧里
   * 最该保留的可复用部分。调用方应优先用 {@link identifiersFromPaths} 从
   * **项目自己的文件路径**推导私有标识，那才是高置信度信号。
   */
  autoDetect?: boolean
}

/** 抽象结果。 */
export interface AbstractResult {
  /** 去标识化后的文本。 */
  text: string
  /** 占位符 → 原值映射；仅当调用方显式要求留存时才应落盘。 */
  placeholders: Record<string, string>
}

/**
 * 不该被当作项目私有标识的通用技术词。
 *
 * 误伤这些词会让技巧失去可读性（例如把 `JSON` 换成 `<CONST1>`），
 * 因此宁可漏掉，也不替换。
 */
const COMMON_TERMS = new Set([
  'JSON', 'HTTP', 'HTTPS', 'URL', 'URI', 'API', 'SDK', 'ID', 'IDS', 'SQL', 'HTML', 'XML', 'CSS',
  'UUID', 'GUID', 'TODO', 'FIXME', 'NOTE', 'README', 'LICENSE', 'OK', 'ERROR', 'NULL', 'TRUE',
  'FALSE', 'UTF', 'ASCII', 'CRUD', 'REST', 'GRPC', 'JWT', 'OAuth', 'CORS', 'DNS', 'TCP', 'UDP',
  'TLS', 'SSL', 'CPU', 'GPU', 'RAM', 'IO', 'OS', 'UI', 'UX', 'DB', 'CLI', 'CI', 'CD', 'PR',
  'Type', 'String', 'Number', 'Boolean', 'Object', 'Array', 'Map', 'Set', 'List', 'Promise',
  'Error', 'Exception', 'Result', 'Options', 'Config', 'Request', 'Response', 'Client', 'Server',
])

/** 形如 `OrderService` / `OrderPolicyV2` 的 PascalCase 私有标识。 */
const PASCAL_RE = /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/gu

/** 形如 `com.acme.orders` 的包名/命名空间（至少三段，全小写）。 */
const PACKAGE_RE = /\b[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}\b/gu

/** 绝对路径（POSIX 风格，至少两级），用于抹掉项目结构线索。 */
const ABSOLUTE_PATH_RE = /(?:^|[\s"'(=])(\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)/gu

/**
 * 判断一个标识符的种类。
 * @param value - 标识符原文。
 * @returns 占位符种类。
 */
export function classifyIdentifier(value: string): PlaceholderKind {
  if (/^[A-Z][A-Z0-9_]{2,}$/u.test(value)) return 'CONST'
  if (value.includes('.')) return 'pkg'
  if (/^[A-Z]/u.test(value)) return 'Class'
  return 'id'
}

/**
 * 从文本中自动识别可能的项目私有标识。
 *
 * 只识别**高置信度**的两类：PascalCase 组合词与多段小写包名。
 * 刻意不识别全大写常量 —— `TODO` / `JSON` 这类通用词太多，误伤代价高于漏网。
 *
 * @param text - 任意文本。
 * @returns 去重后的标识符列表。
 */
export function detectIdentifiers(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(PASCAL_RE)) {
    const value = match[0]
    if (value.length >= 6 && !COMMON_TERMS.has(value)) found.add(value)
  }
  for (const match of text.matchAll(PACKAGE_RE)) {
    const value = match[0]
    if (!value.split('.').some(segment => COMMON_TERMS.has(segment))) found.add(value)
  }
  return [...found]
}

/**
 * 只有**代码文件**的文件名才可能承载「项目私有代码标识」。
 *
 * 曾经的教训：一次会话读的是 `plantuml.txt`（一份文档），文件名推出的 `plantuml`
 * 是 8 个字母的小写词，刚好越过下面的长度门槛被当成私有标识，于是把这一会话产出的
 * 所有技巧的 `domain: "PlantUML"` 与 `tags` 一起打成了 `<id1>` —— 分类元数据被抹掉，
 * 按 domain/tag 的检索整片失效。数据与文档文件不参与标识符推导。
 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
  'py', 'rb', 'php', 'go', 'rs', 'cs', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'm', 'mm',
  'swift', 'dart', 'lua', 'pl', 'r', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'vue', 'svelte',
])

/**
 * 从**项目自己的代码文件路径**推导私有标识候选。
 *
 * 这是比正则扫描可靠得多的信号：出现在工作区代码路径里的类型名基本可以确定是项目私有
 * 代码，而不是第三方库。取文件名去掉扩展名，并过滤非代码文件、过短与通用词。
 *
 * @param paths - 工作区相对路径列表。
 * @returns 去重后的标识符候选。
 */
export function identifiersFromPaths(paths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const path of paths) {
    const base = path.split(/[/\\]/u).pop() ?? ''
    const dot = base.lastIndexOf('.')
    if (dot <= 0) continue
    if (!CODE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())) continue
    const name = base.slice(0, dot)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue
    if (COMMON_TERMS.has(name)) continue
    // 高置信度门槛：PascalCase 类型名，或足够长的标识符。
    // 5 个字母的小写文件名（如 `store`）几乎全是通用词，收进来只会误伤。
    if (!/^[A-Z]/u.test(name) && name.length < 8) continue
    out.add(name)
  }
  return [...out]
}

/**
 * 对文本做去标识化。
 *
 * 步骤：① 凭据脱敏；② 按「先长后短」替换标识符；③ 抹掉外部绝对路径。
 *
 * 占位符编号按标识符在文本中**首次出现的位置**分配，因此同样的输入产出同样的结果，
 * 便于测试与人工核对。
 *
 * @param text - 原始文本。
 * @param options - 显式标识符与自动识别开关。
 * @returns 去标识化文本与占位符映射。
 */
export function abstractText(text: string, options: AbstractOptions = {}): AbstractResult {
  if (text.length === 0) return { text, placeholders: {} }

  const candidates = new Set<string>(options.identifiers ?? [])
  if (options.autoDetect === true) {
    for (const detected of detectIdentifiers(text)) candidates.add(detected)
  }

  const ordered = [...candidates]
    .filter(value => value.trim().length >= 3 && !COMMON_TERMS.has(value))
    .map(value => ({ value, index: text.indexOf(value) }))
    .filter(entry => entry.index >= 0)
    .sort((left, right) => left.index - right.index || right.value.length - left.value.length)

  const placeholders: Record<string, string> = {}
  const counters: Record<PlaceholderKind, number> = { Class: 0, pkg: 0, CONST: 0, id: 0 }
  let output = redact(text)

  for (const { value } of ordered) {
    const kind = classifyIdentifier(value)
    counters[kind] += 1
    const placeholder = `<${kind}${counters[kind]}>`
    placeholders[placeholder] = value
    output = output.split(value).join(placeholder)
  }

  output = output.replace(ABSOLUTE_PATH_RE, (match, path: string) => {
    placeholders['[PATH]'] = placeholders['[PATH]'] ?? path
    return match.replace(path, '[PATH]')
  })

  return { text: output, placeholders }
}

/**
 * 检查文本里是否仍残留给定标识符。P0 用作轻量自检；完整的泄漏校验在 P3。
 * @param text - 待检查文本。
 * @param identifiers - 敏感标识符列表。
 * @returns 命中的标识符（保序去重）。
 */
export function findIdentifierLeaks(text: string, identifiers: readonly string[]): string[] {
  const out: string[] = []
  for (const identifier of identifiers) {
    if (identifier.length >= 3 && text.includes(identifier) && !out.includes(identifier)) {
      out.push(identifier)
    }
  }
  return out
}

// ---- 技巧草稿的抽象化与泄漏校验 ---------------------------------------------

/** 抽象化一条技巧草稿的选项。 */
export interface AbstractDraftOptions {
  /** 项目私有标识（通常由 {@link identifiersFromPaths} 从工作区路径推导）。 */
  identifiers?: readonly string[]
  /** 是否启用自动识别；默认关闭（会误伤库符号）。 */
  autoDetect?: boolean
  /** 示例行数上限。 */
  exampleMaxLines?: number
  /** 示例字符数上限。 */
  exampleMaxChars?: number
  /**
   * 证据链覆盖。
   *
   * 提供时**替换**草稿自带的证据（会话反思用会话来源，代码挖掘用代码来源）；
   * 不提供则保留草稿原有证据。
   */
  evidence?: readonly TechniqueEvidence[]
}

/**
 * 对一条技巧草稿做去标识化与限额收敛。
 *
 * 这是「入库的是知识，不是代码」原则的执行点：所有进入全局域的技巧都必须经过这里，
 * 把项目私有标识换成种类化占位符，并把示例压到硬上限内。
 *
 * @param draft - 待处理的技巧草稿。
 * @param options - 抽象化选项。
 * @returns 可落盘的草稿。
 */
export function abstractTechniqueDraft(
  draft: TechniqueDraft,
  options: AbstractDraftOptions = {},
): TechniqueDraft {
  const identifiers = options.identifiers ?? []
  const run = (text: string): string =>
    abstractText(text, {
      identifiers,
      ...(options.autoDetect === true ? { autoDetect: true } : {}),
    }).text

  const maxLines = options.exampleMaxLines ?? 8
  const maxChars = options.exampleMaxChars ?? 480
  const example = draft.example === undefined
    ? undefined
    : { ...draft.example, code: clipExample(run(draft.example.code), maxLines, maxChars) }

  return {
    ...draft,
    name: run(draft.name),
    // gist 会出现在检索结果与展开正文里，必须和 name/when/summary 走同一条脱敏管线：
    // `...draft` 只负责保留字段，不做脱敏，漏掉这里等于给私有标识开一条旁路。
    ...(draft.gist === undefined ? {} : { gist: run(draft.gist) }),
    when: run(draft.when),
    summary: run(draft.summary),
    ...(draft.steps === undefined ? {} : { steps: draft.steps.map(run) }),
    // 逻辑卡的四个新字段都是自由文本，必须和 name/summary 走同一条管线：
    // `location` 尤其危险（它会带路径），漏了就等于给私有路径开旁路。
    ...(draft.subject === undefined ? {} : { subject: run(draft.subject) }),
    ...(draft.location === undefined ? {} : { location: run(draft.location) }),
    ...(draft.reuse === undefined ? {} : { reuse: run(draft.reuse) }),
    ...(draft.appliesTo === undefined ? {} : { appliesTo: run(draft.appliesTo) }),
    ...(draft.invariants === undefined ? {} : { invariants: draft.invariants.map(run) }),
    ...(draft.api === undefined
      ? {}
      : {
        api: draft.api.map(surface => ({
          symbol: run(surface.symbol),
          ...(surface.signature === undefined ? {} : { signature: run(surface.signature) }),
          ...(surface.notes === undefined ? {} : { notes: run(surface.notes) }),
        })),
      }),
    ...(example === undefined ? {} : { example }),
    pitfalls: draft.pitfalls.map(run),
    verify: draft.verify.map(run),
    tags: draft.tags.map(run),
    ...(draft.domain === undefined ? {} : { domain: run(draft.domain) }),
    sensitivity: draft.sensitivity ?? 'internal',
    ...(options.evidence === undefined ? {} : { evidence: [...options.evidence] }),
  }
}

/** 示例的硬上限：行数与字符数双重收敛。 */
function clipExample(code: string, maxLines: number, maxChars: number): string {
  const lines = code.split(/\r?\n/u).slice(0, Math.max(1, maxLines)).join('\n').trim()
  return lines.length <= maxChars ? lines : lines.slice(0, Math.max(0, maxChars - 1))
}

// ---- 泄漏校验（P3） ---------------------------------------------------------

/** 泄漏校验结果。 */
export interface LeakReport {
  /** 与来源逐字重合的长片段（词序列）。 */
  verbatimRuns: string[]
  /** 仍然残留的项目私有标识。 */
  identifierHits: string[]
}

/** 默认的最小连续词数：短于它的重合属于通用措辞，不视为抄录。 */
export const DEFAULT_LEAK_RUN = 8

/**
 * 把文本切成**保序**的词序列。
 *
 * 与 `recall.ts` 的 BM25 `tokenize` 不同：那个会去停用词、切 bigram，丢失顺序，
 * 无法用于「连续片段是否逐字照抄」的判断。
 *
 * @param text - 任意文本。
 * @returns 小写词序列。
 */
export function wordSequence(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]/gu) ?? []
}

/**
 * 泄漏校验：知识里不得出现来源代码的逐字长片段，也不得残留项目私有标识。
 *
 * 为什么需要它：模型被要求「重建而非抄录」，但提示词约束不是硬保证。
 * 一旦逐字抄录，就会把项目实现（甚至客户端代码）带进全局域 ——
 * 这既是隐私问题也是许可问题，所以必须是**可测试的硬闸门**。
 *
 * @param candidate - 待入库的文本（名称/说明/示例等拼在一起）。
 * @param source - 来源代码文本。
 * @param identifiers - 项目私有标识。
 * @param minRun - 判定合规的连续词数阈值。
 * @returns 泄漏报告；两项都为空表示通过。
 */
export function leakCheck(
  candidate: string,
  source: string,
  identifiers: readonly string[] = [],
  minRun: number = DEFAULT_LEAK_RUN,
): LeakReport {
  const sourceWords = wordSequence(source)
  const candidateWords = wordSequence(candidate)
  const verbatimRuns: string[] = []

  if (candidateWords.length >= minRun && sourceWords.length >= minRun) {
    const sourceGrams = new Set<string>()
    for (let index = 0; index + minRun <= sourceWords.length; index += 1) {
      sourceGrams.add(sourceWords.slice(index, index + minRun).join(' '))
    }
    for (let index = 0; index + minRun <= candidateWords.length; index += 1) {
      const gram = candidateWords.slice(index, index + minRun).join(' ')
      if (sourceGrams.has(gram) && !verbatimRuns.includes(gram)) verbatimRuns.push(gram)
    }
  }

  return { verbatimRuns, identifierHits: findIdentifierLeaks(candidate, identifiers) }
}

/**
 * 判断泄漏报告是否通过。
 * @param report - 泄漏报告。
 * @returns 无泄漏时为 `true`。
 */
export function isClean(report: LeakReport): boolean {
  return report.verbatimRuns.length === 0 && report.identifierHits.length === 0
}
