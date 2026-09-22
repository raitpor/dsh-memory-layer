/**
 * dsh-memory-layer 的数据模型：把会话内容沉淀为三层记忆的持久化与运行时形态。
 *
 * - 瞬时层（transient）：当前会话的要点，只存在于内存，随会话 `session/disposed` 消失。
 * - 情景层（episodic）：一次会话一条摘要，追加写入 JSONL，天然按时间可回放。
 * - 语义层（semantic）：跨会话复用的长期事实与偏好，按 {@link SemanticRecord.key} 合并更新。
 *
 * @module dsh-memory-layer/types
 */

/** 记忆作用域：`project` 按项目目录隔离，`global` 跨项目共享。 */
export type MemoryScope = 'project' | 'global'

/** 语义层记忆的类别，决定召回时的提示措辞与权重。 */
export type SemanticKind = 'fact' | 'preference' | 'decision' | 'constraint'

/** 一条记忆的提炼来源：模型提炼或无需模型调用的本地规则回退。 */
export type ExtractionSource = 'model' | 'rule'

/** 模型路由，提炼调用必须显式携带 provider 与 model。 */
export interface ModelRoute {
  /** 已注册的 provider 路由。 */
  provider: string
  /** provider 所属的模型 id。 */
  model: string
}

/** 语义层草稿：提炼阶段产出、尚未与既有记忆合并的事实。 */
export interface SemanticDraft {
  /** 事实类别。 */
  kind: SemanticKind
  /** 事实正文，一句话。 */
  text: string
}

/** 一次提炼的完整产物，同时喂给情景层与语义层。 */
export interface DistilledMemory {
  /** 一句话标题，用于列表展示。 */
  title: string
  /** 会话摘要正文。 */
  summary: string
  /** 本次会话确定下来的决定。 */
  decisions: string[]
  /** 未完成事项。 */
  todos: string[]
  /** 涉及的文件路径。 */
  files: string[]
  /** 检索标签。 */
  tags: string[]
  /** 待合并进语义层的事实与偏好。 */
  facts: SemanticDraft[]
  /** 待合并进技巧层的经验（会话内反思产出）。 */
  techniques: TechniqueDraft[]
}

/** 情景层记录：一次会话一条。 */
export interface EpisodicRecord {
  /** 记录 id（`ep_` 前缀 + uuid）。 */
  id: string
  /** 写入时间（Unix 毫秒）。 */
  ts: number
  /** 来源会话 id。 */
  sessionId: string
  /** 归属作用域。 */
  scope: MemoryScope
  /** 全局域分区（组织/租户）；缺省视为 `default`。 */
  partition?: string
  /** 会话工作目录，仅 `project` 作用域记录。 */
  cwd?: string
  /** 一句话标题。 */
  title: string
  /** 会话摘要。 */
  summary: string
  /** 关键决定。 */
  decisions: string[]
  /** 未完成事项。 */
  todos: string[]
  /** 涉及文件。 */
  files: string[]
  /** 检索标签。 */
  tags: string[]
  /** 提炼来源。 */
  source: ExtractionSource
}

/** 语义层记录：长期事实与偏好，可在后续会话被合并更新。 */
export interface SemanticRecord {
  /** 记录 id（`sm_` 前缀 + uuid）。 */
  id: string
  /** 首次写入时间（Unix 毫秒）。 */
  ts: number
  /** 最近一次命中或更新的时间（Unix 毫秒）。 */
  updatedAt: number
  /** 归属作用域。 */
  scope: MemoryScope
  /** 全局域分区（组织/租户）；缺省视为 `default`。 */
  partition?: string
  /** 事实类别。 */
  kind: SemanticKind
  /** 归一化去重键；同 scope 下同 key 视为同一条事实。 */
  key: string
  /** 事实正文。 */
  text: string
  /** 被重复观察到的次数，用于排序与置信度提示。 */
  hits: number
  /** 贡献过这条事实的会话 id（去重、最多保留 20 个）。 */
  sources: string[]
  /** 检索标签。 */
  tags: string[]
}

/** 瞬时层元素：当前会话里一轮对话的要点。 */
export interface LiveTurn {
  /** 轮次编号。 */
  turn: number
  /** 该轮的用户输入（截断后）。 */
  user: string
  /** 该轮的助手输出（截断后）。 */
  assistant: string
  /** 该轮调用的工具名（去重）。 */
  tools: string[]
  /** 该轮触及的文件路径（去重、截断）。 */
  files: string[]
}

/** 瞬时层：一个运行中会话的要点集合，仅存内存。 */
export interface LiveSession {
  /** 会话 id。 */
  sessionId: string
  /** 会话工作目录。 */
  cwd?: string
  /** 会话开始时间（Unix 毫秒）。 */
  startedAt: number
  /** 已累积的轮次要点。 */
  turns: LiveTurn[]
  /** 最近一次观测到的模型路由，供会话结束时提炼调用复用。 */
  route?: ModelRoute
  /** 会话创建时探测到的技术栈画像，用于技巧适用性判定与沉淀。 */
  stack?: StackProfile
  /** 会话结束时的提炼 promise，用于诊断与测试等待。 */
  settling?: Promise<void>
}

/** 召回结果：一条被打分的记忆及其命中来源。 */
export interface RecalledMemory {
  /** `episodic` / `semantic` / `technique`。 */
  layer: 'episodic' | 'semantic' | 'technique'
  /** 记录 id。 */
  id: string
  /** BM25 相关度得分。 */
  score: number
  /** 供展示与注入的文本行。 */
  text: string
  /** 原始记录的写入时间。 */
  ts: number
  /** 技巧层专用元信息；其余层不携带。 */
  meta?: RecallMeta
}

// ---- 技巧经验层（technique layer） ------------------------------------------

/**
 * 技术栈画像：技巧适用性的判据来源。
 *
 * Minecraft 只是 `ecosystem` 的一种特化；核心保持语言/框架无关，
 * 因为技巧需要跨项目、跨生态复用。
 */
export interface StackProfile {
  /** 领域生态特化标记（如 `minecraft`）；通用时留空。 */
  ecosystem?: string
  /** 语言集合，如 `['java','kotlin']`。 */
  languages: string[]
  /** 框架，如 `['spring-boot','react']`。 */
  frameworks?: string[]
  /** 框架/依赖声明的原始版本，如 `{ react: '^18.2.0' }`。 */
  frameworkVersions?: Record<string, string>
  /** 框架/生态的版本约束，如 `{ minecraft: '~1.20' }`。 */
  versionConstraints?: Record<string, string>
  /** 观测到的精确版本，如 `{ minecraft: '1.20.1' }`；用于判定 `versionConstraints`。 */
  versions?: Record<string, string>
  /** 涉及的专有 SDK / 内部库。 */
  sdks?: { name: string; version?: string }[]
  /** 构建工具，如 `gradle` / `npm`。 */
  buildTool?: string
}

/** 技巧的知识形态。 */
export type TechniqueKind = 'api-usage' | 'business-rule' | 'procedure' | 'pitfall' | 'env-recipe'

/** 信任状态：`draft` 不参与自动注入。 */
export type TechniqueStatus = 'draft' | 'validated' | 'canonical' | 'deprecated'

/** 敏感级别：全局域的准入闸门。 */
export type Sensitivity = 'public' | 'internal' | 'confidential'

/** 规范化后的调用面（不是代码，是「怎么调」）。 */
export interface ApiSurface {
  /** 规范化调用名，如 `OrdersClient.create`。 */
  symbol: string
  /** 单行签名 / 必填参数摘要。 */
  signature?: string
  /** 前置条件、调用顺序等一句话说明。 */
  notes?: string
}

/** 极小示例：默认 ≤8 行，占位符化，重建而非抄录。 */
export interface TechniqueExample {
  /** 示例语言，如 `java`。 */
  language: string
  /** 示例用途。 */
  kind: 'usage' | 'signature' | 'config'
  /** 示例正文。 */
  code: string
}

/** 抽象化后的证据：不保留真实项目路径。 */
export interface TechniqueEvidence {
  /** 证据来源类型。 */
  kind: 'code' | 'session' | 'error'
  /** 仓库别名（目录名哈希或配置的可读名）。 */
  repo?: string
  /** 代码角色，如 `service-layer` / `api-client`。 */
  role?: string
  /** 抽象化后的定位提示，如 `service/order-policy`。 */
  hint?: string
  /** 来源会话 id。 */
  sessionId?: string
}

/** 技巧草稿：提炼或挖掘产出、尚未与既有记录合并。 */
export interface TechniqueDraft {
  /** 知识形态。 */
  kind: TechniqueKind
  /** 一句话技巧名。 */
  name: string
  /** 触发条件：症状 / 意图 / 任务类型。 */
  when: string
  /** 主体：2–4 句总结性说明。 */
  summary: string
  /** 可选的有序步骤（散文式，非代码）。 */
  steps?: string[]
  /** 业务规则类专用：不变量与顺序约束。 */
  invariants?: string[]
  /** API 用法类专用：规范化调用面。 */
  api?: ApiSurface[]
  /** 唯一、极小示例。 */
  example?: TechniqueExample
  /** 反模式与常见错误。 */
  pitfalls: string[]
  /** 成功判据。 */
  verify: string[]
  /** 适用技术栈。 */
  stack: StackProfile
  /** 业务领域。 */
  domain?: string
  /** 检索标签。 */
  tags: string[]
  /** 抽象化后的证据链。 */
  evidence: TechniqueEvidence[]
  /** 敏感级别；缺省按 `internal` 处理。 */
  sensitivity?: Sensitivity
  /** 初始状态；缺省为 `draft`。 */
  status?: TechniqueStatus
}

/** 技巧记录：过程性知识的持久化形态。 */
export interface TechniqueRecord {
  /** 记录 id（`tq_` 前缀 + uuid）。 */
  id: string
  /** 首次写入时间（Unix 毫秒）。 */
  ts: number
  /** 最近一次更新时间（Unix 毫秒）。 */
  updatedAt: number
  /** 归属作用域。 */
  scope: MemoryScope
  /** 全局域内的分区（组织/租户），默认 `default`。 */
  partition: string
  /** 知识形态。 */
  kind: TechniqueKind
  /** 信任状态。 */
  status: TechniqueStatus
  /** 敏感级别。 */
  sensitivity: Sensitivity
  /** 一句话技巧名。 */
  name: string
  /** 触发条件。 */
  when: string
  /** 主体说明。 */
  summary: string
  /** 可选步骤。 */
  steps?: string[]
  /** 不变量。 */
  invariants?: string[]
  /** 调用面。 */
  api?: ApiSurface[]
  /** 极小示例。 */
  example?: TechniqueExample
  /** 反模式。 */
  pitfalls: string[]
  /** 成功判据。 */
  verify: string[]
  /** 适用技术栈。 */
  stack: StackProfile
  /** 业务领域。 */
  domain?: string
  /** 检索标签。 */
  tags: string[]
  /** 证据链。 */
  evidence: TechniqueEvidence[]
  /** 是否通过去标识化校验；未通过者不得进入全局域。 */
  deidentified: boolean
  /** 被召回次数。 */
  hits: number
  /** 被实际采用次数。 */
  applied: number
  /** 采用成功次数。 */
  successes: number
  /** 采用失败次数。 */
  failures: number
  /** 最近一次验证时间。 */
  lastVerifiedAt?: number
  /** 产出途径。 */
  provenance: 'model' | 'rule' | 'human'
}

/** 技巧召回时携带的元信息，供过滤与加权使用。 */
export interface RecallMeta {
  /** 技巧专用：信任状态。 */
  status?: TechniqueStatus
  /** 技巧专用：敏感级别。 */
  sensitivity?: Sensitivity
  /** 技巧专用：分区。 */
  partition?: string
  /** 技巧专用：适用技术栈。 */
  stack?: StackProfile
  /** 技巧专用：业务领域。 */
  domain?: string
  /** 技巧专用：规范化调用名。 */
  symbols?: readonly string[]
  /** 技巧专用：成功次数。 */
  successes?: number
  /** 技巧专用：失败次数。 */
  failures?: number
  /** 技巧专用：证据条数。 */
  evidenceCount?: number
}

/** 反思（会话内提炼）的累计指标，用于展示「经验复利」。 */
export interface ReflectionMetrics {
  /** 实际调用模型的反思次数。 */
  reflections: number
  /** 被触发闸门跳过的次数。 */
  skipped: number
  /** 新入库的技巧条数。 */
  newTechniques: number
  /** 合并进既有记录的条数。 */
  duplicateTechniques: number
  /** 当前连续无新产出的次数，用于自适应退避。 */
  emptyStreak: number
  /** 当前是否处于退避（仅高价值信号才反思）。 */
  backoff: boolean
}

// ---- 失败经验层（failure layer） --------------------------------------------

/**
 * 失败指纹：跨会话识别「同一个错误」的依据。
 *
 * `machine` 来自结构化错误（工具名 + 错误名/码 + 归一化模板），确定性匹配；
 * `semantic` 来自用户纠偏等非结构化信号，靠归一化键匹配。
 */
export interface FailureFingerprint {
  /** 指纹类型。 */
  kind: 'machine' | 'semantic'
  /** 稳定标识（sha1）；同一错误在不同会话中必须得到同一个 key。 */
  key: string
  /** 失败发生的工具名。 */
  tool?: string
  /** 错误名（如 `NoSuchMethodError`）。 */
  errorName?: string
  /** 错误码（如 `MODULE_NOT_FOUND`）。 */
  errorCode?: string
  /** 归一化后的错误模板（人类可读）。 */
  template?: string
  /** 语义指纹的 token 集合（供后续相似度匹配）。 */
  tokens?: string[]
}

/** 可执行的守卫条件：存在时才可能升级到「拦截」（P2）。 */
export interface GuardSpec {
  /** 只针对具体工具，禁止通配。 */
  tool: string
  /** 参数中必须出现的字段。 */
  argKeys?: string[]
  /** 参数文本需命中的窄模式（脱敏后）。 */
  pattern?: string
  /** 全部子串都出现才命中。 */
  allOf?: string[]
}

/** 失败的处置强度。 */
export type FailureEnforcement = 'warn' | 'ask' | 'block'

/** 失败经验记录：可执行的防错实体（区别于 `pitfall` 技巧的知识形态）。 */
export interface FailureRecord {
  /** 记录 id（`fa_` 前缀 + uuid）。 */
  id: string
  /** 首次观测时间（Unix 毫秒）。 */
  ts: number
  /** 最近一次观测时间（Unix 毫秒）。 */
  updatedAt: number
  /** 归属作用域。 */
  scope: MemoryScope
  /** 全局域分区。 */
  partition: string
  /** 指纹。 */
  fingerprint: FailureFingerprint
  /** 失败现象：最近一次的具体错误首行（脱敏后）。 */
  symptom: string
  /** 正确的做法；未知时为空串（此时预警只给出重复次数与现场）。 */
  remedy: string
  /** 可执行守卫条件（P2 使用）。 */
  guard?: GuardSpec
  /** 当前处置强度。 */
  enforcement: FailureEnforcement
  /** 累计发生次数。 */
  occurrences: number
  /** 预警后未再复现的次数（防错有效性）。 */
  prevented: number
  /** 来源会话 id（去重、设上限）。 */
  sessions: string[]
  /** 首次发生时间。 */
  firstSeen: number
  /** 最近一次发生时间。 */
  lastSeen: number
  /** 适用技术栈。 */
  stack: StackProfile
  /** 业务领域。 */
  domain?: string
  /** 证据链。 */
  evidence: TechniqueEvidence[]
  /** 状态：`draft` 未处置，`validated` 已进入预警，`deprecated` 已解决/不再干预。 */
  status: TechniqueStatus
  /** 产出途径。 */
  provenance: 'auto' | 'human'
  /** 由 `pitfall` 技巧提升而来时的来源 id。 */
  fromTechnique?: string
}
