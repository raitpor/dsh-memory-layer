/**
 * 本地文件存储：情景层用追加式 JSONL，语义层用可原子替换的 JSON。
 *
 * 存储根目录默认 `<DSH_HOME>/memory-layer`，按作用域分子目录：
 *
 * ```
 * <root>/projects/<slug>-<hash>/episodic.jsonl
 * <root>/projects/<slug>-<hash>/semantic.json
 * <root>/global/episodic.jsonl
 * <root>/global/semantic.json
 * ```
 *
 * 所有写入都先落临时文件再 `rename`，避免进程中断留下半截文件；读写全程零第三方依赖。
 *
 * **加密**：可注入 {@link StoreCodec} 对每一行做加解密（见 `crypto.ts` 的 AES-256-GCM 实现）。
 * 语义层 JSON 也按行加密，因此「一行 = 一个完整载荷」对两种文件都成立。
 * 读取时无法解密的行被跳过而不是让整个库读不出来。
 *
 * @module dsh-memory-layer/store
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { StoreCodec } from './crypto.js'
import { mergeStack } from './stack/index.js'
import type {
  ApiSurface,
  EpisodicRecord,
  FailureRecord,
  MemoryScope,
  ReflectionMetrics,
  SemanticDraft,
  SemanticRecord,
  TechniqueDraft,
  TechniqueEvidence,
  TechniqueRecord,
  TechniqueStatus,
} from './types.js'

/** 情景层 JSONL 文件名。 */
export const EPISODIC_FILE = 'episodic.jsonl'

/** 语义层 JSON 文件名。 */
export const SEMANTIC_FILE = 'semantic.json'

/** 技巧层 JSONL 文件名。 */
export const TECHNIQUE_FILE = 'techniques.jsonl'

/** 失败层 JSONL 文件名。 */
export const FAILURE_FILE = 'failures.jsonl'

/** 反思指标文件名（落在记忆库根目录，跨作用域共享）。 */
export const METRICS_FILE = 'metrics.json'

/** 代码挖掘的增量缓存文件名（落在记忆库根目录）。 */
export const MINE_CACHE_FILE = 'mine-cache.json'

/** 全局域的默认分区名。 */
export const DEFAULT_PARTITION = 'default'

/** 记忆库文件权限：仅属主可读写（防同机其他用户读取会话内容）。 */
export const FILE_MODE = 0o600

/** 记忆库目录权限：仅属主可进入。 */
export const DIRECTORY_MODE = 0o700

/** 单条情景摘要的字符上限，超出即截断，避免单条记录挤爆上下文。 */
export const MAX_SUMMARY_CHARS = 2000

/** 每个作用域保留的情景记录条数上限，超出丢弃最旧的。 */
export const MAX_EPISODIC_PER_SCOPE = 500

/** 每个作用域保留的技巧记录条数上限，超出丢弃最旧的。 */
export const MAX_TECHNIQUES_PER_SCOPE = 500

/** 每个作用域保留的失败记录条数上限，超出丢弃最旧的。 */
export const MAX_FAILURES_PER_SCOPE = 500

/** 一条失败记录最多保留的来源会话数。 */
export const MAX_FAILURE_SESSIONS = 20

/** 一条技巧最多保留的证据条数。 */
export const MAX_TECHNIQUE_EVIDENCE = 20

/** 一条技巧最多保留的标签数。 */
export const MAX_TECHNIQUE_TAGS = 12

/** 一条技巧最多保留的调用面条数。 */
export const MAX_TECHNIQUE_API = 12

/** 一条语义记忆最多保留的来源会话数。 */
export const MAX_SEMANTIC_SOURCES = 20

/** 语义层合并时判定「同一条事实」的归一化：去空白、去标点、转小写。 */
export function semanticKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[，。；、！？：,.;!?:'"“”‘’()（）[\]【】{}<>《》`~@#$%^&*+=|\\/-]+/gu, '')
    .slice(0, 120)
}

/**
 * 技巧合并时判定「同一条技巧」的归一化键：名称 + 触发条件 + 领域。
 *
 * 名字与触发条件共同构成身份：只说「注册方块」不足以区分「Fabric 1.20 注册方块」与
 * 「Forge 1.16 注册方块」；领域则把同一动作在不同业务语义下分开。
 *
 * @param name - 技巧名。
 * @param when - 触发条件。
 * @param domain - 业务领域。
 * @returns 归一化键。
 */
export function techniqueKey(name: string, when: string, domain?: string): string {
  return semanticKey([name, when, domain ?? ''].join(' '))
}

/** 把一个字符串压成文件系统安全的短 slug，用于项目目录命名。 */export function slugify(input: string): string {
  const ascii = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return ascii.length > 0 ? ascii.slice(0, 32) : 'root'
}

/**
 * 为一个作用域 + 项目目录解析存储子目录名。
 *
 * 全局域按 `partition` 分目录：默认分区沿用历史的 `global` 路径（保持向后兼容），
 * 其余分区落在 `global/<slug>` 下，实现「同一分区内全局、跨分区隔离」。
 *
 * @param scope - 记忆作用域。
 * @param cwd - 项目工作目录；`global` 作用域忽略该参数。
 * @param partition - 全局域分区名，默认 {@link DEFAULT_PARTITION}。
 * @returns 相对于存储根的目录名，形如 `projects/foo-a1b2c3d4`、`global` 或 `global/acme`。
 */
export function scopeDirName(
  scope: MemoryScope,
  cwd: string | undefined,
  partition: string = DEFAULT_PARTITION,
): string {
  if (scope === 'global') {
    const name = slugify(partition.trim().length === 0 ? DEFAULT_PARTITION : partition)
    return name === DEFAULT_PARTITION ? 'global' : join('global', name)
  }
  const base = cwd === undefined || cwd.length === 0 ? process.cwd() : cwd
  const hash = createHash('sha1').update(base).digest('hex').slice(0, 8)
  return join('projects', `${slugify(base.split(/[/\\]/u).filter(Boolean).pop() ?? base)}-${hash}`)
}

/** 一条情景记录的可检索文本，BM25 与展示共用，保证打分口径一致。 */
export function episodicText(record: EpisodicRecord): string {
  return [
    record.title,
    record.summary,
    ...record.decisions,
    ...record.todos,
    ...record.tags,
    ...record.files,
  ]
    .filter(part => part.length > 0)
    .join('\n')
}

/** 一条语义记录的可检索文本。 */
export function semanticText(record: SemanticRecord): string {
  return [record.text, ...record.tags].filter(part => part.length > 0).join('\n')
}

/**
 * 一条技巧记录的可检索文本。
 *
 * 刻意**不纳入示例代码**：示例是极小的说明性片段，纳入会让代码噪声主导检索，
 * 反而盖过「名称 / 触发条件 / 说明」这些真正的语义线索。
 *
 * @param record - 技巧记录。
 * @returns 供 BM25 与展示共用的文本。
 */
export function techniqueText(record: TechniqueRecord): string {
  return [
    record.name,
    record.when,
    record.summary,
    ...(record.domain === undefined ? [] : [record.domain]),
    ...record.tags,
    ...(record.api ?? []).map(surface => [surface.symbol, surface.signature ?? ''].join(' ')),
  ]
    .filter(part => part.length > 0)
    .join('\n')
}

/** 状态强弱：合并时只升不降，`deprecated` 是粘性的终态。 */
export const STATUS_RANK: Record<TechniqueStatus, number> = {
  draft: 0,
  validated: 1,
  canonical: 2,
  deprecated: 3,
}

/** 敏感级别强弱：合并时取更严格的一方。 */
const SENSITIVITY_RANK = { public: 0, internal: 1, confidential: 2 } as const

/** 反思指标的初值。 */
export function emptyMetrics(): ReflectionMetrics {
  return {
    reflections: 0,
    skipped: 0,
    newTechniques: 0,
    duplicateTechniques: 0,
    emptyStreak: 0,
    backoff: false,
  }
}

/** 一条技巧最多标注的「同触发另解」条数。 */
export const MAX_CONFLICTS = 8

/**
 * 重算「同一触发条件下的另解」标记。
 *
 * 判定刻意保守：**触发条件归一化后相同**即视为可能需要并置呈现。真正的语义蕴含
 * （两条是否真的互斥）需要模型判断，而误判的代价是把互补的做法说成冲突。
 * 因此字段名是「同触发的另解」，呈现时也如实这么写。
 *
 * 会先清空旧标记：某条被解决后，冲突提示必须随之消失，否则会留下幽灵分歧。
 *
 * @param records - 同一作用域内的全部技巧（就地修改）。
 */
export function assignConflicts(records: readonly TechniqueRecord[]): void {
  for (const record of records) delete record.conflictsWith

  const byTrigger = new Map<string, TechniqueRecord[]>()
  for (const record of records) {
    if (record.status === 'deprecated') continue
    const trigger = semanticKey(record.when)
    if (trigger.length < 4) continue
    const bucket = byTrigger.get(trigger)
    if (bucket === undefined) byTrigger.set(trigger, [record])
    else bucket.push(record)
  }

  for (const bucket of byTrigger.values()) {
    if (bucket.length < 2) continue
    for (const record of bucket) {
      record.conflictsWith = bucket
        .filter(other => other.id !== record.id)
        .map(other => other.id)
        .slice(0, MAX_CONFLICTS)
    }
  }
}

/** 保序并集，可设上限；两侧都为空时返回 `undefined`。 */
function unionStrings(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
  cap: number,
): string[] | undefined {
  const merged = [...new Set([...(existing ?? []), ...(incoming ?? [])])].slice(0, cap)
  return merged.length === 0 ? undefined : merged
}

/** 证据去重并设上限：同仓库 + 同角色 + 同提示视为同一条。 */
function unionEvidence(
  existing: readonly TechniqueEvidence[],
  incoming: readonly TechniqueEvidence[],
): TechniqueEvidence[] {
  const all = [...existing, ...incoming]
  const seen = new Set<string>()
  const out: TechniqueEvidence[] = []
  for (const item of all) {
    const key = [item.kind, item.repo ?? '', item.role ?? '', item.hint ?? '', item.sessionId ?? ''].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= MAX_TECHNIQUE_EVIDENCE) break
  }
  return out
}

/** 调用面按 symbol 去重并设上限。 */
function unionApi(
  existing: readonly ApiSurface[] | undefined,
  incoming: readonly ApiSurface[] | undefined,
): ApiSurface[] | undefined {
  const out: ApiSurface[] = []
  const seen = new Set<string>()
  for (const surface of [...(existing ?? []), ...(incoming ?? [])]) {
    const symbol = surface.symbol.trim()
    if (symbol.length === 0 || seen.has(symbol)) continue
    seen.add(symbol)
    out.push(surface)
    if (out.length >= MAX_TECHNIQUE_API) break
  }
  return out.length === 0 ? undefined : out
}

/**
 * 把一条草稿合并进既有技巧：同一身份视为同一条，累加命中并合并各字段。
 * @param existing - 既有记录（原地修改）。
 * @param draft - 新草稿。
 * @param now - 当前时间。
 */
function mergeTechnique(
  existing: TechniqueRecord,
  draft: TechniqueDraft,
  now: number,
  sessionId: string,
): void {
  existing.updatedAt = now
  existing.hits += 1
  if (draft.summary.length > existing.summary.length) existing.summary = draft.summary

  const nextStatus = draft.status ?? 'draft'
  if (STATUS_RANK[nextStatus] > STATUS_RANK[existing.status]) existing.status = nextStatus

  const incomingSensitivity = draft.sensitivity ?? 'internal'
  if (SENSITIVITY_RANK[incomingSensitivity] > SENSITIVITY_RANK[existing.sensitivity]) {
    existing.sensitivity = incomingSensitivity
  }

  const steps = unionStrings(existing.steps, draft.steps, 24)
  if (steps !== undefined) existing.steps = steps
  const invariants = unionStrings(existing.invariants, draft.invariants, 24)
  if (invariants !== undefined) existing.invariants = invariants
  const api = unionApi(existing.api, draft.api)
  if (api !== undefined) existing.api = api
  existing.pitfalls = unionStrings(existing.pitfalls, draft.pitfalls, 24) ?? []
  existing.verify = unionStrings(existing.verify, draft.verify, 24) ?? []
  existing.tags = unionStrings(existing.tags, draft.tags, MAX_TECHNIQUE_TAGS) ?? []
  // 每次观察都记下来源会话：多个仓库独立观测到同一条，是全局域最有价值的佐证。
  existing.evidence = unionEvidence(existing.evidence, [...draft.evidence, { kind: 'session', sessionId }])
  existing.stack = mergeStack(existing.stack, draft.stack)
  if (existing.example === undefined && draft.example !== undefined) existing.example = draft.example
}

/** 本地记忆库：负责一个存储根下的读、写、合并，不做打分排序。 */
export class MemoryStore {
  /** 存储根目录。 */
  readonly root: string

  /** 行级编解码器；`undefined` 表示明文存储。 */
  private readonly codec: StoreCodec | undefined

  /**
   * @param root - 存储根目录的绝对路径。
   * @param codec - 可选的加密编解码器（不传即明文，用于测试或显式关闭加密）。
   */
  constructor(root: string, codec?: StoreCodec) {
    this.root = root
    if (codec !== undefined) this.codec = codec
  }

  /**
   * 一个作用域的目录绝对路径。
   * @param scope - 记忆作用域。
   * @param cwd - 项目工作目录。
   * @param partition - 全局域分区名；默认 {@link DEFAULT_PARTITION}。
   * @returns 目录绝对路径。
   */
  scopeDir(scope: MemoryScope, cwd?: string, partition?: string): string {
    return join(this.root, scopeDirName(scope, cwd, partition))
  }

  /**
   * 逐行加密待写入内容。空行保持为空行（不产生无意义的密文行）。
   * @param content - 明文内容。
   * @returns 待落盘内容。
   */
  private encode(content: string): string {
    const codec = this.codec
    if (codec === undefined) return content
    return content
      .split('\n')
      .map(line => (line.trim().length === 0 ? line : codec.encode(line)))
      .join('\n')
  }

  /**
   * 逐行解密已落盘内容。
   *
   * 无法解密的行（密钥不匹配、密文损坏、被外部篡改）被**跳过**并保留其余行，
   * 因此单行损坏不会让整个记忆库不可用。非密文行按明文返回，兼容旧的明文记忆库。
   *
   * @param raw - 落盘原文。
   * @returns 有效行（已解密、已剔除空行）的数组。
   */
  private decode(raw: string): string[] {
    const codec = this.codec
    const out: string[] = []
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      if (codec === undefined) {
        out.push(line)
        continue
      }
      try {
        out.push(codec.decode(line))
      } catch {
        // 跳过无法解密的行：宁可少一条记忆，也不要整个库读不出来。
      }
    }
    return out
  }

  /**
   * 读取一个作用域的全部情景记录；文件不存在时返回空数组。
   * 解析失败的行被跳过（JSONL 允许半截写入后人工修复）。
   * @param scope - 记忆作用域。
   * @param cwd - 项目工作目录。
   * @param partition - 全局域分区名。
   * @returns 按写入顺序排列的情景记录。
   */
  async readEpisodic(scope: MemoryScope, cwd?: string, partition?: string): Promise<EpisodicRecord[]> {
    const file = join(this.scopeDir(scope, cwd, partition), EPISODIC_FILE)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const records: EpisodicRecord[] = []
    for (const line of this.decode(raw)) {
      try {
        records.push(JSON.parse(line) as EpisodicRecord)
      } catch {
        // 跳过损坏行：宁可少一条记忆，也不要整个库读不出来。
      }
    }
    return records
  }

  /**
   * 统计**所有项目桶**的情景记录条数（不含 global 域）。
   *
   * `episodic` 是 project 作用域，{@link readEpisodic} 只覆盖当前工作目录；`memory_stats`
   * 只报这一个桶时，别的项目整个不在统计里，读起来像「库里没东西」。
   *
   * @returns 各项目桶的条数之和。
   */
  async countProjectEpisodic(): Promise<number> {
    const root = join(this.root, 'projects')
    let entries: Dirent[] = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) return 0
      throw error
    }
    let total = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      total += await this.countJsonLines(join(root, entry.name, EPISODIC_FILE))
    }
    return total
  }

  /**
   * 数一个 JSONL 文件里的有效行数。
   * @param file - 目标文件绝对路径。
   * @returns 有效行数；文件不存在为 0。
   */
  private async countJsonLines(file: string): Promise<number> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return 0
      throw error
    }
    let count = 0
    for (const line of this.decode(raw)) {
      try {
        JSON.parse(line)
        count += 1
      } catch {
        // 与 readEpisodic 同口径：损坏行跳过，而不是让整个库读不出来。
      }
    }
    return count
  }

  /**
   * 读取一个作用域的语义记录；文件不存在时返回空数组。
   * @param scope - 记忆作用域。
   * @param cwd - 项目工作目录。
   * @param partition - 全局域分区名。
   * @returns 语义记录数组，顺序即文件顺序。
   */
  async readSemantic(scope: MemoryScope, cwd?: string, partition?: string): Promise<SemanticRecord[]> {
    const file = join(this.scopeDir(scope, cwd, partition), SEMANTIC_FILE)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    try {
      // 单行 JSON 与旧的多行美化 JSON 都能还原：逐行解密后用换行拼回。
      const parsed: unknown = JSON.parse(this.decode(raw).join('\n'))
      return Array.isArray(parsed) ? parsed as SemanticRecord[] : []
    } catch {
      return []
    }
  }

  /**
   * 写入一条会话的情景摘要：同一会话已有记录时原地替换，保证「一次会话一条摘要」。
   * 超过 {@link MAX_EPISODIC_PER_SCOPE} 时丢弃最旧记录。
   * @param record - 待写入的情景记录。
   * @returns 写盘后该作用域保留的记录条数。
   */
  async saveEpisodic(record: EpisodicRecord): Promise<number> {
    const existing = await this.readEpisodic(record.scope, record.cwd, record.partition)
    const withoutSameSession = existing.filter(item => item.sessionId !== record.sessionId)
    const next = [...withoutSameSession, record].slice(-MAX_EPISODIC_PER_SCOPE)
    const body = next.map(item => JSON.stringify(item)).join('\n')
    await this.writeAtomic(join(this.scopeDir(record.scope, record.cwd, record.partition), EPISODIC_FILE), `${body}\n`)
    return next.length
  }

  /**
   * 把提炼出的事实合并进语义层：同 key 更新正文并累加命中次数，否则新增。
   * @param drafts - 待合并的事实草稿。
   * @param options - 归属作用域、项目目录、来源会话与标签。
   * @returns 合并后的语义记录全集。
   */
  async upsertSemantic(
    drafts: readonly SemanticDraft[],
    options: {
      scope: MemoryScope
      cwd?: string
      partition?: string
      sessionId: string
      tags: readonly string[]
      now?: number
    },
  ): Promise<SemanticRecord[]> {
    const { scope, cwd, sessionId, tags } = options
    const partition = options.partition ?? DEFAULT_PARTITION
    const now = options.now ?? Date.now()
    const records = await this.readSemantic(scope, cwd, partition)
    const byKey = new Map(records.map(record => [record.key, record]))
    for (const draft of drafts) {
      const text = draft.text.trim()
      if (text.length === 0) continue
      const key = semanticKey(text)
      if (key.length === 0) continue
      const existing = byKey.get(key)
      if (existing === undefined) {
        byKey.set(key, {
          id: `sm_${randomUUID()}`,
          ts: now,
          updatedAt: now,
          scope,
          partition,
          kind: draft.kind,
          key,
          text,
          hits: 1,
          sources: [sessionId],
          tags: [...new Set(tags)],
        })
        continue
      }
      existing.text = text
      existing.updatedAt = now
      existing.hits += 1
      existing.kind = draft.kind
      if (!existing.sources.includes(sessionId)) {
        existing.sources = [...existing.sources, sessionId].slice(-MAX_SEMANTIC_SOURCES)
      }
      existing.tags = [...new Set([...existing.tags, ...tags])]
    }
    const next = [...byKey.values()].sort((left, right) => left.ts - right.ts)
    await this.writeAtomic(
      join(this.scopeDir(scope, cwd, partition), SEMANTIC_FILE),
      `${JSON.stringify(next)}\n`,
    )
    return next
  }

  /**
   * 读取一个作用域的全部技巧记录；文件不存在时返回空数组。
   * 解析失败的行被跳过（与其他 JSONL 层一致）。
   * @param scope - 记忆作用域。
   * @param cwd - 项目工作目录。
   * @param partition - 全局域分区名。
   * @returns 按写入顺序排列的技巧记录。
   */
  async readTechniques(scope: MemoryScope, cwd?: string, partition?: string): Promise<TechniqueRecord[]> {
    const file = join(this.scopeDir(scope, cwd, partition), TECHNIQUE_FILE)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const records: TechniqueRecord[] = []
    for (const line of this.decode(raw)) {
      try {
        records.push(JSON.parse(line) as TechniqueRecord)
      } catch {
        // 跳过损坏行：宁可少一条技巧，也不要整个库读不出来。
      }
    }
    return records
  }

  /**
   * 把技巧草稿合并进技巧层：同一 {@link techniqueKey} 视为同一条，累加命中并合并字段。
   *
   * 返回值区分「新建」与「合并」的条数 —— 反思的新颖度度量与自适应退避依赖它。
   *
   * @param drafts - 待合并的技巧草稿。
   * @param options - 归属作用域、项目目录、分区、来源会话与产出途径。
   * @returns 合并后的全集与新建/合并计数。
   */
  async upsertTechniques(
    drafts: readonly TechniqueDraft[],
    options: {
      scope: MemoryScope
      cwd?: string
      partition?: string
      sessionId: string
      provenance: TechniqueRecord['provenance']
      now?: number
    },
  ): Promise<{ records: TechniqueRecord[]; created: number; merged: number }> {
    const { scope, cwd, sessionId, provenance } = options
    const partition = options.partition ?? DEFAULT_PARTITION
    const now = options.now ?? Date.now()
    const records = await this.readTechniques(scope, cwd, partition)
    const byKey = new Map(records.map(record => [techniqueKey(record.name, record.when, record.domain), record]))
    let created = 0
    let merged = 0

    for (const draft of drafts) {
      const name = draft.name.trim()
      const when = draft.when.trim()
      if (name.length === 0 || when.length === 0) continue
      const key = techniqueKey(name, when, draft.domain)
      if (key.length === 0) continue
      const existing = byKey.get(key)
      if (existing !== undefined) {
        mergeTechnique(existing, draft, now, sessionId)
        merged += 1
        continue
      }
      const record: TechniqueRecord = {
        id: `tq_${randomUUID()}`,
        ts: now,
        updatedAt: now,
        scope,
        partition,
        kind: draft.kind,
        status: draft.status ?? 'draft',
        sensitivity: draft.sensitivity ?? 'internal',
        name,
        when,
        summary: draft.summary.trim(),
        ...(draft.steps === undefined ? {} : { steps: [...draft.steps] }),
        ...(draft.invariants === undefined ? {} : { invariants: [...draft.invariants] }),
        ...(draft.api === undefined ? {} : { api: [...draft.api] }),
        ...(draft.example === undefined ? {} : { example: draft.example }),
        pitfalls: [...draft.pitfalls],
        verify: [...draft.verify],
        stack: draft.stack,
        ...(draft.domain === undefined ? {} : { domain: draft.domain }),
        tags: [...new Set(draft.tags)].slice(0, MAX_TECHNIQUE_TAGS),
        evidence: unionEvidence([], draft.evidence.length > 0 ? draft.evidence : [{ kind: 'session', sessionId }]),
        // 落盘前已过脱敏与占位符化管线；本地存储视为已去标识化。
        deidentified: true,
        hits: 1,
        applied: 0,
        successes: 0,
        failures: 0,
        provenance,
      }
      byKey.set(key, record)
      created += 1
    }

    const next = [...byKey.values()].sort((left, right) => left.ts - right.ts).slice(-MAX_TECHNIQUES_PER_SCOPE)
    assignConflicts(next)
    await this.writeAtomic(
      join(this.scopeDir(scope, cwd, partition), TECHNIQUE_FILE),
      next.map(record => JSON.stringify(record)).join('\n') + (next.length > 0 ? '\n' : ''),
    )
    return { records: next, created, merged }
  }

  /**
   * 按 id 原地替换一条技巧（用于 `technique_apply` 的计数与状态更新）。
   *
   * 与 {@link upsertTechniques} 的区别：这里不按 key 合并、不累加命中，
   * 只把一条已计算好的记录写回，避免「回报结果」被误当成「又观察到一个新实例」。
   *
   * @param record - 更新后的记录。
   * @param cwd - 项目工作目录（`record.scope` 为 `project` 时必填）。
   * @returns 命中并写回时为 `true`。
   */
  async updateTechnique(record: TechniqueRecord, cwd?: string): Promise<boolean> {
    const records = await this.readTechniques(record.scope, cwd, record.partition)
    const index = records.findIndex(item => item.id === record.id)
    if (index < 0) return false
    records[index] = record
    // 状态变化会影响「同触发另解」的集合（例如刚被解决的那条要退出），因此重算。
    assignConflicts(records)
    await this.writeAtomic(
      join(this.scopeDir(record.scope, cwd, record.partition), TECHNIQUE_FILE),
      records.map(item => JSON.stringify(item)).join('\n') + '\n',
    )
    return true
  }

  /**
   * 删除技巧记录。
   * @param scope - 记忆作用域。
   * @param cwd - 项目工作目录。
   * @param partition - 全局域分区名。
   * @param id - 目标记录 id，或 `*` 表示清空该作用域全部技巧。
   * @returns 被删除的记录条数。
   */
  async forgetTechnique(
    scope: MemoryScope,
    cwd: string | undefined,
    partition: string | undefined,
    id: string,
  ): Promise<number> {
    const records = await this.readTechniques(scope, cwd, partition)
    const keep = id === '*' ? [] : records.filter(record => record.id !== id)
    const removed = records.length - keep.length
    if (removed > 0) {
      await this.writeAtomic(
        join(this.scopeDir(scope, cwd, partition), TECHNIQUE_FILE),
        keep.map(record => JSON.stringify(record)).join('\n') + (keep.length > 0 ? '\n' : ''),
      )
    }
    return removed
  }

  /**
   * 读取一个作用域的全部失败记录；文件不存在时返回空数组。
   * @param scope - 记忆作用域。
   * @param cwd - 项目工作目录。
   * @param partition - 全局域分区名。
   * @returns 按写入顺序排列的失败记录。
   */
  async readFailures(scope: MemoryScope, cwd?: string, partition?: string): Promise<FailureRecord[]> {
    const file = join(this.scopeDir(scope, cwd, partition), FAILURE_FILE)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const records: FailureRecord[] = []
    for (const line of this.decode(raw)) {
      try {
        records.push(JSON.parse(line) as FailureRecord)
      } catch {
        // 跳过损坏行：宁可少一条失败记忆，也不要整个库读不出来。
      }
    }
    return records
  }

  /**
   * 记录一次失败观测：同指纹合并计数，否则新建。
   *
   * **不按 name 去重，只按指纹去重** —— 「同一个错误」的定义是「同一指纹」，
   * 这正是跨会话识别重复犯错的基础。
   *
   * @param observations - 待记录的观测（指纹 + 现象）。
   * @param options - 归属作用域、分区、来源会话与时间。
   * @returns 合并后的全集与该次观测命中的记录。
   */
  async upsertFailures(
    observations: readonly {
      fingerprint: FailureRecord['fingerprint']
      symptom: string
      stack?: FailureRecord['stack']
      remedy?: string
      /** 触发方式；缺省时记录里就没有可匹配的场景描述。 */
      trigger?: string
      guard?: FailureRecord['guard']
    }[],
    options: {
      scope: MemoryScope
      cwd?: string
      partition?: string
      sessionId: string
      /** 由调用方按「升级阈值」决定处置强度；存储层不关心阈值策略。 */
      enforcement: (occurrences: number) => FailureRecord['enforcement']
      now?: number
    },
  ): Promise<{ records: FailureRecord[]; touched: FailureRecord[] }> {
    const { scope, cwd, sessionId, enforcement } = options
    const partition = options.partition ?? DEFAULT_PARTITION
    const now = options.now ?? Date.now()
    const records = await this.readFailures(scope, cwd, partition)
    const byKey = new Map(records.map(record => [record.fingerprint.key, record]))
    const touched: FailureRecord[] = []

    for (const observation of observations) {
      const existing = byKey.get(observation.fingerprint.key)
      if (existing !== undefined) {
        existing.occurrences += 1
        existing.updatedAt = now
        existing.lastSeen = now
        existing.symptom = observation.symptom
        existing.enforcement = enforcement(existing.occurrences)
        if (observation.remedy !== undefined && existing.remedy.length === 0) {
          existing.remedy = observation.remedy
        }
        if (observation.guard !== undefined && existing.guard === undefined) {
          existing.guard = observation.guard
        }
        // 触发方式一旦写定就不再被后来的观测改写：它是人工/模型给的语义结论，
        // 而每次观测只能提供粗粒度推导，覆盖只会让它退化成模板文本。
        if (observation.trigger !== undefined && existing.trigger === undefined) {
          existing.trigger = observation.trigger
        }
        if (!existing.sessions.includes(sessionId)) {
          existing.sessions = [...existing.sessions, sessionId].slice(-MAX_FAILURE_SESSIONS)
        }
        if (existing.status === 'draft' && existing.occurrences >= 2) existing.status = 'validated'
        touched.push(existing)
        continue
      }

      const record: FailureRecord = {
        id: `fa_${randomUUID()}`,
        ts: now,
        updatedAt: now,
        scope,
        partition,
        fingerprint: observation.fingerprint,
        symptom: observation.symptom,
        remedy: observation.remedy ?? '',
        ...(observation.trigger === undefined ? {} : { trigger: observation.trigger }),
        ...(observation.guard === undefined ? {} : { guard: observation.guard }),
        enforcement: enforcement(1),
        occurrences: 1,
        prevented: 0,
        sessions: [sessionId],
        firstSeen: now,
        lastSeen: now,
        stack: observation.stack ?? { languages: [] },
        evidence: [{ kind: 'session', sessionId }],
        status: 'draft',
        provenance: 'auto',
      }
      byKey.set(record.fingerprint.key, record)
      touched.push(record)
    }

    const next = [...byKey.values()].sort((left, right) => left.ts - right.ts).slice(-MAX_FAILURES_PER_SCOPE)
    await this.writeAtomic(
      join(this.scopeDir(scope, cwd, partition), FAILURE_FILE),
      next.map(record => JSON.stringify(record)).join('\n') + (next.length > 0 ? '\n' : ''),
    )
    return { records: next, touched }
  }

  /**
   * 按 id 原地替换一条失败记录（用于 `prevented` 计数与 `failure_resolve`）。
   *
   * 与 {@link upsertFailures} 的区别：这里不改动 `occurrences`，
   * 避免把「统计更新」误记成「又发生了一次」。
   *
   * @param record - 更新后的记录。
   * @param cwd - 项目工作目录（`record.scope` 为 `project` 时必填）。
   * @returns 命中并写回时为 `true`。
   */
  async updateFailure(record: FailureRecord, cwd?: string): Promise<boolean> {
    const records = await this.readFailures(record.scope, cwd, record.partition)
    const index = records.findIndex(item => item.id === record.id)
    if (index < 0) return false
    records[index] = record
    await this.writeAtomic(
      join(this.scopeDir(record.scope, cwd, record.partition), FAILURE_FILE),
      records.map(item => JSON.stringify(item)).join('\n') + '\n',
    )
    return true
  }

  /**
   * 删除失败记录。
   * @param scope - 记忆作用域。
   * @param cwd - 项目工作目录。
   * @param partition - 全局域分区名。
   * @param id - 目标记录 id，或 `*` 表示清空该作用域全部失败记录。
   * @returns 被删除的记录条数。
   */
  async forgetFailure(
    scope: MemoryScope,
    cwd: string | undefined,
    partition: string | undefined,
    id: string,
  ): Promise<number> {
    const records = await this.readFailures(scope, cwd, partition)
    const keep = id === '*' ? [] : records.filter(record => record.id !== id)
    const removed = records.length - keep.length
    if (removed > 0) {
      await this.writeAtomic(
        join(this.scopeDir(scope, cwd, partition), FAILURE_FILE),
        keep.map(record => JSON.stringify(record)).join('\n') + (keep.length > 0 ? '\n' : ''),
      )
    }
    return removed
  }

  /**
   * 读取记忆库根目录下的一个 JSON 文件。
   *
   * 供挖掘缓存这类「整块状态」使用：缺失或损坏时返回调用方给出的初值，
   * 绝不让一个坏掉的辅助文件影响主流程。
   *
   * @param name - 文件名（不含路径）。
   * @param fallback - 文件缺失或损坏时的初值。
   * @returns 解析后的值。
   */
  async readJsonFile<T>(name: string, fallback: T): Promise<T> {
    let raw: string
    try {
      raw = await readFile(join(this.root, name), 'utf8')
    } catch (error) {
      if (isNotFound(error)) return fallback
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(this.decode(raw).join('\n'))
      return parsed === null || parsed === undefined ? fallback : parsed as T
    } catch {
      return fallback
    }
  }

  /**
   * 原子写入记忆库根目录下的一个 JSON 文件。
   * @param name - 文件名（不含路径）。
   * @param value - 可序列化的值。
   */
  async writeJsonFile(name: string, value: unknown): Promise<void> {
    await this.writeAtomic(join(this.root, name), `${JSON.stringify(value)}\n`)
  }

  /**
   * 读取反思（会话内提炼）指标；文件缺失或损坏时返回初值。
   * @returns 累计指标。
   */
  async readMetrics(): Promise<ReflectionMetrics> {
    const file = join(this.root, METRICS_FILE)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return emptyMetrics()
      throw error
    }
    try {
      const parsed = JSON.parse(this.decode(raw).join('\n')) as Partial<ReflectionMetrics>
      return { ...emptyMetrics(), ...parsed }
    } catch {
      return emptyMetrics()
    }
  }

  /**
   * 写入反思指标。
   * @param metrics - 完整指标快照。
   */
  async saveMetrics(metrics: ReflectionMetrics): Promise<void> {
    await this.writeAtomic(join(this.root, METRICS_FILE), `${JSON.stringify(metrics)}\n`)
  }

  /**
   * 删除一条记忆（情景或语义），按 id 匹配。
   * @param scope - 记忆作用域。
   * @param cwd - 项目工作目录。
   * @param id - 目标记录 id，或 `*` 表示清空该作用域全部记忆。
   * @returns 被删除的记录条数。
   */
  async forget(scope: MemoryScope, cwd: string | undefined, id: string, partition?: string): Promise<number> {
    const dir = this.scopeDir(scope, cwd, partition)
    const episodic = await this.readEpisodic(scope, cwd, partition)
    const semantic = await this.readSemantic(scope, cwd, partition)
    const keepEpisodic = id === '*' ? [] : episodic.filter(record => record.id !== id)
    const keepSemantic = id === '*' ? [] : semantic.filter(record => record.id !== id)
    const removed = episodic.length - keepEpisodic.length + (semantic.length - keepSemantic.length)
    if (removed > 0) {
      await this.writeAtomic(
        join(dir, EPISODIC_FILE),
        keepEpisodic.map(record => JSON.stringify(record)).join('\n') + (keepEpisodic.length > 0 ? '\n' : ''),
      )
      await this.writeAtomic(join(dir, SEMANTIC_FILE), `${JSON.stringify(keepSemantic)}\n`)
    }
    return removed
  }

  /**
   * 原子写入：先写同目录临时文件再 rename，读者永远看不到半截内容。
   *
   * 文件权限收紧为 `0600`、目录为 `0700`：记忆库存放会话摘要与用户偏好，
   * 不应被同机其他用户读取。配置了编解码器时，内容在写入前逐行加密。
   *
   * @param file - 目标文件绝对路径。
   * @param content - 完整明文内容。
   */
  private async writeAtomic(file: string, content: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: DIRECTORY_MODE })
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, this.encode(content), { encoding: 'utf8', mode: FILE_MODE })
    await rename(temp, file)
  }
}

/** 判断一个未知错误是否为「文件不存在」。 */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
