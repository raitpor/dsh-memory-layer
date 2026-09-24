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
  MemoryScope,
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
 * @param scope - 这批记录来自哪个作用域（调用方按**读取的桶**给出）。
 * @returns 文档数组。
 */
export function toDocs(
  episodic: readonly EpisodicRecord[],
  semantic: readonly SemanticRecord[],
  scope?: MemoryScope,
): RecallDoc[] {
  return [
    ...episodic.map(record => ({
      layer: 'episodic' as const,
      id: record.id,
      ts: record.ts,
      text: episodicText(record),
      // 带出 sessionId 供**自动注入**判定「这是不是本会话自己的摘要」；
      // 显式检索（`memory_search`）不看这个字段，仍能搜到本会话的记录。
      meta: { sessionId: record.sessionId, ...(scope === undefined ? {} : { scope }) },
    })),
    // `kind` 必须带出去：标签要按它区分偏好/决定/约束，否则一律显示成「长期事实」，
    // 模型会把用户偏好当成客观事实（见 `recallLabel`）。
    ...semantic.map(record => ({
      layer: 'semantic' as const,
      id: record.id,
      ts: record.updatedAt,
      text: semanticText(record),
      meta: {
        kind: record.kind,
        // 已被新版本取代的事实仍然可检索，但自动注入要跳过它（见 `renderInjection`）。
        ...(record.supersededBy === undefined ? {} : { superseded: true }),
        ...(scope === undefined ? {} : { scope }),
      },
    })),
  ]
}

/**
 * 把技巧记录转成待检索文档，并附带过滤/加权所需的元信息。
 * @param records - 技巧记录。
 * @param scope - 这批记录来自哪个作用域（调用方按**读取的桶**给出）。
 * @returns 文档数组。
 */
export function toTechniqueDocs(records: readonly TechniqueRecord[], scope?: MemoryScope): RecallDoc[] {
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
      tags: record.tags,
      ...(record.domain === undefined ? {} : { domain: record.domain }),
      ...(record.appliesTo === undefined ? {} : { appliesTo: record.appliesTo }),
      ...(scope === undefined ? {} : { scope }),
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

/** facet 子查询的数量上限。 */
export const MAX_FACETS = 8

/**
 * 外部打分器：给定一次查询，返回按相关度倒序的 id。
 *
 * 存在的意义是让**索引后端可选**：SQLite/FTS5 路径给出 id 列表，未提供或返回 `undefined`
 * 时由本模块用内存 BM25 顶上 —— 回退是自动的，调用方不必判断后端状态。
 */
export type TechniqueScorer = (query: string, limit: number) => string[] | undefined

/**
 * 把一段任务描述切成若干 **facet 子查询**（零模型、纯词法）。
 *
 * 存在的理由来自实测：单意图查询用 BM25 已经能排到第 1，但**任务型**描述（"新增一种折扣类型，
 * 走完整结算流程，最后补流程图和测试"）一句话里含多个主题，一次查询只能命中其中一个 ——
 * 实测那道多 facet 查询漏掉 6/11 条。模型当时的应对是**自己换四种措辞检索四次**，代价是
 * 16.8k token。切 facet 就是把这一步自动化。
 *
 * 两类来源：
 * 1. **子句切分**：按标点与并列连词切开（保守，只切明确的分隔符）；
 * 2. **语料词表**：把语料里出现过的主题词（标签 / 领域 / 调用面的末段）里，**在查询中出现的**
 *    那些词各自作为一次查询 —— 词表是封闭集合，因此不会凭空造出无关子查询。
 *
 * @param query - 任务描述或普通查询。
 * @param docs - 当前语料（用于取词表）。
 * @param extra - 额外的结构化查询词（当前轮触达的文件、调用名、工具名）。
 * @returns 去重后的子查询（含原查询本身，且原查询排第一）。
 */
export function facetQueries(
  query: string,
  docs: readonly RecallDoc[],
  extra: readonly string[] = [],
): string[] {
  // 原查询永远是第一个 —— **哪怕是空串**：空查询在 `recallTechniques` 里会退化为
  // 「按时间取最近记忆」，facet 化不能把这个既有语义弄丢（去掉它会让空查询变成"什么都不注入"）。
  const out: string[] = [query]
  const push = (value: string): void => {
    const text = value.replace(/\s+/gu, ' ').trim()
    if (text.length >= 2 && !out.includes(text)) out.push(text)
  }

  // 1) 子句切分：标点 + 并列连词。连词只在「两侧都是 ≥2 个汉字」时才切，
  //    避免把「和平」「以及时」这类词内部切开；即便如此仍可能误切，那也只是多一个子查询。
  const separated = query.replace(
    /(?<=[\u4e00-\u9fa5]{2})(?:并且|以及|同时|然后|最后|和|与|及|或)(?=[\u4e00-\u9fa5]{2})/gu,
    '\u0000',
  )
  for (const clause of separated.split(/[\u0000，,；;。\n]/u)) push(clause)

  // 2) 语料词表：标签、领域、调用面末段 —— 只取在查询里真实出现的。
  const vocabulary = new Set<string>()
  for (const doc of docs) {
    const meta = doc.meta
    if (meta === undefined) continue
    if (meta.domain !== undefined) vocabulary.add(meta.domain)
    for (const tag of meta.tags ?? []) if (tag.length >= 2) vocabulary.add(tag)
    for (const symbol of meta.symbols ?? []) {
      const tail = symbol.split(/[.#]/u).at(-1)
      if (tail !== undefined && tail.length >= 3) vocabulary.add(tail)
    }
  }
  const lower = query.toLowerCase()
  for (const term of vocabulary) {
    if (term.length >= 2 && lower.includes(term.toLowerCase())) push(term)
  }

  // 3) 结构化词：文件路径末段与调用名本身就是极强的键。
  for (const value of extra) {
    for (const token of value.split(/[\\/]+/u)) {
      if (token.length >= 4) push(token)
    }
  }
  // 上限：子查询是线性成本（每个都要打一次分），必须封顶。
  return out.slice(0, MAX_FACETS)
}

/**
 * 多 facet 召回：每个子查询各算一次，**轮转交错**合并去重。
 *
 * 合并算法是这里唯一要紧的取舍：
 * - 按分数合并不可行 —— BM25 原始分跨查询不可比（长查询分天然高），会系统性偏向最长子查询；
 * - 按最好名次合并也不够 —— 实测会把"某个 facet 的第 2 名"排到"另一个 facet 的第 1 名"之后，
 *   于是前 5 条被少数 facet 占满，剩下几个 facet **整块消失**（这正是要修的病）；
 * - 轮转交错（第 1 轮取每个 facet 的第 1 名，第 2 轮取第 2 名……）保证**每个 facet 先占一个位置**，
 *   再按名次加深。它优化的是「覆盖几个主题」，而那才是任务型查询的真正需求。
 *
 * 入口只收**原始查询**，切分在这里做：调用方（工具与注入路径）不该知道 facet 这回事，
 * 否则「一句话覆盖多个主题」就变成了调用方的责任。
 *
 * @param query - 原始任务描述或查询。
 * @param docs - 语料。
 * @param options - 与 {@link recallTechniques} 相同的过滤/加权选项，外加结构化补充词 `extra`。
 * @returns 合并后的召回结果。
 */
export function recallFacets(
  query: string,
  docs: readonly RecallDoc[],
  options: TechniqueRecallOptions & { extra?: readonly string[]; scorer?: TechniqueScorer } = {},
): RecalledMemory[] {
  const limit = options.limit ?? 5
  if (limit <= 0) return []
  const queries = facetQueries(query, docs, options.extra ?? [])
  if (queries.length === 0) return []
  // 每个子查询多取一些：交错时要按轮次取到较深的位次。
  const depth = Math.max(limit, 10)
  const byId = new Map(docs.map(doc => [doc.id, doc]))
  const perQuery = queries.map(sub => {
    const ids = options.scorer?.(sub, depth)
    // 打分器给了结果就用它；没给（不可用/无 token/出错）就地回退内存 BM25。
    if (ids === undefined) return recallTechniques(sub, docs, { ...options, limit: depth })
    return ids
      .map((id, index) => {
        const doc = byId.get(id)
        if (doc === undefined) return undefined
        return {
          layer: doc.layer,
          id,
          // 名次分：跨后端/跨子查询的原始分不可比，顺序才是要保住的信息。
          score: 1 / (index + 1),
          text: doc.text,
          ts: doc.ts,
          ...(doc.meta === undefined ? {} : { meta: doc.meta }),
        } satisfies RecalledMemory
      })
      .filter((hit): hit is RecalledMemory => hit !== undefined)
  })
  return mergeInterleaved(perQuery, limit)
}

/**
 * 轮转交错合并多路召回：第 1 轮取每路的第 1 名，第 2 轮取第 2 名……
 *
 * 这是 facet 覆盖的关键算法，情景/语义层与技巧层共用同一份实现 ——
 * 两处各写一遍必然走样（改一处忘一处），所以抽成单一事实来源。
 *
 * @param hitLists - 每个子查询各自的召回结果（已按相关度排序）。
 * @param limit - 合并后的条数上限。
 * @returns 合并去重后的结果。
 */
export function mergeInterleaved(hitLists: readonly (readonly RecalledMemory[])[], limit: number): RecalledMemory[] {
  const out: RecalledMemory[] = []
  const seen = new Set<string>()
  const depth = Math.max(0, ...hitLists.map(hits => hits.length))
  for (let round = 0; round < depth && out.length < limit; round += 1) {
    for (const hits of hitLists) {
      const hit = hits[round]
      if (hit === undefined || seen.has(hit.id)) continue
      seen.add(hit.id)
      out.push(hit)
      if (out.length >= limit) break
    }
  }
  return out
}

/**
 * 面向**任意层**（情景 / 语义 / 技巧）的 facet 召回。
 *
 * 技巧层有 `recallTechniques` 那一套过滤与加权，这里走通用 {@link recall}：
 * 情景/语义层同样会"一句话讲了好几件事"，单查询只能命中其中一件 ——
 * 和技巧层实测到的是同一个病，因此共用同一套切分与合并。
 *
 * @param query - 查询文本。
 * @param docs - 语料。
 * @param options - 通用召回选项，外加结构化补充词 `extra`。
 * @returns 合并后的召回结果。
 */
export function recallDocsFacets(
  query: string,
  docs: readonly RecallDoc[],
  options: { limit?: number; now?: number; recencyWeight?: number; extra?: readonly string[] } = {},
): RecalledMemory[] {
  const limit = options.limit ?? 5
  if (limit <= 0 || docs.length === 0) return []
  const queries = facetQueries(query, docs, options.extra ?? [])
  // 每个子查询多取一些：交错合并要按轮次取到较深的位次。
  const perQuery = queries.map(sub => recall(sub, docs, { ...options, limit: Math.max(limit, 10) }))
  return mergeInterleaved(perQuery, limit)
}
