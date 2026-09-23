/**
 * 技巧层的领域逻辑：置信度、状态迁移、调用面索引与展示。
 *
 * 这里不碰磁盘 —— 存储读写在 `store.ts`，召回打分在 `recall.ts`，
 * 本模块只做「一条技巧该怎么算、该处于什么状态」这类纯函数判断，便于单独测试。
 *
 * @module dsh-memory-layer/technique
 */

import { STATUS_RANK } from './store.js'
import { stacksCompatible, stackSummary } from './stack/index.js'
import type { StackProfile, TechniqueDraft, TechniqueRecord, TechniqueStatus, TechniqueVerification } from './types.js'

/** 采用结果：由 `technique_apply` 工具或会话末自动关联回报。 */
export type TechniqueOutcome = 'success' | 'failure'

/** 连续失败达到该次数且多于成功次数时，记录被标记为 `deprecated`。 */
export const DEPRECATE_AFTER_FAILURES = 2

/** 成功次数达到该值、无失败、且有代码证据时，可提升为 `canonical`。 */
export const PROMOTE_AFTER_SUCCESSES = 3

/** 验收证据的最短长度：短于此不可能同时说清「检查什么」和「看到什么」。 */
export const MIN_VERIFICATION_CHARS = 12

/** 每条技巧保留的验收记录条数上限（最新在前）。 */
export const MAX_VERIFICATIONS = 5

/**
 * 单条验收证据的**落盘**字符上限。
 *
 * 证据会在 `technique_get` 里原样回显、并被反复注入上下文，因此必须有界 ——
 * 与库内其他正文字段（示例行数/字符数、`captureAssistantChars`）同一口径。
 * 上限只约束**落盘文本**：校验仍然看全文，免得把写在末尾的具体锚点截掉后反被判为不合格。
 */
export const MAX_VERIFICATION_CHARS = 400

/** 检索行里 `gist` 的字符上限。 */
export const GIST_MAX_CHARS = 90

/** 检索行里 id 的短前缀长度：够唯一，又比 40 字符的完整 id 省得多。 */
export const ID_PREFIX_CHARS = 8

/**
 * 结论词词汇表。
 *
 * 判定方式不是「整串等于某个结论词」，而是「去掉数字与标点后**只剩下这些词的拼接**」——
 * 旧的整串匹配放在 {@link MIN_VERIFICATION_CHARS} 之后，而无一条备选能达到 12 字，
 * 于是这条判定永远走不到（DEF-17，白盒覆盖率发现）。长词排在短词前
 * （如 `有效果` 先于 `有效`），避免前半段被吃掉后剩下半个词。
 */
const VERIFICATION_FILLER_WORD = /(?:ok|okay|fine|good|done|works?|worked|success|confirmed|pass(?:ed)?|正常|没问题|没毛病|无异常|成功|有效果|有效|通过|已采用|已使用|已应用|符合预期|效果良好|工作正常|一切正常)/giu

/** 判断证据时的噪声：数字、百分号、各类标点与空白。 */
const EVIDENCE_NOISE = /[\d%.,，。！!；;、:：\s"'`()（）[\]【】{}<>/\\|~-]/gu

/**
 * 判断一段文本是否**只是结论词的拼接**（可以带数字与标点）。
 *
 * 这类文本的共同点是不可证伪：任何结果都能套上去，因此不构成观测。
 * 只做到「机械可判」为止 —— 是否真的支撑结论属于语义判断，交给读者。
 *
 * @param value - 已规范化的证据文本。
 * @returns 内容为空洞结论时为 `true`。
 */
function isContentFreeVerdict(value: string): boolean {
  const stripped = value.replace(EVIDENCE_NOISE, '')
  // 只剩数字与标点**不是**结论词：`240/240` 这种纯计数可能是真观测，应交给后面的
  // 长度与锚点闸门判断（否则「太短」闸门就永远没有活路，DEF-17 的同类错误）。
  if (stripped.length === 0) return false
  return stripped.replace(VERIFICATION_FILLER_WORD, '').length === 0
}

/**
 * 证据里至少要有的一类**具体锚点**：数字、被反引号/引号包住的记号，或路径式记号。
 *
 * 这是「可证伪」的可机械检查的那一半 —— 有了具体锚点，别人才能照着复核；
 * 至于锚点是否真的支撑结论，只能由读者判断（这里刻意不做语义判定）。
 */
const VERIFICATION_ANCHOR = /\d|`[^`]+`|"[^"]+"|'[^']+'|\S+\/\S+|\.\w{2,6}\b/u

/** 证据校验结果。 */
export type EvidenceCheck =
  | { ok: true; value: string }
  | { ok: false; reason: string }

/**
 * 校验一条验收证据是否达到「可证伪」的下限。
 *
 * 四道闸门：非空、不是空洞结论、够长、含至少一个具体锚点。顺序刻意把「空洞结论」
 * 放在长度之前：短结论词应得到准确的理由，而不是被含糊地报成「太短」。
 *
 * 这是**下限而非证明**：通过校验只说明这条证据有被复核的可能。
 * 已知残余缺口：带数字的结论词（如「确认无误，一切正常 2 次」）仍会通过 ——
 * 堵住它必须做语义判断，而误判的代价是把真证据挡在门外，因此刻意不做（见测试用例
 * `空洞结论的机械下限` 里被显式记录为「已知可通过」的那条）。
 *
 * @param input - 模型提交的 `evidence` 字段。
 * @returns 通过时给出规范化文本，否则给出可直接回给模型的原因。
 */
export function checkVerificationEvidence(input: unknown): EvidenceCheck {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'evidence must be a string' }
  }
  const value = input.replace(/\s+/gu, ' ').trim()
  if (value.length === 0) {
    return { ok: false, reason: 'evidence is empty' }
  }
  if (isContentFreeVerdict(value)) {
    return { ok: false, reason: 'evidence is a content-free verdict — it would read the same for any outcome' }
  }
  if (value.length < MIN_VERIFICATION_CHARS) {
    return { ok: false, reason: `evidence is too short (${value.length} < ${MIN_VERIFICATION_CHARS} characters)` }
  }
  if (!VERIFICATION_ANCHOR.test(value)) {
    return {
      ok: false,
      reason: 'evidence names no concrete observation (a count, a quoted token, a path or a URL)',
    }
  }
  return { ok: true, value }
}

/**
 * 把验收证据收敛到 {@link MAX_VERIFICATION_CHARS}。
 *
 * 与校验分开是刻意的：**先校验全文、再收敛落盘文本**。若在校验前截断，写在末尾的
 * 具体锚点会被截掉，一条本来合格的证据反而被拒。
 *
 * @param text - 已通过校验（并已过安全管线）的证据文本。
 * @returns 不超过上限的文本，被截断时以省略号收尾。
 */
export function clampVerificationEvidence(text: string): string {
  if (text.length <= MAX_VERIFICATION_CHARS) return text
  return `${text.slice(0, MAX_VERIFICATION_CHARS - 1)}…`
}

/**
 * 取一条技巧的「一句话可执行要点」。
 *
 * 显式给了 `gist` 就用它；否则取 `summary` 的首句并按 {@link GIST_MAX_CHARS} 截断。
 * 派生而非必填，是为了让所有既有记录与提炼产出**自动**获得可用的检索行。
 *
 * @param record - 技巧记录或草稿。
 * @returns 非空的一行要点。
 */
export function gistOf(record: Pick<TechniqueRecord, 'summary'> & Pick<TechniqueDraft, 'gist'>): string {
  const explicit = record.gist?.replace(/\s+/gu, ' ').trim() ?? ''
  const source = explicit.length > 0 ? explicit : firstSentence(record.summary)
  return source.length <= GIST_MAX_CHARS ? source : `${source.slice(0, GIST_MAX_CHARS - 1)}…`
}

/**
 * 取 `summary` 的首句。
 * @param summary - 主体说明。
 * @returns 首句（无句读时即全文）。
 */
function firstSentence(summary: string): string {
  const flat = summary.replace(/\s+/gu, ' ').trim()
  const match = /^.*?[。．.!！?？;；]/u.exec(flat)
  return (match?.[0] ?? flat).trim()
}

/**
 * 计算一条技巧的置信度（拉普拉斯平滑，落在 0–1）。
 *
 * 用「实际采用结果」而非「被召回次数」作为依据：被召回不代表有用，
 * 被采用且成功才算数。
 *
 * @param record - 技巧记录。
 * @returns 置信度。
 */
export function confidenceOf(record: TechniqueRecord): number {
  return (record.successes + 1) / (record.successes + record.failures + 2)
}

/**
 * 依据计数推导「应处的状态」（不会降级，由调用方与现值取高）。
 *
 * `canonical` 额外要求**至少一条带证据的验收记录**：三次「用了就算成功」的回报
 * 不构成可复用的结论，只有真的按判据验过才算。
 *
 * @param record - 技巧记录。
 * @returns 推导出的状态。
 */
export function promotedStatus(record: TechniqueRecord): TechniqueStatus {
  if (record.successes >= PROMOTE_AFTER_SUCCESSES
    && record.failures === 0
    && record.evidence.some(item => item.kind === 'code')
    && (record.verifications ?? []).length > 0) {
    return 'canonical'
  }
  if (record.successes >= 1) return 'validated'
  return 'draft'
}

/**
 * 应用一次采用结果，返回新的记录（不修改入参）。
 *
 * 迁移规则：
 * - 成功 → 计数 +1，刷新 `lastVerifiedAt`，可能提升状态；
 * - 失败 → 计数 +1，连续失败超过成功且达到阈值时标记 `deprecated`；
 * - 两种情况都把 {@link TechniqueVerification} 记入 `verifications`（最新在前、有上限）；
 * - `deprecated` 是粘性的，不会被自动提升。
 *
 * @param record - 原记录。
 * @param verification - 本次采用的验收记录（含可证伪证据）。
 * @returns 更新后的记录。
 */
export function applyOutcome(record: TechniqueRecord, verification: TechniqueVerification): TechniqueRecord {
  const { outcome, at } = verification
  const successes = record.successes + (outcome === 'success' ? 1 : 0)
  const failures = record.failures + (outcome === 'failure' ? 1 : 0)
  const updated: TechniqueRecord = {
    ...record,
    applied: record.applied + 1,
    successes,
    failures,
    updatedAt: at,
    verifications: [verification, ...(record.verifications ?? [])].slice(0, MAX_VERIFICATIONS),
  }
  if (outcome === 'success') updated.lastVerifiedAt = at

  if (failures >= DEPRECATE_AFTER_FAILURES && failures > successes) {
    updated.status = 'deprecated'
    return updated
  }
  const promoted = promotedStatus(updated)
  if (STATUS_RANK[promoted] > STATUS_RANK[updated.status]) updated.status = promoted
  return updated
}

/**
 * 取一条技巧的规范化调用名（`api-usage` 的主要检索途径）。
 * @param record - 技巧记录。
 * @returns 调用名数组（保序去重）。
 */
export function techniqueSymbols(record: TechniqueRecord): string[] {
  const out: string[] = []
  for (const surface of record.api ?? []) {
    const symbol = surface.symbol.trim()
    if (symbol.length > 0 && !out.includes(symbol)) out.push(symbol)
  }
  return out
}

/**
 * 建立「调用名 → 技巧 id」索引，供召回时精确命中。
 * @param records - 技巧记录。
 * @returns 符号索引。
 */
export function symbolIndex(records: readonly TechniqueRecord[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const record of records) {
    for (const symbol of techniqueSymbols(record)) {
      const bucket = index.get(symbol)
      if (bucket === undefined) index.set(symbol, [record.id])
      else if (!bucket.includes(record.id)) bucket.push(record.id)
    }
  }
  return index
}

/**
 * 渲染一条技巧的**索引行**：注入 system prompt 与工具输出的共用格式。
 *
 * 只含「名称 / 适用栈 / 触发条件 / id」，不含步骤与示例 —— 细节由 `technique_get` 按需展开，
 * 这是控制上下文成本的关键。
 *
 * @param record - 技巧记录。
 * @returns 单行文本。
 */
export function techniqueIndexLine(record: TechniqueRecord): string {
  const stack = stackSummary(record.stack)
  const parts = [
    record.name,
    stack.length === 0 ? '' : `适用: ${stack}`,
    `何时用: ${record.when}`,
    `id ${record.id}`,
  ]
  if (record.status !== 'draft') parts.splice(1, 0, `[${record.status}]`)
  if (record.conflictsWith !== undefined && record.conflictsWith.length > 0) {
    parts.push(`同一触发下另有做法: ${record.conflictsWith.join(', ')}`)
  }
  return parts.filter(part => part.length > 0).join(' — ')
}

/**
 * 判断一条技巧是否适用于给定的当前栈。
 * @param record - 技巧记录。
 * @param current - 当前项目的观测栈。
 * @returns 适用时为 `true`。
 */
export function techniqueApplies(record: TechniqueRecord, current: StackProfile | undefined): boolean {
  return stacksCompatible(record.stack, current)
}

/** 检索行里技巧名的字符上限。 */
const SEARCH_NAME_MAX_CHARS = 60

/** 尾部索引行里技巧名的字符上限。 */
const TAIL_NAME_MAX_CHARS = 34

/**
 * 检索结果里给**完整信息**（含 gist）的条数上限，其余只给「还存在」的指针。
 *
 * 这是压缩检索开销的主要手段，依据来自实测：同一领域的技巧往往十几条几乎同分，
 * 逐条都给完整信息时模型无从判断该看哪条，于是**全部展开**（实测一次任务里 12 次
 * `technique_get`）。前几条给可执行要点、其余只留 id + 名字，既省下大半字符，
 * 也把「这几条值得先看」这个排序信号显式化。
 */
export const DETAILED_HITS = 3

/**
 * 截断到给定长度，超出时以省略号收尾。
 * @param text - 原文。
 * @param max - 上限字符数。
 * @returns 截断后的文本。
 */
function clampText(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * 取一条技巧 id 的短前缀形式（`tq_` + 前 8 个十六进制字符）。
 *
 * 检索行里用它替代 40 字符的完整 uuid：几百条技巧规模下冲突概率可以忽略，
 * 而每行省下的 30 字符乘以命中条数是检索开销里最直接的一部分。
 *
 * @param id - 完整 id。
 * @returns 短前缀。
 */
export function shortTechniqueId(id: string): string {
  const bare = id.replace(/^tq_/u, '')
  return `tq_${bare.slice(0, ID_PREFIX_CHARS)}`
}

/**
 * 渲染一条**详细检索行**（`technique_search` 命中前 {@link DETAILED_HITS} 条）。
 *
 * 与 {@link techniqueIndexLine} 的分工：那个用于自动注入，只讲「这条讲什么、什么时候用」；
 * 这个用于按需检索，带上 **{@link gistOf} 的一句话做法**，好让模型多数情况下
 * **不必再调 `technique_get`**。触发条件、适用栈与调用面留给展开时看。
 *
 * 刻意不带 BM25 得分：同一领域内这些分数普遍接近，报出来是噪声，而顺序已经是排名。
 *
 * @param record - 技巧记录。
 * @param ordinal - 从 1 开始的序号。
 * @returns 单行文本。
 */
export function techniqueSearchLine(record: TechniqueRecord, ordinal: number): string {
  return [
    `${ordinal}. [${record.status}] ${clampText(record.name, SEARCH_NAME_MAX_CHARS)}`,
    gistOf(record),
    `id ${shortTechniqueId(record.id)}`,
  ].join(' — ')
}

/**
 * 渲染一条**尾部索引行**：只回答「库里还有这些」，不展开做法。
 *
 * 把「候选很多」与「候选里哪几条最该先看」分开付费：模型想细看时按 id 展开。
 *
 * @param record - 技巧记录。
 * @param ordinal - 从 1 开始的序号。
 * @returns 单行文本。
 */
export function techniqueTailLine(record: TechniqueRecord, ordinal: number): string {
  return `${ordinal}. [${record.status}] ${clampText(record.name, TAIL_NAME_MAX_CHARS)} — id ${shortTechniqueId(record.id)}`
}

/** id 解析结果。 */
export type TechniqueResolution =
  | { ok: true; record: TechniqueRecord }
  | { ok: false; reason: string }

/**
 * 用完整 id 或**唯一前缀**解析一条技巧。
 *
 * 前缀解析让检索行不必印完整 uuid。歧义时**不猜**：列出候选让调用方用完整 id 重试 ——
 * 猜错的代价是把结论记到另一条技巧上，比多花一次调用贵得多。
 *
 * @param needle - 完整 id 或前缀（可带 `tq_`，也可不带）。
 * @param records - 候选记录。
 * @returns 解析结果。
 */
export function resolveTechniqueId(needle: unknown, records: readonly TechniqueRecord[]): TechniqueResolution {
  if (typeof needle !== 'string') return { ok: false, reason: 'id must be a string' }
  const wanted = needle.trim()
  if (wanted.length === 0) return { ok: false, reason: 'id must not be empty' }

  const exact = records.find(record => record.id === wanted)
  if (exact !== undefined) return { ok: true, record: exact }

  const bare = wanted.replace(/^tq_/u, '')
  if (bare.length < 4) {
    return { ok: false, reason: `"${wanted}" is too short to identify a technique` }
  }
  const matches = records.filter(record => record.id.replace(/^tq_/u, '').startsWith(bare))
  const first = matches[0]
  if (matches.length === 1 && first !== undefined) return { ok: true, record: first }
  if (first === undefined) return { ok: false, reason: `no technique matches id "${wanted}"` }
  return {
    ok: false,
    reason: `id "${wanted}" is ambiguous (${matches.length} matches: ${matches.slice(0, 3).map(record => shortTechniqueId(record.id)).join(', ')}…) — use a longer prefix`,
  }
}

/**
 * 判断一条技巧是否可以参与**自动注入**：草稿与废弃都不参与。
 * @param record - 技巧记录。
 * @returns 可注入时为 `true`。
 */
export function injectable(record: TechniqueRecord): boolean {
  return record.status === 'validated' || record.status === 'canonical'
}
