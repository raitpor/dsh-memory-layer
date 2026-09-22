/**
 * 按相关度召回本地记忆：纯本地 BM25，零依赖、零模型调用。
 *
 * 中文按相邻二字切 bigram、拉丁文与数字按词切分，使中英混排的记忆都能被关键词命中；
 * 打分用标准 BM25（k1=1.2, b=0.75），并对命中来源做层级与新鲜度加权。
 *
 * 技巧层（technique）复用同一个 BM25 内核，但多两道处理：
 *
 * 1. **先过滤后打分**：技术栈不匹配、状态为草稿、分区不同的记录直接排除；
 * 2. **再乘置信度**：采用成功/失败计数、证据有无、调用名精确命中都会影响最终排序。
 *
 * @module dsh-memory-layer/recall
 */

import { episodicText, semanticText, techniqueText } from './store.js'
import { techniqueSymbols } from './technique.js'
import { stacksCompatible } from './stack/index.js'
import type {
  EpisodicRecord,
  RecallMeta,
  RecalledMemory,
  SemanticRecord,
  StackProfile,
  TechniqueRecord,
} from './types.js'

/** BM25 词频饱和参数。 */
export const BM25_K1 = 1.2

/** BM25 文档长度归一化参数。 */
export const BM25_B = 0.75

/** 情景层相对语义层的基础权重：长期事实比一次性摘要更值得注入。 */
export const EPISODIC_WEIGHT = 0.85

/** 技巧层权重：它是可直接执行的操作，理应高于一次性摘要。 */
export const TECHNIQUE_WEIGHT = 1.0

/** 汉字区段：CJK 统一表意文字及其扩展 A、兼容区。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u

/** 需要被丢弃的停用词（英文常见虚词与中文高频虚词）。 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'without', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your',
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '与', '就', '都', '也', '还',
  '把', '被', '给', '对', '从', '到', '而', '但', '如果', '那么', '这个', '那个', '一个', '我们',
])

/**
 * 把一段文本切成检索 token：拉丁词按空白与标点切、保留数字，中文切相邻二字。
 * @param text - 任意文本。
 * @returns 去停用词后的 token 数组（保留重复，供词频统计使用）。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  const cjkRun: string[] = []
  let latinRun = ''

  const flushLatin = (): void => {
    if (latinRun.length >= 2 && !STOP_WORDS.has(latinRun)) tokens.push(latinRun)
    else if (latinRun.length === 1 && /\d/u.test(latinRun)) tokens.push(latinRun)
    latinRun = ''
  }
  const flushCjk = (): void => {
    if (cjkRun.length === 1) tokens.push(cjkRun[0] as string)
    for (let index = 0; index + 1 < cjkRun.length; index += 1) {
      const bigram = `${cjkRun[index]}${cjkRun[index + 1] as string}`
      if (!STOP_WORDS.has(bigram)) tokens.push(bigram)
    }
    cjkRun.length = 0
  }

  for (const char of lower) {
    if (CJK_RE.test(char)) {
      flushLatin()
      cjkRun.push(char)
      continue
    }
    flushCjk()
    if (/[a-z0-9_]/u.test(char)) {
      latinRun += char
      continue
    }
    flushLatin()
  }
  flushCjk()
  flushLatin()
  return tokens
}

/** 一篇待检索的文档：层级、id、时间与可检索文本。 */
export interface RecallDoc {
  /** 记忆层级。 */
  layer: 'episodic' | 'semantic' | 'technique'
  /** 记录 id。 */
  id: string
  /** 记录写入时间（Unix 毫秒）。 */
  ts: number
  /** 可检索文本。 */
  text: string
  /** 技巧层专用元信息；其余层不携带。 */
  meta?: RecallMeta
}

/**
 * 把两层记忆转成待检索文档。
 * @param episodic - 情景层记录。
 * @param semantic - 语义层记录。
 * @returns 文档数组。
 */
export function toDocs(
  episodic: readonly EpisodicRecord[],
  semantic: readonly SemanticRecord[],
): RecallDoc[] {
  return [
    ...episodic.map(record => ({
      layer: 'episodic' as const,
      id: record.id,
      ts: record.ts,
      text: episodicText(record),
    })),
    ...semantic.map(record => ({
      layer: 'semantic' as const,
      id: record.id,
      ts: record.updatedAt,
      text: semanticText(record),
    })),
  ]
}

/**
 * 把技巧记录转成待检索文档，并附带过滤/加权所需的元信息。
 * @param records - 技巧记录。
 * @returns 文档数组。
 */
export function toTechniqueDocs(records: readonly TechniqueRecord[]): RecallDoc[] {
  return records.map(record => ({
    layer: 'technique' as const,
    id: record.id,
    ts: record.updatedAt,
    text: techniqueText(record),
    meta: {
      status: record.status,
      sensitivity: record.sensitivity,
      partition: record.partition,
      stack: record.stack,
      symbols: techniqueSymbols(record),
      successes: record.successes,
      failures: record.failures,
      evidenceCount: record.evidence.length,
      ...(record.domain === undefined ? {} : { domain: record.domain }),
    },
  }))
}

/** 打分选项。 */
interface ScoreOptions {
  /** 当前时间（Unix 毫秒）。 */
  now: number
  /** 新鲜度权重。 */
  recencyWeight: number
}

/**
 * BM25 内核：对文档集合打分。
 *
 * 查询为空时退化为「按时间倒序」，得分一律为 0（由调用方决定如何加权）；
 * 查询命中为零时返回空数组。
 *
 * @param query - 检索词。
 * @param docs - 待检索文档。
 * @param options - 时间与新鲜度。
 * @returns 文档与得分的对应（已按得分倒序、时间倒序）。
 */
function scoreDocs(
  query: string,
  docs: readonly RecallDoc[],
  options: ScoreOptions,
): { doc: RecallDoc; score: number }[] {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) {
    return [...docs]
      .sort((left, right) => right.ts - left.ts)
      .map(doc => ({ doc, score: 0 }))
  }

  const docTokens = docs.map(doc => tokenize(doc.text))
  const lengths = docTokens.map(tokens => tokens.length)
  const avgLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length)
  const documentFrequency = new Map<string, number>()
  const queryUnique = [...new Set(queryTokens)]

  for (const tokens of docTokens) {
    const seen = new Set(tokens)
    for (const token of queryUnique) {
      if (seen.has(token)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }

  const total = docs.length
  const scored: { doc: RecallDoc; score: number }[] = []
  for (const [index, doc] of docs.entries()) {
    const tokens = docTokens[index] as string[]
    const length = lengths[index] as number
    if (length === 0) continue
    const frequencies = new Map<string, number>()
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)

    let score = 0
    for (const token of queryUnique) {
      const frequency = frequencies.get(token)
      if (frequency === undefined) continue
      const df = documentFrequency.get(token) ?? 0
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
      const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * (length / avgLength))
      score += idf * ((frequency * (BM25_K1 + 1)) / denominator)
    }
    if (score <= 0) continue
    score *= 1 + options.recencyWeight * recencyFactor(options.now - doc.ts)
    scored.push({ doc, score })
  }

  return scored.sort((left, right) => right.score - left.score || right.doc.ts - left.doc.ts)
}

/**
 * 对文档集合执行 BM25 召回。
 *
 * 查询为空时退化为「按时间倒序取最近记忆」；查询命中为零时返回空数组，
 * 由调用方决定是回退到最近记忆还是不注入任何内容。
 *
 * @param query - 用户当前的检索词（通常是本次用户消息）。
 * @param docs - 待检索文档。
 * @param options - 返回条数上限与新鲜度加权开关。
 * @returns 按得分倒序的召回结果。
 */
export function recall(
  query: string,
  docs: readonly RecallDoc[],
  options: { limit?: number; now?: number; recencyWeight?: number } = {},
): RecalledMemory[] {
  const limit = options.limit ?? 5
  if (limit <= 0 || docs.length === 0) return []
  const scored = scoreDocs(query, docs, {
    now: options.now ?? Date.now(),
    recencyWeight: options.recencyWeight ?? 0.15,
  })
  return scored
    .map(entry => ({
      layer: entry.doc.layer,
      id: entry.doc.id,
      score: entry.doc.layer === 'episodic' ? entry.score * EPISODIC_WEIGHT : entry.score * TECHNIQUE_WEIGHT,
      text: entry.doc.text,
      ts: entry.doc.ts,
      ...(entry.doc.meta === undefined ? {} : { meta: entry.doc.meta }),
    }))
    .sort((left, right) => right.score - left.score || right.ts - left.ts)
    .slice(0, limit)
}

/** 技巧召回的额外选项。 */
export interface TechniqueRecallOptions {
  /** 返回条数上限。 */
  limit?: number
  /** 当前时间。 */
  now?: number
  /** 新鲜度权重；知识衰减比会话慢，默认更低。 */
  recencyWeight?: number
  /** 当前项目栈；不匹配的记录被**硬过滤**。 */
  stack?: StackProfile
  /** 当前分区；与记录分区不一致时过滤。 */
  partition?: string
  /** 是否包含草稿；工具显式检索时为 `true`，自动注入时为 `false`。 */
  includeDrafts?: boolean
  /** 当前上下文中出现的调用名，命中则显著加权。 */
  symbols?: readonly string[]
}

/**
 * 技巧层召回：先按「状态 / 分区 / 技术栈」硬过滤，再用 BM25 + 置信度排序。
 *
 * 过滤先于打分是刻意的 —— 不适用的技巧不该因为关键词命中就挤进注入配额，
 * 这是「默认全局」下保证精度的核心机制。
 *
 * @param query - 检索词。
 * @param docs - 待检索文档（技巧层）。
 * @param options - 过滤与加权选项。
 * @returns 按最终得分倒序的召回结果。
 */
export function recallTechniques(
  query: string,
  docs: readonly RecallDoc[],
  options: TechniqueRecallOptions = {},
): RecalledMemory[] {
  const limit = options.limit ?? 5
  if (limit <= 0) return []
  const includeDrafts = options.includeDrafts ?? false
  const now = options.now ?? Date.now()
  const symbols = new Set(options.symbols ?? [])

  const candidates = docs.filter(doc => {
    if (doc.layer !== 'technique') return false
    const meta = doc.meta
    if (meta === undefined) return false
    if (!includeDrafts && meta.status !== 'validated' && meta.status !== 'canonical') return false
    if (meta.status === 'deprecated') return false
    if (options.partition !== undefined && meta.partition !== undefined && meta.partition !== options.partition) {
      return false
    }
    return stacksCompatible(meta.stack, options.stack)
  })
  if (candidates.length === 0) return []

  const scored = scoreDocs(query, candidates, {
    now,
    recencyWeight: options.recencyWeight ?? 0.05,
  })
  const emptyQuery = tokenize(query).length === 0
  const lowerQuery = query.toLowerCase()

  return scored
    .map(entry => {
      const meta = entry.doc.meta
      const successes = meta?.successes ?? 0
      const failures = meta?.failures ?? 0
      const confidence = (successes + 1) / (successes + failures + 2)
      const evidenceBonus = (meta?.evidenceCount ?? 0) > 0 ? 1.1 : 0.6
      const symbolHit = (meta?.symbols ?? []).some(symbol => symbols.has(symbol))
      const symbolBonus = symbolHit ? 1.6 : 1
      const domainBonus = meta?.domain !== undefined && lowerQuery.includes(meta.domain.toLowerCase()) ? 1.2 : 1
      const base = entry.score > 0 || emptyQuery ? (entry.score > 0 ? entry.score : 1) : 0
      return {
        layer: entry.doc.layer,
        id: entry.doc.id,
        score: base * TECHNIQUE_WEIGHT * confidence * evidenceBonus * symbolBonus * domainBonus,
        text: entry.doc.text,
        ts: entry.doc.ts,
        ...(meta === undefined ? {} : { meta }),
      }
    })
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.ts - left.ts)
    .slice(0, limit)
}

/** 把「距今多久」映射到 0–1 的新鲜度系数：一天内接近 1，30 天后接近 0。 */
function recencyFactor(ageMs: number): number {
  const day = 24 * 60 * 60 * 1000
  const age = Math.max(0, ageMs) / day
  return 1 / (1 + age / 7)
}
