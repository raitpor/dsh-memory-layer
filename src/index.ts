/**
 * dsh-memory-layer —— deepseek-harness (dsh) 的原生 Cordis 插件：跨会话本地记忆。
 *
 * 把会话内容按三层沉淀，全部落在本地磁盘、零第三方运行时依赖：
 *
 * | 层 | 生命周期 | 存储 | 产出时机 |
 * |---|---|---|---|
 * | 瞬时 transient | 当前会话，仅内存 | — | 每轮 `session/event` 累积 |
 * | 情景 episodic | 每次会话一条摘要 | `episodic.jsonl` | 每轮末 + 会话结束 |
 * | 语义 semantic | 长期事实与偏好 | `semantic.json` | 会话结束时合并 |
 *
 * 插件只硬依赖 `sessions` 服务；`llm`、`tools`、`systemPrompt` 一律软探测，
 * 因此缺少其中任何一个都不会让插件落到 PENDING 而静默失效，只是相应能力降级
 * （例如没有 `llm` 时提炼退回本地规则）。
 *
 * 安全约束（对应安全测试缺陷 DEF-SEC-001 ~ 009）：
 *
 * - 召回索引按**项目目录分桶**，会话切换后立即改用新桶，避免跨项目泄露（DEF-SEC-003）。
 * - 注入块声明记忆为**不可信数据、不得作为指令**，并对正文做结构中性化（DEF-SEC-005/006）。
 * - 注入前剥离控制字符与 ANSI 转义（DEF-SEC-007）。
 * - 只记录工作区内的相对文件路径（DEF-SEC-004）。
 *
 * @module dsh-memory-layer
 */

import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { KEY_ENV, KEY_FILE_NAME, createCodec, resolveKey } from './crypto.js'
import type { StoreCodec } from './crypto.js'
import {
  MemoryStore,
  MAX_SUMMARY_CHARS,
  MAX_TECHNIQUE_TAGS,
  MINE_CACHE_FILE,
  SQLITE_INDEX_FILE,
  emptyMetrics,
  deriveDomainFromTags,
  normalizeDomain,
  techniqueText,
} from './store.js'
import { facetQueries, isStandingRule, recallDocsFacets, recallFacets, toDocs, toTechniqueDocs, tokenize } from './recall.js'
import type { GateDecision, RelevanceGate, TechniqueScorer } from './recall.js'
import { advisoryMatches } from './recall.js'
import { SqliteTechniqueIndex, loadSqlite } from './sqlite-index.js'
import type { RecallDoc } from './recall.js'
import { distill, isInjectedContext } from './distill.js'
import type { LlmTextCaller, Transcript } from './distill.js'
import { redactAll, sanitizeForInjection, sanitizeForPrompt, sanitizeForText } from './redact.js'
import { abstractTechniqueDraft, abstractText, identifiersFromPaths } from './abstract.js'
import {
  createRepoView,
  emptyMineCache,
  mineRepository,
  withCacheEntries,
} from './mine.js'
import type { MineCache } from './mine.js'
import { appliesToAllows, createFileView, detectStack, stackSummary } from './stack/index.js'
import {
  DETAILED_HITS,
  applyOutcome,
  checkVerificationEvidence,
  clampVerificationEvidence,
  confidenceOf,
  gistOf,
  injectable,
  isArchivable,
  mentionsNeedle,
  REFERENCE_EPOCH,
  referenceNeedles,
  resolveTechniqueId,
  techniqueIndexLine,
  techniqueInjectionLine,
  techniqueSearchLine,
  techniqueTailLine,
  maxContainment,
} from './technique.js'
import {
  DEFAULT_GUARD_TOOLS,
  deriveGuard,
  enforcementFor,
  episodeOccurrences,
  deriveTrigger,
  failureApplies,
  failureDenialReason,
  failureDetail,
  failureLessonLine,
  failureRepeatLine,
  failureTrigger,
  failureWarningLine,
  guardMatches,
  isSelfDenial,
  lessonMatches,
  observeToolFailure,
  semanticFingerprint,
  shouldWarn,
} from './failures.js'
import type { EscalationThresholds, FailureObservation } from './failures.js'
import {
  FAILURE_BLOCK,
  GUIDANCE_BLOCK,
  GUIDANCE_LINES,
  GUIDANCE_MAX_CHARS,
  unconsultedGuidanceLines,
  GUIDANCE_MEMORY_ONLY_LINES,
  RECALL_BLOCK,
  TECHNIQUE_BLOCK,
  compactEntryText,
  compactStandingText,
  advisoryText,
} from './injection.js'
import type { InjectionBlock } from './injection.js'
import { renderSkill, verifySkill } from './skill.js'
import { UPDATABLE_TECHNIQUE_FIELDS, createFailureTools, createMemoryTools, createTechniqueTools } from './tools.js'
import type { FailureToolDeps, MemoryToolDeps, TechniqueSaveInput, TechniqueToolDeps } from './tools.js'
import type {
  CorrectionDraft,
  EpisodicRecord,
  ExtractionSource,
  FailureFingerprint,
  FailureRecord,
  LiveSession,
  LiveTurn,
  MemoryScope,
  ModelRoute,
  RecalledMemory,
  ReflectionMetrics,
  TechniqueDraft,
  TechniqueRecord,
  TechniqueStatus,
} from './types.js'

/** Cordis 插件显示名，同时用于诊断与 logger 名字。 */
export const name = 'dsh-memory-layer'

/**
 * 硬依赖：只有会话服务是记忆能力的必需品。
 * `llm` / `tools` / `systemPrompt` 由 {@link apply} 软探测，缺失时自动降级。
 */
export const inject = ['sessions']

/** 插件配置；加载前由 schemastery 校验并补齐默认值。 */
export interface Config {
  /** 记忆库根目录；缺省为 `<DSH_HOME>/memory-layer`（即 `~/.dsh/memory-layer`）。 */
  dir?: string
  /** 单次召回返回条数上限。 */
  recallLimit?: number
  /** 召回注入的字符上限，超出即截断。 */
  recallChars?: number
  /**
   * ① 重复条目改发**指针形态**（默认 `true`）：本会话已经完整给过、且内容没变的召回条目，
   * 不再逐轮重印全文，只留「可寻址的把手 + 首句」。
   *
   * 依据（真会话 3 天回放）：674 个不同条目 / **7,618 次出现**（平均每条发 11 次），
   * **86.1% 的条目字符是重复**；模型手里本来就有上一轮那段文本（注入块就在对话历史里）。
   *
   * 为什么不是「只发一次」：长会话里早期注入会被宿主的 compaction 裁掉 —— 收到 compaction
   * 事件时本插件的「已给过」记账整份作废，下一轮恢复全文（实现按 `compaction/` 前缀匹配，
   * 覆盖 `compaction/start` / `end` / `prune` 等全部形态）。
   * 重发全文的节奏与常驻规则共用 `standingRuleFullEveryTurns`。
   */
  recallRepeatCompact?: boolean
  /** 是否把召回结果注入 system prompt。 */
  injectPrompt?: boolean
  /** 注入 section 的排序值，越小越靠前。 */
  promptOrder?: number
  /** 是否注册 memory_search / memory_save / memory_forget / memory_stats 工具。 */
  registerTools?: boolean
  /**
   * 检索索引后端。
   *
   * `memory`（默认）：纯内存 BM25，零依赖、零额外文件。
   * `sqlite`：从真源派生的 FTS5 索引（列权重 + SQL 过滤），**可重建、可回退** ——
   *   建不起来、读不出来、`node:sqlite` 不可用（Node < 22.5）时自动退回内存路径。
   */
  indexBackend?: 'memory' | 'sqlite'
  /** 每轮捕获的用户文本上限（字符）。 */
  captureUserChars?: number
  /** 每轮捕获的助手文本上限（字符）。 */
  captureAssistantChars?: number
  /** 单个会话最多保留的轮次要点数量。 */
  maxTurnsPerSession?: number
  /** 是否在每轮结束时用规则提炼并落盘情景摘要（零模型调用，作为兜底）。 */
  distillOnTurnEnd?: boolean
  /** 会话结束时提炼的超时（毫秒）；超时后回退到规则提炼。 */
  distillTimeoutMs?: number
  /** 提炼调用使用的 provider；与 {@link Config.model} 一起给出时优先生效。 */
  provider?: string
  /** 提炼调用使用的 model；与 {@link Config.provider} 一起给出时优先生效。 */
  model?: string
  /** 是否加密记忆库（AES-256-GCM，密钥与数据分离存放）。默认 `true`。 */
  encrypt?: boolean
  /** 密钥文件路径；缺省为记忆库目录内的 `<dir>/.dsh-memory-layer.key`。 */
  keyFile?: string
  /**
   * 按层覆盖作用域 —— **作用域的唯一入口**。
   *
   * 缺省时使用 {@link LAYER_SCOPE_DEFAULTS}：`episodic` 留在项目域（它是**原始**会话摘要，
   * 含工作区路径与用户原话），`semantic` 与 `technique` 默认全局 —— 知识本就该跨项目复用。
   */
  layerScopes?: {
    episodic?: MemoryScope
    semantic?: MemoryScope
    technique?: MemoryScope
    failure?: MemoryScope
  }
  /** 全局域分区（组织/租户）；默认 `default`。 */
  partition?: string
  /** 是否启用技巧经验层。默认 `true`。 */
  techniques?: boolean
  /** 单次技巧索引注入的条数上限。 */
  techniqueLimit?: number
  /** 技巧索引注入的字符上限。 */
  techniqueChars?: number
  /** 技巧注入 section 的排序值。 */
  techniquePromptOrder?: number
  /**
   * 注入侧相关性门槛：一条**记忆或技巧**要命中查询里**几个不同的词**才允许进注入。默认 `2`。
   *
   * 为什么不用绝对 BM25 分数做默认：分数取决于 IDF，而 IDF 取决于库的规模 —— 同一条命中
   * 在 354 条的库里是 2.7、在 2 条的库里只有 0.5，默认值必然不可移植。实测不相关轮次的
   * 特征是「四五个词里只中一个」（如「把函数重命名」只共享了 `config`），因此按命中词数
   * 判定既尺度无关，又正好切在噪声上。查询本身不超过 2 个词时自动放宽为 1（见 `passesGate`）。
   *
   * **只管召回段与技巧段**：失败段不走相关性 —— 它由重复次数驱动，而且必须在动作**之前**
   * 给出（等模型自己想起来去查，错已经犯完了），这正是它被设计成主动注入的全部理由。
   *
   * 只作用于**自动注入**；模型显式 `memory_search` / `technique_search` 不受影响。
   */
  injectMinMatched?: number
  /**
   * 每轮强制注入的**常驻规则**条数上限（长期偏好 / 约束）。默认 `4`，`0` = 关闭。
   *
   * 为什么它们不走检索：偏好与约束对任何任务都成立，靠词重叠命中是碰运气 ——
   * 一条「不要自动提交」的约束在本轮聊正则时一个词都对不上。它们的条数天然很少
   * （真库只有个位数），所以按最新优先直取，不判相关性。
   */
  injectStandingRules?: number
  /**
   * 是否启用**动作点顾问**：模型对某文件/符号动手时，若库里有强证据匹配、且本会话还没看过的
   * 技巧，就在工具回执之后附一行 `· <技巧名> [id] — technique_get to read it.`。默认 `true`。
   *
   * 为什么要有它：实测（MC 移植会话）模型在 147 次工具调用里一次都没查库，只在用户明确要求时
   * 才查 —— 系统提示里的通用策略压不过任务压力。顾问把提示落在**动作发生的那一刻**，按会话
   * 去重（同一条只提一次）且有硬上限，成本有界。
   */
  techniqueAdvisory?: boolean
  /**
   * L2：检测到「模型引用了某条推给它的技巧」时，在工具回执后附一行回报提示。默认 `true`。
   *
   * 只在**真的被引用**时出现（稀有事件），因此不像常驻指引那样每轮付费。依据是实测：
   * 显式回报为 0，而引用检测能在同一批会话里抓到 3/7 被碰过的卡 —— "用了但没回报"是真实断层。
   */
  referenceNudge?: boolean
  /**
   * 顾问是否也看**草稿**（未经验证的技巧）。默认 `true`。
   *
   * 默认开的理由：真实库里绝大多数知识还是草稿（实测 25 已验证 / 329 草稿），只看已验证
   * 等于在最需要顾问的场景（移植、陌生框架）里不发声。草稿在顾问里**只出现标题与 id**、
   * 并标 `(draft, unverified)`，正文要模型显式 `technique_get` —— 不越过
   * 「未验证知识不自动注入正文」的边界。关掉它即回到只推已验证条目。
   */
  techniqueAdvisoryDrafts?: boolean
  /**
   * 单个会话最多推几条顾问（同一条仍然只推一次）。默认 `12`。
   *
   * 为什么不是更小：实测每会话 3 条时，两条顾问在同一**轮**就耗尽了预算，之后 10+ 轮完全
   * 沉默，而那些轮里有大量强证据命中（10/16、12/17…个动作）。同一 id 仍只推一次，且**每轮
   * 最多一条**（`advisoryLastTurn`），所以放开预算是安全的。
   */
  techniqueAdvisoryMax?: number
  /** 首触顾问：未检索的会话在动作点直接收到最相关的一条技巧（含要点）。默认 `true`。 */
  firstContactAdvisory?: boolean
  /**
   * **每个会话最多推几条首触顾问**。默认 `1`；`0` 等于关掉这条通道。
   *
   * 为什么必须有这个上限：首触顾问原先只靠「本会话还没查过库」这一条退出条件，而实测
   * 49 个会话里只有 18 个查过库 —— 其余 31 个**每轮各收一条**（首触占了顾问总量的 62%：
   * 179 条 / 26,367 字符，主 sdo 会话一条会话就收了 89 条）。可见限制它的不是轮数而是次数：
   * 第 1 条已经把「这里有现成经验」这件事讲清楚了，之后每多推一条都只是重复付费。
   *
   * 为什么不按轮节流（如每 10 轮一条）：149 轮的会话按此仍会推约 15 条，与不节流相差不大。
   */
  firstContactAdvisoryMax?: number
  /**
   * 死重维护（0.2.10）：每次刷新时检查一次「领域名归一化 + 归档死重草稿」，有新可归档项才写盘。
   *
   * 只做可逆操作：领域名折叠大小写与别名，死重草稿打 `archivedAt`（退出自动注入与排序，
   * 但 `technique_search` 仍可见）。关掉它则历史遗留的两种领域写法与死重都保持原样。
   */
  techniqueMaintenance?: boolean
  /**
   * 死重归档的最小年龄（天）。默认 `14`；`0` = 不等年龄。
   *
   * ⚠️ 实测：本机真库最老的记录才 8.5 天，所以默认值**当前不会归档任何一条**。这是刻意的 ——
   * 年轻库里「还没人查」说明不了「是死重」；收益要等库变老才显现出来。
   */
  archiveAfterDays?: number
  /** 归档豁免的领域（等于该项或以该项开头）。默认 `['dsh-', 'sdo']`：活跃领域里的卡明天还要用。 */
  archiveKeepDomains?: string[]
  /**
   * **单个领域**允许保留的活跃草稿数上限（0 = 不限）。默认 `150`。
   *
   * ③c 的动机是「防再生」：归档只清一次存量，而挖掘/反思仍在按同样速度产出新草稿
   * （实测约 +14 条/4 小时）。所以除了年龄判据，再加一道**按领域**的护栏 —— 某个领域饱和时，
   * 先归档该领域里**最老且从未被检索/引用/成功**的草稿，再让新的进来。
   *
   * 与 `archiveAfterDays` 的分工：年龄判据拦「没人查的旧卡」，这条拦「同一个领域堆太多」——
   * 后者不看年龄（饱和本身就是信号），但**只动从未被用过的**，且豁免领域不参与计数。
   */
  maxActiveDraftsPerDomain?: number
  /**
   * 追加到内置**通用词表**的词：命中这些词不算「相关」，因此不能单独触发注入。默认 `[]`。
   *
   * 内置表已覆盖对话套话（继续/开始/可以）、交付元话题（技巧/文档/输出/中文/库里）与通用
   * 工程词（配置/函数/文件/路径/代码/测试）。实测：不相关轮次靠「输出+中文」「技巧+库里」
   * 「发现+技巧」这类通用词组合就能把 UML 技巧拉进上下文（真库复现）。
   *
   * **加一个词 = 放弃靠它触发注入**：因此不要加本领域词（如「模组」「插件」「注入」），
   * 那会把这个库自己的领域压制掉。表只作用于门槛，不进分词器，不影响排序。
   */
  injectStopwords?: string[]
  /**
   * 常驻规则每隔几轮重发一次**全文**；`0` = 只在规则集变化时重发。默认 `10`。
   *
   * 规则集不变时，常驻条目改发紧凑形态（保一句可执行的话，默认 60 字符）—— 它们是召回段里
   * 唯一每轮必然重复的部分。定期重发全文是保险：万一压缩削掉了关键限定语，10 轮内会恢复一次。
   */
  standingRuleFullEveryTurns?: number
  /**
   * 注入侧的绝对 BM25 分数下限（`0` = 关闭，默认关闭）。
   *
   * 只在库规模稳定、观测过分数分布的环境里才值得设；语义同 `injectMinMatched`，
   * 两条门槛是与关系。真库参考值：不相关查询最高 2.71、相关查询最低 9.28。
   */
  injectMinScore?: number
  /** 「工作前先检索」常驻指引 section 的排序值。 */
  guidancePromptOrder?: number
  /** 是否注入「工作前先检索、用了就上报」的常驻指引。默认 `true`。 */
  guidance?: boolean
  /** 示例代码的行数上限。 */
  exampleMaxLines?: number
  /** 示例代码的字符上限。 */
  exampleMaxChars?: number
  /** 是否允许 `confidential` 技巧进入全局域；默认 `false`。 */
  allowConfidentialGlobal?: boolean
  /** 是否在会话结束时做模型反思（每会话一次，非每轮）。默认 `true`。 */
  reflectOnSessionEnd?: boolean
  /** 少于该轮次不做反思。 */
  reflectMinTurns?: number
  /** 新颖度低于该值不做反思；`0` 表示关闭闸门、每次都反思。 */
  reflectNoveltyThreshold?: number
  /** 连续多少次反思无新产出后进入退避。 */
  reflectBackoffAfterEmpty?: number
  /** 送审转录音符上限。 */
  reflectMaxTranscriptChars?: number
  /** 是否启用失败经验层（重复犯错的识别与预警）。默认 `true`。 */
  failures?: boolean
  /**
   * 是否在每次刷新时对失败层做一次维护（默认 `true`）：把「已标记解决、但计数证明之后又发生过」
   * 的记录重新打开。关掉后，复发只由**实时观测**重开（`upsertFailures` 那一条路径），
   * 存量记录不会被回溯迁移。
   */
  failureMaintenance?: boolean
  /** 第几次重复开始注入预警。 */
  failureWarnAfter?: number
  /** 第几次重复开始在派发前询问（P2 生效）。 */
  failureAskAfter?: number
  /** 第几次重复开始硬拦截（P2 生效）；`0` 表示从不。 */
  failureBlockAfter?: number
  /** 单次失败预警注入的条数上限。 */
  failureInjectLimit?: number
  /** 失败预警注入的字符上限。 */
  failureInjectChars?: number
  /** 只注入与当前动作相关的失败预警（指纹的工具名/触发场景要对得上）。默认 `true`。 */
  failureInjectRelevantOnly?: boolean
  /** 每个会话最多注入几条失败预警/提醒；`0` 表示不限。默认 `5`。 */
  failureInjectPerSession?: number
  /**
   * 本会话**预警之后又犯同一个错**时再讲一次（默认 `true`）。
   *
   * 关掉它就回到 0.2.x 的旧行为：历史预警每会话每指纹只说一次，复发之后全程沉默 ——
   * 实测头部两个指纹在回合内复发过 47 / 29 次，而模型一个字都没再收到提醒。
   */
  failureRepeatEscalate?: boolean
  /** 失败预警 section 的排序值。 */
  failurePromptOrder?: number
  /** 判定「防住了」的观察窗口（轮次）。 */
  failurePreventWindowTurns?: number
  /** 归一化错误模板的字符上限。 */
  fingerprintTemplateMaxChars?: number
  /**
   * 允许自动推导守卫（即可能被询问/拦截）的工具白名单。
   *
   * 默认只含命令类工具：文件编辑与读取**永不**被自动拦截 ——
   * 拦截范围必须窄，这是硬约束。
   */
  failureGuardTools?: string[]
  /**
   * 是否允许 `technique_learn` 调用模型归纳。
   *
   * 关掉后只有规则路径（零 token、纯结构统计）—— 适合离线或不想为挖掘付费的环境。
   */
  mineUseModel?: boolean
  /** 单次挖掘最多处理的文件数。 */
  mineMaxFiles?: number
  /** 单文件字节上限，超过即跳过。 */
  mineMaxBytes?: number
  /** 单次挖掘最多调用的模型次数。 */
  mineMaxModelCalls?: number
  /** 结构候选成为技巧所需的最小出现次数。 */
  mineMinOccurrences?: number
  /** 单次挖掘的总时长上限（毫秒）；超时保留已产出结果。 */
  mineTimeoutMs?: number
  /** 额外包含的 glob（给出后只有命中的文件才被分析）。 */
  mineInclude?: string[]
  /** 额外排除的 glob。 */
  mineExclude?: string[]
  /**
   * 是否把「结构观察」（本仓库的调用面普查：N 处调用、M 个文件）也落成技巧卡。
   *
   * 默认 `false`：观察进挖掘回执，不进检索语料。实测这类卡在一个真实库里占过 **24.7%**，
   * 且正文自认「具体前置条件与顺序需要结合实现确认」—— 存进去只会压低信噪比。
   */
  mineStoreStructuralCards?: boolean
  /**
   * 导出 `SKILL.md` 的目标目录；缺省为 `<DSH_HOME>/skills`（通常 `~/.dsh/skills`）。
   *
   * 每条技巧落在 `<目录>/<skill 名>/SKILL.md`。
   */
  skillExportDir?: string
  /** 写入 `SKILL.md` 前言 `allowed-tools` 的白名单；留空则不写该字段。 */
  skillAllowedTools?: string[]
}

/** 默认记忆库目录名，落在 dsh home 之下。 */
export const MEMORY_DIR_NAME = 'memory-layer'

/**
 * 各层的默认作用域。
 *
 * `episodic` 刻意留在项目域：它是**原始**会话摘要，含工作区路径与用户原话，
 * 是四层里跨项目外泄风险最高的一层；其余层存的是已抽象的知识，默认全局。
 */
export const LAYER_SCOPE_DEFAULTS: Readonly<
  Record<'episodic' | 'semantic' | 'technique' | 'failure', MemoryScope>
> = {
  episodic: 'project',
  semantic: 'global',
  technique: 'global',
  failure: 'global',
}

/** 环境变量：覆盖 dsh home（与 `@deepseek-ai/dsh-home-paths` 的优先级保持一致）。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** 注入到 system prompt 的 section 名。 */
export const PROMPT_SECTION_NAME = RECALL_BLOCK.section

/** 召回块头部；块首同时是 `isInjectedContext` 的识别标记（见 `injection.ts`）。 */
export const INJECTION_HEADER: readonly string[] = RECALL_BLOCK.header

/** 召回块尾部，给不可信数据一个明确的结束边界。 */
export const INJECTION_FOOTER = RECALL_BLOCK.footer

/**
 * 召回条目的层级标签。
 *
 * 必须**四层全覆盖**。早先注入与检索两处都写成
 * `layer === 'semantic' ? 'long-term' : 'episodic'` 的二元映射，于是 technique 与
 * failure 记录一律被标成 episodic —— 模型会把「一条可复用的技巧」误读成「某次会话的
 * 摘要」，对来源的判断直接错，也就不会去想「这条技巧能不能用在我这儿」。
 */
const LAYER_LABELS: Record<'episodic' | 'semantic' | 'technique' | 'failure', string> = {
  episodic: 'past session',
  semantic: 'long-term fact',
  technique: 'technique',
  failure: 'recurring failure',
}

/**
 * 语义层的标签前缀：真正区分类别的是记录自带的 `kind`，不是「语义层」这个笼统归属。
 *
 * 把一条**偏好**标成 `long-term fact` 是实打实的误导：模型会把它当成客观事实，
 * 而不是「用户希望这样做」，于是既不会在执行前重新确认，也不会在冲突时让位于新指令。
 * `decision` / `constraint` 同理。
 */
const SEMANTIC_LABEL_PREFIX = 'long-term'

/** 合法的语义类别。标签只允许取这四者之一，见 {@link recallLabel}。 */
const SEMANTIC_KINDS: readonly string[] = ['fact', 'preference', 'decision', 'constraint']

/**
 * 渲染一条召回记录的来源标签。
 *
 * **注入与工具输出必须共用这一处**。历史上两处各写一份二元映射，technique / failure
 * 被一致地标成 episodic；后来语义层又要按 `kind` 细分（fact / preference / decision /
 * constraint），两份实现迟早会再次分叉。
 *
 * `kind` 按**白名单**收敛，而不是直接拼进标签：记忆库是明文文件，`readSemantic` 对读到的
 * JSON 只做类型断言、不做校验，因此 `kind` 是**外部可改写的不可信输入**。标签又与正文同处
 * 注入块的一行，一旦其中带换行就能伪造 `--- END UNTRUSTED MEMORY ---` 边界（已实测复现）。
 * 所以这里只接受四个已知取值，其余一律回落 `fact` —— 白名单比「事后净化」更稳：
 * 标签本就不该出现词表以外的任何字符。
 *
 * 技巧层还要带上**信任状态**：`memory_search` 不过滤草稿（只有自动注入过滤），因此同一次
 * 检索里既可能返回 validated 也可能返回 draft；两者都印成 `technique` 会让模型把未验证的
 * 知识当成已验证的用 —— 而它的采用回报正是**推动状态迁移的唯一信号**。状态只在工具输出里印
 * （`status` 参数由 `formatHit` 传入），注入路径不传，避免每请求多花字符。
 *
 * @param layer - 记录所属层。
 * @param kind - 语义记录的类别；其余层忽略。按不可信输入对待。
 * @param options - 附加标注：`superseded`（语义）与 `status`（技巧）。
 * @returns 供模型阅读的标签。
 */
export function recallLabel(
  layer: 'episodic' | 'semantic' | 'technique' | 'failure',
  kind?: unknown,
  options: { superseded?: boolean; status?: TechniqueStatus } = {},
): string {
  if (layer === 'technique') {
    const status = options.status
    return status === undefined ? LAYER_LABELS.technique : `${LAYER_LABELS.technique} (${status})`
  }
  if (layer !== 'semantic') return LAYER_LABELS[layer]
  const safe = typeof kind === 'string' && SEMANTIC_KINDS.includes(kind) ? kind : 'fact'
  // 已被取代的事实只在**显式检索**里出现（注入已过滤）。标注是必须的：模型否则会把
  // 一句已经作废的偏好当成现行约定。
  const suffix = options.superseded === true ? ' (superseded)' : ''
  return `${SEMANTIC_LABEL_PREFIX} ${safe}${suffix}`
}

/** 技巧层注入 section 名。 */
export const TECHNIQUE_SECTION_NAME = TECHNIQUE_BLOCK.section

/** 技巧注入块头部；块首同时是 `isInjectedContext` 的识别标记。 */
export const TECHNIQUE_INJECTION_HEADER: readonly string[] = TECHNIQUE_BLOCK.header

/** 技巧注入块尾部。 */
export const TECHNIQUE_INJECTION_FOOTER = TECHNIQUE_BLOCK.footer

/**
 * 采用回报要求：附在技巧注入块**头部之后**。
 *
 * 两处刻意的选择：
 *
 * 1. 放在头部之后而不是尾部 —— 整块会被 `clipHead` 按字符上限截断，放尾部时块一长
 *    就被截掉，模型看不到要求。
 * 2. 回报走 `technique_apply` 工具，而不是自定义的文本标记。工具是结构化的、会校验
 *    id、能同时表达成功与失败，而且**当场记账**；文本标记只能等会话末再解析，而
 *    `session/disposed` 在长驻会话里根本不会触发 —— 那等于又埋一个「永不生效」。
 */
export const TECHNIQUE_ADOPTION_NOTICE: readonly string[] = [
  'Report each technique you actually APPLIED via `technique_apply` (id or short prefix, outcome,',
  'evidence) — one call can carry several. Anything you do not report counts as NOT adopted.',
]

/**
 * 常驻规则说明行。
 *
 * 块内同时有「本轮相关」与「任何任务都成立」两类条目，语气不同：前者是参考，
 * 后者是必须遵守的约定。不点明这一点，模型会把一条与当前话题无关的偏好当噪声丢掉 ——
 * 而它恰恰是唯一需要跨话题生效的那类记忆。
 */
export const STANDING_RULE_NOTICE: readonly string[] = [
  'Entries marked `long-term preference` / `long-term constraint` below are STANDING RULES:',
  'they apply to every task regardless of topic, and a newer user instruction overrides them.',
]

/** 落盘前判「库内复述」的包含度门槛（真库实测：真新知识 ≤0.412，近重复 ≥0.53）。 */
const LIBRARY_RESTATEMENT_RATIO = 0.6

/**
 * 判断「库里的最佳答案是不是草稿」时向后多扫几条。
 *
 * 用分数比较而不是命中条数，是因为实测 BM25 会把 `limit` 填满：三种真实查询在默认参数下
 * 都返回 5 条已验证命中，「命中不足 N 条」这个条件永远不成立。改成同一份排名内
 * `最佳草稿分 > 最佳已验证分` 后，三条查询分别以 14.7>13.6、8.9>6.5、22.0>8.8 触发，
 * 且正好把三条对题的草稿卡送到第一屏。`limit` 被调用方调小时仍要能看见隐藏草稿，故取 5。
 */
const DRAFT_SCAN_LIMIT = 5

/** 落盘前判「复述本会话刚读过的条目」的包含度门槛；比库内复述更该拦，所以更低。 */
const SESSION_RESTATEMENT_RATIO = 0.5

/**
 * 注入段内判「召回命中彼此近重复」的包含度门槛（与「开头 80 字符相同」**同时**成立才丢弃）。
 *
 * 取落盘侧同一个数 0.6 的依据是实测：gt6 一次召回里 6 条情景摘要中有 5 条来自同一批子代理
 * 会话，**全文**两两包含度 0.682–0.832、开头 80 字符完全相同（渲染截断后看是 0.864–0.946）。
 * 它们的分歧全在公共前言之后，而每条渲染时只分到 ~418 字符、前言恰好占满 ——
 * 也就是说模型从来没有读到过那部分分歧：付了 5 遍 418 字符，只为读同一段前言。
 *
 * 「开头相同」是必须的第二个条件：同题不同参数的条目（`变体 1` / `变体 2`）开头就分叉，
 * 只按包含度去重会把它们合并，等于删掉可执行信息 —— 既有用例当场抓住了这一点。
 */
const RECALL_DUPLICATE_RATIO = 0.6

/**
 * 条目内容的廉价指纹（FNV-1a 32 位，十六进制）。
 *
 * 用途只有一个：判断「本会话上次给过的那条，内容还是不是同一份」。条目正文只有几百字符、
 * 每轮至多几条，因此不需要密码学哈希；`crypto` 那条路还要走密钥，成本与复杂度都不划算。
 *
 * @param text - 条目正文。
 * @returns 8 位十六进制指纹。
 */
function contentHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 一个引用针要在**几张卡**上都成立才算「泛化针」（评审 F1）。
 *
 * 依据：引用针的语义是「这张卡的线索出现在模型的动作里」。若同一个符号在三张以上的卡上都成立，
 * 它就不能说明是**哪一张**被用上了 —— 真库普查里 `dependsOn`(6 张)、`registerScreen`(5)、
 * `Task.dependsOn`(4)、`SubscribeEvent`(4)、`technique_save`(3)、`OreDictionary.registerOre`(3)
 * 都是这一类（框架/工具通用名），命中它们等于给一批无关卡同时记账。
 *
 * 阈值取 3 而不是 2：两张卡共享一个符号时，「两张都沾边」仍是有信息的观察；
 * 到三张就退化成「这门框架里到处都是的名字」。
 */
const GENERIC_NEEDLE_CARDS = 3

/**
 * ③ 文件级精确命中：每个会话最多记多少个「针 + 文件」关联。
 *
 * 只是内存卫生的上限（超长会话里一个文件一个条目，不封顶会无界增长）；200 远超真实会话里
 * 被符号点到的文件数（实测 3 天窗口内平均每会话十几个）。
 */
const NEEDLE_FILES_PER_SESSION = 200

/**
 * 把一条技巧草稿压成用于复述比对的正文。
 *
 * 与存储用的 `techniqueText` 保持同源字段（名称/触发/正文/步骤/不变量/坑/判据），
 * 因为这些正是「这条技巧讲的是什么」的全部信息。
 *
 * @param draft - 技巧草稿。
 * @returns 用于比对的文本。
 */
function draftText(draft: TechniqueDraft): string {
  return [
    draft.name,
    draft.when,
    draft.summary,
    ...(draft.steps ?? []),
    ...(draft.invariants ?? []),
    ...(draft.pitfalls ?? []),
    ...(draft.verify ?? []),
    draft.reuse ?? '',
    draft.subject ?? '',
    draft.location ?? '',
  ].filter(part => part.length > 0).join('\n')
}

/** 失败预警注入 section 名。 */
export const FAILURE_SECTION_NAME = FAILURE_BLOCK.section

/** 失败注入块头部；块首同时是 `isInjectedContext` 的识别标记。 */
export const FAILURE_INJECTION_HEADER: readonly string[] = FAILURE_BLOCK.header

/** 失败预警注入块尾部。 */
export const FAILURE_INJECTION_FOOTER = FAILURE_BLOCK.footer

/** 「工作前先检索」常驻指引的 section 名。 */
export const GUIDANCE_SECTION_NAME = GUIDANCE_BLOCK.section

/** 指引块头部；块首同时是 `isInjectedContext` 的识别标记。 */
export const GUIDANCE_INJECTION_HEADER: readonly string[] = GUIDANCE_BLOCK.header

/** 指引块尾部。 */
export const GUIDANCE_INJECTION_FOOTER = GUIDANCE_BLOCK.footer

/** 配置 schema：所有字段都有默认值，因此 `apply` 里拿到的配置始终完整。 */
export const Config: z<Config> = z.object({
  dir: z.string(),
  recallLimit: z.natural().min(1).max(20).default(5),
  recallChars: z.natural().min(200).max(20_000).default(4000),
  /** ① 已完整给过、内容未变的召回条目改发指针形态（见 Config 里的说明）。默认 `true`。 */
  recallRepeatCompact: z.boolean().default(true),
  injectPrompt: z.boolean().default(true),
  promptOrder: z.number().default(250),
  registerTools: z.boolean().default(true),
  indexBackend: z.union([z.const('memory'), z.const('sqlite')]).default('memory'),
  captureUserChars: z.natural().min(80).max(20_000).default(2000),
  captureAssistantChars: z.natural().min(80).max(20_000).default(1200),
  maxTurnsPerSession: z.natural().min(1).max(500).default(60),
  distillOnTurnEnd: z.boolean().default(true),
  distillTimeoutMs: z.natural().min(1000).max(300_000).default(30_000),
  provider: z.string(),
  model: z.string(),
  encrypt: z.boolean().default(true),
  keyFile: z.string(),
  layerScopes: z.object({
    episodic: z.union([z.const('project'), z.const('global')]),
    semantic: z.union([z.const('project'), z.const('global')]),
    technique: z.union([z.const('project'), z.const('global')]),
    failure: z.union([z.const('project'), z.const('global')]),
  }),
  partition: z.string().default('default'),
  techniques: z.boolean().default(true),
  /**
   * 死重维护（0.2.10）：每次刷新时检查一次「领域归一化 + 归档死重」，有新可归档项才写盘。
   *
   * 只做**可逆**的事：领域名折叠大小写/别名，以及给死重草稿打 `archivedAt`。归档卡退出自动注入
   * 与排序，但 `technique_search` 仍然看得到、仍然能按 id 展开 —— 删掉就找不回来了。
   */
  techniqueMaintenance: z.boolean().default(true),
  /**
   * 死重归档的最小年龄（天）。默认 `14`；`0` = 不等年龄（只要满足「从未检索/引用/成功」就归档）。
   *
   * ⚠️ 实测提醒：本机真库最老的记录才 8.5 天，因此默认 14 天**当前一条都不会归档** —— 这是
   * 有意为之（年轻库里「还没人查」不等于「死重」），代价是这项收益要等库变老才显现。
   */
  archiveAfterDays: z.natural().min(0).max(3650).default(14),
  /**
   * 归档豁免的领域前缀：正在开发的领域里，今天没人查的卡明天就要用。默认 `dsh-` / `sdo`。
   *
   * 匹配规则是「等于该项或以该项开头」，因此 `dsh-` 覆盖 `dsh-plugin`、`dsh-memory-layer`。
   */
  archiveKeepDomains: z.array(z.string()).default(['dsh-', 'sdo']),
  /**
   * 单个领域允许保留的活跃草稿数上限（`0` = 不限）。默认 `150`。
   *
   * 归档只能清一次存量，而挖掘/反思还在按同样速度产出（实测约 +14 条/4 小时）—— 没有这道
   * 护栏，死重会以同样的速度长回来。超限时按「最老且从未被检索/引用/成功」先出局。
   *
   * ⚠️ 规模提示（评审 F4）：真库最大领域 `plantuml` 129 条，因此 **150 在当前规模下不会触发**
   * （上限 100 → 淘汰 29 条、50 → 79 条）。它是「随增长才开火」的护栏，不是当下就生效的清库手段。
   */
  maxActiveDraftsPerDomain: z.natural().min(0).max(10_000).default(150),
  techniqueLimit: z.natural().min(1).max(10).default(3),
  techniqueChars: z.natural().min(200).max(20_000).default(3000),
  techniquePromptOrder: z.number().default(260),
  injectMinMatched: z.natural().min(0).max(20).default(2),
  injectStandingRules: z.natural().min(0).max(20).default(4),
  /**
   * 常驻规则**每隔几轮重发一次全文**（默认 `10`；`0` = 只在规则集变化时重发）。
   *
   * 规则集不变时，常驻条目改发紧凑形态（见 `compactStandingText`）：实测真库里
   * preference/constraint 正文中位数 57 字符，而它们**每轮**都要印一遍，是召回段里唯一必然
   * 重复的部分。定期重发全文是一道保险：压缩若把某条规则的关键限定语削掉，最多 10 轮后
   * 会恢复一次完整表述。
   */
  standingRuleFullEveryTurns: z.natural().min(0).max(1000).default(10),
  injectStopwords: z.array(z.string()).default([]),
  techniqueAdvisory: z.boolean().default(true),
  /**
   * L2：检测到「模型引用了某条被推给它的技巧」时，在工具回执后附一行回报提示。
   *
   * 只在**真的被引用**时出现（稀有事件），因此不像常驻指引那样每轮付费。
   */
  referenceNudge: z.boolean().default(true),
  techniqueAdvisoryDrafts: z.boolean().default(true),
  techniqueAdvisoryMax: z.natural().min(0).max(100).default(12),
  // 未检索会话的首触顾问：会话还没查过库时，把与本轮最相关的一条技巧（含要点）推到动作点。
  // 只靠「本会话还没查过库」那句提醒实测无效（提醒 145 次、主动查询率仍 1%），所以换成
  // 走已验证有效的顾问通道把真东西递过去。
  firstContactAdvisory: z.boolean().default(true),
  // 首触顾问的**每会话条数上限**（0 = 关闭）。只靠「查过库就闭嘴」实测让 31/49 个会话
  // 每轮各收一条（占顾问总量 62%），所以次数必须可配且有硬上限。
  firstContactAdvisoryMax: z.natural().min(0).max(20).default(1),
  injectMinScore: z.number().min(0).max(1000).default(0),
  guidancePromptOrder: z.number().default(265),
  guidance: z.boolean().default(true),
  exampleMaxLines: z.natural().min(1).max(40).default(8),
  exampleMaxChars: z.natural().min(40).max(4000).default(480),
  allowConfidentialGlobal: z.boolean().default(false),
  reflectOnSessionEnd: z.boolean().default(true),
  reflectMinTurns: z.natural().min(1).max(50).default(3),
  // 0 表示关闭闸门（每次都反思），因此下界是 0。
  reflectNoveltyThreshold: z.number().min(0).max(1).default(0.15),
  reflectBackoffAfterEmpty: z.natural().min(1).max(100).default(5),
  reflectMaxTranscriptChars: z.natural().min(1000).max(200_000).default(24_000),
  failures: z.boolean().default(true),
  /** 失败层的存量维护（重开已复发但被标为已解决的记录）。默认 `true`。 */
  failureMaintenance: z.boolean().default(true),
  failureWarnAfter: z.natural().min(1).max(50).default(2),
  failureAskAfter: z.natural().min(1).max(50).default(3),
  // 0 表示从不硬拦截：拦截会阻断正常工作，必须显式开启。
  failureBlockAfter: z.natural().min(0).max(50).default(0),
  failureInjectLimit: z.natural().min(1).max(10).default(3),
  failureInjectChars: z.natural().min(200).max(20_000).default(1500),
  // 只注入与**当前动作**相关的预警：指纹的工具名/触发场景与本会话用过的工具、最近轮次的
  // 用户原话与文件对不上时，这条预警只是在讲一个与本轮无关的故事（实测 24 小时内失败段
  // 花了 131k 字符，占插件注入的 18%）。本会话**确实犯过**的指纹永远放行。
  failureInjectRelevantOnly: z.boolean().default(true),
  // 每个会话最多注入几条失败预警/提醒（0 = 不限）。逐指纹去重只能保证「同一条不重复」，
  // 保证不了总量：指纹一多，一轮 3 条、连着十几轮就花掉上万字符。
  failureInjectPerSession: z.natural().min(0).max(50).default(5),
  // 预警之后又犯同一个错（本会话内）：再说一次，而且换成「刚刚又犯」的直接口吻。
  // 逐指纹只讲一次这条规矩是给「还没犯过」的会话省 token 的；本会话**已经犯过**之后，
  // 沉默的代价是模型在同一个坑里连撞十次也没人提醒（实测回合内复发 47 / 29 次的头部指纹）。
  failureRepeatEscalate: z.boolean().default(true),
  failurePromptOrder: z.number().default(255),
  failurePreventWindowTurns: z.natural().min(1).max(20).default(3),
  fingerprintTemplateMaxChars: z.natural().min(40).max(2000).default(200),
  failureGuardTools: z.array(z.string()).default([...DEFAULT_GUARD_TOOLS]),
  mineUseModel: z.boolean().default(true),
  mineMaxFiles: z.natural().min(1).max(5000).default(200),
  mineMaxBytes: z.natural().min(1024).max(10_000_000).default(524_288),
  mineMaxModelCalls: z.natural().min(0).max(100).default(8),
  mineMinOccurrences: z.natural().min(2).max(50).default(2),
  mineTimeoutMs: z.natural().min(1000).max(600_000).default(120_000),
  mineInclude: z.array(z.string()).default([]),
  mineExclude: z.array(z.string()).default([]),
  mineStoreStructuralCards: z.boolean().default(false),
  skillExportDir: z.string(),
  skillAllowedTools: z.array(z.string()).default([]),
})

/** system prompt 注册服务的最小契约（服务缺失时整块跳过，因此不硬依赖其类型包）。 */
interface PromptContextRegistry {
  /**
   * 注册一段动态 prompt 上下文。
   * @param entry - 名称、排序与文本提供者。
   * @returns 卸载该注册的 disposer。
   */
  context(entry: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void
}

/** LLM 服务的最小契约：只用到 `stream`。 */
interface LlmStreamLike {
  /**
   * 发起一次流式生成。
   * @param options - 生成选项。
   * @returns 原始 chunk 流。
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** 日志最小契约：只用到 debug。 */
interface LoggerLike {
  /**
   * 输出一条诊断日志。
   * @param message - 日志正文。
   */
  debug(message: string): void
}

/** 解析后的运行时设置：把可选配置收敛成确定值。 */
interface Settings {
  dir: string
  scopeEpisodic: MemoryScope
  scopeSemantic: MemoryScope
  scopeTechnique: MemoryScope
  scopeFailure: MemoryScope
  partition: string
  recallLimit: number
  recallChars: number
  recallRepeatCompact: boolean
  injectPrompt: boolean
  promptOrder: number
  registerTools: boolean
  indexBackend: 'memory' | 'sqlite'
  captureUserChars: number
  captureAssistantChars: number
  maxTurnsPerSession: number
  distillOnTurnEnd: boolean
  distillTimeoutMs: number
  provider: string | undefined
  model: string | undefined
  encrypt: boolean
  keyFile: string | undefined
  techniques: boolean
  techniqueLimit: number
  techniqueChars: number
  techniquePromptOrder: number
  injectMinMatched: number
  injectStandingRules: number
  standingRuleFullEveryTurns: number
  injectMinScore: number
  injectionGate: RelevanceGate
  guidancePromptOrder: number
  guidance: boolean
  techniqueAdvisory: boolean
  referenceNudge: boolean
  techniqueAdvisoryDrafts: boolean
  techniqueAdvisoryMax: number
  firstContactAdvisory: boolean
  firstContactAdvisoryMax: number
  techniqueMaintenance: boolean
  archiveAfterDays: number
  archiveKeepDomains: string[]
  maxActiveDraftsPerDomain: number
  exampleMaxLines: number
  exampleMaxChars: number
  allowConfidentialGlobal: boolean
  reflectOnSessionEnd: boolean
  reflectMinTurns: number
  reflectNoveltyThreshold: number
  reflectBackoffAfterEmpty: number
  reflectMaxTranscriptChars: number
  failures: boolean
  failureMaintenance: boolean
  failureWarnAfter: number
  failureAskAfter: number
  failureBlockAfter: number
  failureInjectLimit: number
  failureInjectChars: number
  failureInjectRelevantOnly: boolean
  failureInjectPerSession: number
  failureRepeatEscalate: boolean
  failurePromptOrder: number
  failurePreventWindowTurns: number
  fingerprintTemplateMaxChars: number
  failureGuardTools: string[]
  mineUseModel: boolean
  mineMaxFiles: number
  mineMaxBytes: number
  mineMaxModelCalls: number
  mineMinOccurrences: number
  mineTimeoutMs: number
  mineInclude: string[]
  mineExclude: string[]
  mineStoreStructuralCards: boolean
  skillExportDir: string
  skillAllowedTools: string[]
}

/**
 * 安装插件：捕获会话要点、沉淀三层记忆、按相关度召回。
 * @param ctx - Cordis 上下文。
 * @param config - 已校验的插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const settings = resolveSettings(normalizeConfig(config))
  const logger = ctx.logger(name)
  const store = new MemoryStore(settings.dir, resolveCodec(settings, logger))
  /** 瞬时层：运行中会话的要点，仅存内存。 */
  const live = new Map<string, LiveSession>()
  /** 最近一次活跃的会话，用于定位「当前项目目录」与召回查询词。 */
  let current: LiveSession | undefined
  /**
   * 最近一次见过的会话工作目录。
   *
   * 会话被销毁后 `current` 会清空，但**项目归属不会因此消失**：此后调用
   * `technique_apply` / `technique_export` 这类项目域操作时，若回退到 `process.cwd()`，
   * 就会读写到另一个目录下，产生「记录明明存在却找不到」的静默错乱。
   */
  let lastCwd: string | undefined
  /**
   * 召回索引的内存镜像，按会话工作目录分桶。
   *
   * 每个桶 = 该项目域的 episodic / semantic / technique + 全局域的同一批。
   * 桶未加载时返回空（宁可不注入，也不注入别的项目的记忆）。
   */
  const corpora = new Map<string, RecallDoc[]>()
  /** 技巧全文索引：注入与 `technique_get` 需要完整正文，而不只是可检索文本。 */
  const techniqueById = new Map<string, TechniqueRecord>()
  /** 失败记录索引：按 id 与指纹双键，供预警与工具使用。 */
  const failureById = new Map<string, FailureRecord>()
  const failureByKey = new Map<string, FailureRecord>()
  /**
   * 每会话的失败观测状态。
   *
   * `callNames` 是必需的：`tool/result` 事件**不带工具名**，只能靠 `callId` 与先前的
   * `tool/call` 关联；缺了它，「同一个错误」就少了区分度最高的一维。
   */
  const failuresBySession = new Map<string, {
    callNames: Map<string, string>
    /** callId → 原始参数 JSON；`tool/result` 不带参数，推导守卫只能靠它。 */
    callArgs: Map<string, string>
    /** 本会话最近一次**机械**失败的指纹键：用户纠偏时把正确做法挂到它身上。 */
    lastMachineKey?: string
    /**
     * 那次机械失败发生在第几轮。
     *
     * 只有「紧跟失败」的纠偏才算数（DEF-04）：`lastMachineKey` 一旦写入就再不清除，
     * 单看它会让第 3 轮的跨话题纠偏挂到第 1 轮的无关失败上。窗口取
     * {@link CORRECTION_WINDOW_TURNS} 轮。
     */
    lastMachineTurn?: number
    lastSeenTurn: Map<string, number>
    warned: Map<string, { turn: number; recordId: string }>
    /**
     * 本会话已经注入过的预警（按指纹）→ 注入时在第几轮。
     *
     * 值必须是**轮次**而不只是「发过」：判断「预警之后又犯了」得比较「这条最近一次被观测到的
     * 轮次」与「上次讲解它的轮次」。只存一个集合的话，先犯、后讲、再渲染，就会被误判成复发。
     */
    advisoriesSent: Map<string, number>
    /**
     * 本会话**已升级**讲解过的指纹 → 升级发生在第几轮。
     *
     * 只用于「同一轮内重复渲染保持同形态」：宿主每轮的 `text()` 是惰性回调，可能被调用多次，
     * 若第二次渲染因为「基线已推进」而返回空串，取后一次结果的路径就会把这条升级吞掉。
     */
    repeatAt: Map<string, number>
    /** 本会话观测到该指纹几次（用于「刚刚又犯·本会话第 N 次」的 N）。 */
    observedCount: Map<string, number>
    forgiven: Set<string>
    /** 本地初筛命中的纠偏候选原文，等模型在反思里定夺（见 `applyCorrections`）。 */
    correctionCandidates: string[]
  }>()
  /** 反思（会话内提炼）的累计指标，用于自适应退避与「经验复利」展示。 */
  let metrics: ReflectionMetrics = emptyMetrics()
  /** 进程启动时读到的累计值：用来把「本次进程」与「累计」两个口径分开报，互不冒充。 */
  let metricsBaseline: ReflectionMetrics = emptyMetrics()
  /** 遥测计数器有改动、尚未落盘。 */
  let metricsDirty = false
  /** 上次落盘遥测的时间：注入每请求都会发生，必须节流，否则变成写风暴。 */
  let metricsSavedAt = 0
  /** 所有后台任务；`session/flush` 会等待它们。 */
  const pending = new Set<Promise<void>>()

  /** 登记一个后台任务：统一兜底日志，并保证 `pending` 里的 promise 永不 reject。 */
  const track = (task: Promise<void>): void => {
    const guarded = task.catch(error => {
      logger.warn(`memory: background task failed: ${describe(error)}`)
    })
    pending.add(guarded)
    void guarded.finally(() => pending.delete(guarded))
  }

  /**
   * 遥测落盘（P4）的节流窗口。
   *
   * 注入是**每请求**都会发生的事，逐次落盘就是写风暴（`store` 每次写入都要拿跨进程锁）；
   * 而这一层要的是「热重载后账目不清零」，一分钟的粒度足够。会话收尾与反思落盘会强制写。
   */
  const METRICS_FLUSH_MS = 60_000

  /**
   * 把累计遥测写进 `metrics.json`（P4）。
   *
   * 三个调用时机：a) 遥测计数变化后的**节流**落盘；b) 会话收尾时的强制落盘；c) 反思落盘
   * （那条路本来就在写 metrics，顺带把遥测带上）。失败只记 debug：遥测是增益，不能影响会话。
   *
   * @param force - 忽略节流窗口，立即写。
   * @returns 写入完成时 resolve。
   */
  const flushMetrics = async (force = false): Promise<void> => {
    if (!metricsDirty) return
    const now = Date.now()
    if (!force && now - metricsSavedAt < METRICS_FLUSH_MS) return
    metricsDirty = false
    metricsSavedAt = now
    try {
      await store.saveMetrics(metrics)
    } catch (error) {
      logger.debug(`memory: could not persist telemetry: ${describe(error)}`)
    }
  }

  /**
   * 记一次「渲染了非空注入块」，并按节流窗口落盘。
   *
   * 包在 section 的 `text()` 外面（而不是在每个渲染函数里各写一遍）：四段的返回形态不同，
   * 但「非空才算注入」这条判据只有一个。
   */
  const countInjection = (render: () => string): string => {
    const text = render()
    if (text.length > 0) {
      metrics.injections += 1
      metricsDirty = true
      track(flushMetrics())
    }
    return text
  }

  /** 某个会话工作目录所属的桶键。 */
  const bucketKey = (cwd: string | undefined): string => cwd ?? process.cwd()

  /**
   * 解析「当前项目目录」：显式参数 > 活跃会话 > 最近见过的会话 > 进程 cwd。
   *
   * 三处入口（`refresh` / `corpusFor` / `projectCwd`）必须用**同一个**解析结果，
   * 否则会出现「写进了 A 桶、却去 B 桶里读」的静默错乱。
   */
  const resolveCwd = (cwd?: string): string | undefined => cwd ?? current?.cwd ?? lastCwd

  /** 当前项目目录。 */
  const projectCwd = (): string => resolveCwd() ?? process.cwd()

  /**
   * 重新加载指定会话目录所属的召回桶（项目域 + 全局域，含技巧层）。
   *
   * 读取时**同时**读项目域与全局域：即使某层的写入作用域是 `project`，
   * 既往写入全局域的知识也应继续可见。
   *
   * @param cwd - 目标项目目录；缺省用当前会话。
   */
  /**
   * 技巧层的可选 FTS5 索引（真源仍是 JSONL）。
   *
   * 只在配置开启且 `node:sqlite` 可用时创建；之后所有失败都表现为「打分器返回 undefined」，
   * 由 `recallFacets` 自动回退内存 BM25 —— 因此它坏了不会让检索变不可用，只会变慢。
   */
  const techniqueIndex = settings.indexBackend === 'sqlite' && loadSqlite() !== undefined
    ? new SqliteTechniqueIndex(join(settings.dir, SQLITE_INDEX_FILE))
    : undefined
  if (settings.indexBackend === 'sqlite' && techniqueIndex === undefined) {
    logger.warn('memory: indexBackend=sqlite requested but node:sqlite is unavailable (needs Node >= 22.5); falling back to in-memory BM25')
  }

  /** 「整库解不开」与「个别坏行」各自只吼一次，避免每轮刷屏。 */
  let integrityWarned = false
  let undecodableWarned = false

  /**
   * 本轮技巧段会注入哪些技巧（缓存：查询词 → id 列表）。
   *
   * 记忆召回段的语料里也含技巧层，两块各自渲染时同一条技巧会以两种形态各付一遍 token。
   * 缓存让**两个 section 共享同一份判定**，谁先渲染谁算；`refresh()` 一旦重建语料就作废。
   */
  let techniqueHitCache: { query: string; hits: readonly RecalledMemory[] } | undefined

  /**
   * 重算「引用针缓存 + 泛化针表」。
   *
   * 两者都从真源派生：记录内容可能被就地更新（`technique_save(id=…)`），缓存必须跟着语料一起
   * 作废，否则会拿旧符号面去匹配。**必须在死重维护之前调用** —— 维护里的「历史引用清零」要判
   * 「有效针集是否为空」，而有效针集 = 去掉泛化针之后剩下的针。
   *
   * @param records - 当前桶的全部技巧记录（已按 id 去重）。
   */
  const refreshNeedleIndex = (records: readonly TechniqueRecord[]): void => {
    needlesById.clear()
    const needleCards = new Map<string, number>()
    for (const record of records) {
      for (const needle of new Set(referenceNeedles(record))) {
        needleCards.set(needle, (needleCards.get(needle) ?? 0) + 1)
      }
    }
    genericNeedles = new Set(
      [...needleCards].filter(([, cards]) => cards >= GENERIC_NEEDLE_CARDS).map(([needle]) => needle),
    )
  }

  /**
   * 死重维护：领域名归一化 + 归档「从未被检索/引用/成功」的旧草稿。
   *
   * 为什么放在 `refresh` 里而不是 `apply`：真源是按**桶**（工作目录）分文件的，`apply` 时刻
   * 还没有工作目录；而 `refresh` 手里正好有这一桶的全部技巧记录。
   *
   * 返回是否真的写盘了（调用方据此重读一次，让索引与语料基于新状态）。
   *
   * @param directory - 当前桶的工作目录（project 作用域的记录落在这里）；未知时为 `undefined`。
   * @param records - 该桶已加载的技巧记录（project + global 去重后）。
   * @returns 写盘了返回 `true`。
   */
  const maintainTechniques = async (
    directory: string | undefined,
    records: readonly TechniqueRecord[],
  ): Promise<boolean> => {
    if (!settings.techniqueMaintenance || records.length === 0) return false
    const now = Date.now()
    // 补丁按 id 收敛（而不是数组追加）：年龄判据与领域上限可能命中同一条记录，用 Map 就天然幂等。
    const patchById = new Map<string, TechniqueRecord>()
    // P3 领域回填：没领域的卡，从标签里认一个**本桶已经在用的领域名**（见 `deriveDomainFromTags`）。
    // 只认已用词表，因此不会造出新领域；认不出来的一律留空（实测真库 125 条无领域里能认出的 33 条）。
    // 词表在循环前**一次定死**：边回填边扩充词表会让一条卡的标签把另一个标签变成「已用领域」。
    const domainVocab = new Set<string>()
    for (const record of records) {
      const domain = normalizeDomain(record.domain)
      if (domain !== undefined) domainVocab.add(domain)
    }
    // 回填会改变合并身份（`techniqueKey` 含领域）：若另一条卡与本条**同名同触发条件**，
    // 回填之后两者撞键，下一次 upsert 只会留下其中一条（`DOMAIN_ALIASES` 那条注释同款危险）。
    // 真库当前没有同名同触发的卡（500 条 0 组），但这条护栏必须写死：数据损失不可逆。
    const nameWhenCount = new Map<string, number>()
    for (const record of records) {
      const pair = `${record.name}\u0000${record.when}`
      nameWhenCount.set(pair, (nameWhenCount.get(pair) ?? 0) + 1)
    }
    let archived = 0
    let renamed = 0
    let derivedDomains = 0
    for (const record of records) {
      const normalized = normalizeDomain(record.domain)
      const ambiguous = (nameWhenCount.get(`${record.name}\u0000${record.when}`) ?? 0) > 1
      const domain = normalized ?? (ambiguous ? undefined : deriveDomainFromTags(record.tags, domainVocab))
      const domainChanged = domain !== record.domain
      const archivable = isArchivable(record, now, {
        afterDays: settings.archiveAfterDays,
        keepDomains: settings.archiveKeepDomains,
      })
      if (!domainChanged && !archivable) continue
      if (domainChanged) renamed += 1
      if (normalized === undefined && domain !== undefined) derivedDomains += 1
      if (archivable) archived += 1
      // 逐字段条件构造（而不是 `domain: undefined`）：`exactOptionalPropertyTypes` 下，
      // 「显式写 undefined」与「没有这个字段」不是一回事，后者才是「没有领域」。
      const patch: TechniqueRecord = { ...record, ...(archivable ? { archivedAt: now } : {}) }
      if (domainChanged) {
        if (domain === undefined) delete patch.domain
        else patch.domain = domain
      }
      patchById.set(record.id, patch)
    }
    // ③c：按领域设**活跃草稿上限**，超限时先归档该领域里最老且从未被用过的草稿。
    // 为什么要另设一道（年龄判据已经存在）：归档只能清一次存量，而挖掘/反思仍在按同样速度产出
    // 新草稿（实测约 +14 条/4 小时）；没有这道护栏，死重会以同样的速度长回来。
    // 与年龄判据的分工：这里**不看年龄**（领域饱和本身就是信号），但只动从未被用过的卡，
    // 且豁免领域完全不参与（正在开发的领域里，今天没人查的卡明天就要用）。
    let capped = 0
    const cap = settings.maxActiveDraftsPerDomain
    if (cap > 0) {
      // 计数看**补丁生效后**的状态：被年龄判据归档的卡已经不算活跃，只改了领域名的那条仍然算。
      const effective = records.map(record => patchById.get(record.id) ?? record)
      const byDomain = new Map<string, TechniqueRecord[]>()
      for (const record of effective) {
        if (record.status !== 'draft' || record.archivedAt !== undefined) continue
        const domain = normalizeDomain(record.domain)
        if (domain === undefined) continue
        if (settings.archiveKeepDomains.some(prefix => domain === prefix || domain.startsWith(prefix))) continue
        byDomain.set(domain, [...(byDomain.get(domain) ?? []), record])
      }
      for (const group of byDomain.values()) {
        const excess = group.length - cap
        if (excess <= 0) continue
        const evict = group
          .filter(record => isArchivable(record, now, { afterDays: 0, keepDomains: settings.archiveKeepDomains }))
          .sort((left, right) => left.ts - right.ts)
          .slice(0, excess)
        for (const record of evict) {
          patchById.set(record.id, { ...record, archivedAt: now })
          archived += 1
          capped += 1
        }
      }
    }
    // ⑤ 引用口径修复（0.2.14）：把**旧口径**攒起来的 `referenced` 清零并盖上当前版本号。
    //
    // 为什么整批清、而不是只清「有效针集为空」的卡：0.2.8–0.2.13 的针集里混着语言内置名
    // （`readFileSync`…）与框架泛化名（`dependsOn`…），那些计数**无法区分**哪一次是真引用 ——
    // 于是 `memory_stats` 的引用率前后不可比，L5 排序也一直吃着这批不可信的历史值。
    // `referenced` 只喂 L5 的排序加成（+10% 封顶），清零的代价是短期内少一点排序信号，
    // 换来的是「引用率」这个观测从此可用。
    // 幂等：盖过章的卡（`referenceEpoch >= REFERENCE_EPOCH`）下一轮不再命中。
    let repairedReferences = 0
    for (const record of records) {
      if ((record.referenced ?? 0) === 0) continue
      if ((record.referenceEpoch ?? 0) >= REFERENCE_EPOCH) continue
      const base = patchById.get(record.id) ?? record
      const fixed: TechniqueRecord = { ...base, referenced: 0, referenceEpoch: REFERENCE_EPOCH }
      delete fixed.lastReferencedAt
      patchById.set(record.id, fixed)
      repairedReferences += 1
    }
    const patches = [...patchById.values()]
    if (patches.length === 0) return false
    try {
      const applied = await store.updateTechniques(patches, directory)
      if (applied > 0) {
        logger.info(
          `memory: technique maintenance on ${directory ?? '(unknown cwd)'} — ${applied} record(s) rewritten `
          + `(${archived} archived${capped === 0 ? '' : `, ${capped} over per-domain cap`}, `
          + `${renamed} domain name(s) normalized`
          + `${derivedDomains === 0 ? '' : `, ${derivedDomains} derived from tags`}`
          + `${repairedReferences === 0 ? '' : `, ${repairedReferences} pre-epoch reference count(s) reset to 0 (epoch ${REFERENCE_EPOCH})`})`,
        )
      }
      return applied > 0
    } catch (error) {
      // 维护是增益：失败只记日志，绝不让它影响正常的读取与检索。
      logger.warn(`memory: technique maintenance failed: ${describe(error)}`)
      return false
    }
  }

  /**
   * ④ 的**存量修复**：把「已被标记解决、但计数证明它之后又发生过」的失败记录重新打开。
   *
   * 为什么必须有这一步（而不是只改写入路径）：这些记录是旧语义下写的 —— `resolvedAt` 一直留着，
   * 于是 `shouldWarn` 永远 false。真库 4 条已解决记录里 3 条属于这一类（69 / 22 / 1 次复发，
   * 最后一次就在当天）。不迁移的话它们要等到**下一次**真的复发才会重开，而那正是最该被提前告知的
   * 时刻（「你上次以为修好了，其实没有」）。
   *
   * 两个取值上的取舍：
   *  - 历史复发次数进 `relapses`（可见、可统计）；
   *  - `occurrencesAtReopen` 取**当前**计数，让升级强度从这个回合的 `warn` 重新起算 —— 直接把 69
   *    次当回合会立刻跳到 ask/block，把「重开」变成误伤（这些记录都没有 guard，本就不该拦）。
   * 幂等：写完 `resolvedAt` 就没了，下一次同一条件不再命中。
   *
   * @param records - 该桶已加载的失败记录（project + global 去重后）。
   * @param directory - 当前桶的工作目录；未知时为 `undefined`。
   * @returns 写盘了返回 `true`。
   */
  const maintainFailures = async (
    records: readonly FailureRecord[],
    directory: string | undefined,
  ): Promise<boolean> => {
    if (!settings.failureMaintenance) return false
    const patches: FailureRecord[] = []
    for (const record of records) {
      if (record.resolvedAt === undefined || record.occurrencesAtResolve === undefined) continue
      const relapsed = record.occurrences - record.occurrencesAtResolve
      if (relapsed <= 0) continue
      const patch: FailureRecord = {
        ...record,
        relapses: (record.relapses ?? 0) + relapsed,
        lastRelapseAt: record.lastSeen,
        // 与实时路径同一约定（见 `FailureRecord.occurrencesAtReopen`）：**已计入的最后一次发生**
        // 就是本回合的第 1 次，于是回合起点 = 总数 − 1，`episodeOccurrences()` 两处同值。
        occurrencesAtReopen: record.occurrences - 1,
        status: 'validated',
      }
      delete patch.resolvedAt
      // 强度也走同一个来源（`episodeOccurrences`），不再手写 `enforcementFor(1, …)`。
      patch.enforcement = enforcementFor(episodeOccurrences(patch), escalation)
      patches.push(patch)
    }
    if (patches.length === 0) return false
    try {
      const applied = await store.updateFailures(patches, directory)
      if (applied > 0) {
        logger.info(
          `memory: failure maintenance — ${applied} resolved record(s) had relapsed and were re-opened`,
        )
      }
      return applied > 0
    } catch (error) {
      // 维护是增益：失败只记日志，绝不让它影响正常的读取与预警。
      logger.warn(`memory: failure maintenance failed: ${describe(error)}`)
      return false
    }
  }

  const refresh = async (cwd?: string): Promise<void> => {
    const directory = resolveCwd(cwd)
    const key = bucketKey(directory)
    let [
      episodic,
      semantic,
      globalEpisodic,
      globalSemantic,
      projectTech,
      globalTech,
      projectFail,
      globalFail,
    ] = await Promise.all([
      store.readEpisodic('project', directory),
      store.readSemantic('project', directory),
      store.readEpisodic('global', undefined, settings.partition),
      store.readSemantic('global', undefined, settings.partition),
      store.readTechniques('project', directory, settings.partition),
      store.readTechniques('global', undefined, settings.partition),
      store.readFailures('project', directory, settings.partition),
      store.readFailures('global', undefined, settings.partition),
    ])
    // 引用针缓存与泛化针表**先于维护**重算：维护里的「历史引用清零」判据要用到泛化针集
    // （有效针集 = 去掉泛化针后剩下的针），而针只看符号面（subject / 调用名），
    // 不受维护要写的 `archivedAt`、`domain` 影响，所以提前算不会读到陈旧口径。
    refreshNeedleIndex(dedupeById([...projectTech, ...globalTech]))
    // 死重维护（0.2.10）：领域归一化 + 归档死重。**每次刷新都检查**，但不为空才写盘 ——
    // 检查是纯内存的 O(n) 比较（几百条），而写盘只会在真出现新死重时发生一次，
    // 归档之后条件不再成立，所以不存在写风暴。写盘后**必须重读**，否则索引与语料仍基于
    // 维护前的状态，归档卡会在本次刷新后继续留在注入候选里（直到下一次刷新才消失）。
    const maintained = await maintainTechniques(directory, dedupeById([...projectTech, ...globalTech]))
    if (maintained) {
      ;[projectTech, globalTech] = await Promise.all([
        store.readTechniques('project', directory, settings.partition),
        store.readTechniques('global', undefined, settings.partition),
      ])
    }
    // ④ 的存量修复（0.2.14）：把「已标记解决、但计数证明之后又发生过」的失败记录重新打开。
    // 与技巧维护同处一层：必须在重建 `failureById` **之前**跑，并重读。
    const failuresMaintained = await maintainFailures(dedupeById([...projectFail, ...globalFail]), directory)
    if (failuresMaintained) {
      ;[projectFail, globalFail] = await Promise.all([
        store.readFailures('project', directory, settings.partition),
        store.readFailures('global', undefined, settings.partition),
      ])
    }
    // DEF-28：这两张表必须**先清空再重建**。只 `set` 不 `clear` 时，被删除的记录会永远留在
    // 内存索引里 —— `failure_list` / `failure_resolve` / `failure_forgive` / `technique_get`
    // 读的都是这张表，于是「删掉了但还看得见、还能展开」。（`clear` 与下面的重建循环之间
    // 没有 `await`，因此不存在读到半空表的窗口。）
    failureById.clear()
    failureByKey.clear()
    for (const record of dedupeById([...projectFail, ...globalFail])) {
      failureById.set(record.id, record)
      failureByKey.set(record.fingerprint.key, record)
    }
    const techniques = dedupeById([...projectTech, ...globalTech])
    techniqueById.clear()
    for (const record of techniques) techniqueById.set(record.id, record)
    // 技巧的作用域同样按**读取的桶**定：同 id 出现在两个桶时以项目桶为准，
    // 与上面 `dedupeById([...projectTech, ...globalTech])` 的先后顺序一致。
    const techniqueScopes = new Map<string, MemoryScope>()
    for (const record of globalTech) techniqueScopes.set(record.id, 'global')
    for (const record of projectTech) techniqueScopes.set(record.id, 'project')
    // 索引从真源派生：签名没变就跳过，变了就全量重建（几百条是毫秒级）。
    // 重建失败只记一条日志，检索随后自动走内存路径。
    try {
      if (techniqueIndex?.build(techniques) === true) {
        logger.debug(`memory: rebuilt sqlite index for ${techniques.length} techniques`)
      }
    } catch (error) {
      logger.warn(`memory: sqlite index rebuild failed, using in-memory retrieval: ${describe(error)}`)
    }
    // 作用域按**读取的桶**打标（项目桶 / 全局桶是两个目录），而不是记录里冗余的
    // `scope` 字段 —— `memory_search(scope)` 的过滤要靠它才真起作用。
    corpora.set(key, [
      ...toDocs(episodic, semantic, 'project'),
      ...toDocs(globalEpisodic, globalSemantic, 'global'),
      ...toTechniqueDocs(techniques.filter(record => techniqueScopes.get(record.id) === 'project'), 'project'),
      ...toTechniqueDocs(techniques.filter(record => techniqueScopes.get(record.id) === 'global'), 'global'),
    ])
    // 整份文件解不开（密钥不匹配/密文损坏）时，读取会静默返回空库，而写入又已被拒绝。
    // 两条都没声音的话，用户只会看到「记忆突然没了」，所以这里主动吼一声（每进程一次）。
    if (store.integrityBroken && !integrityWarned) {
      integrityWarned = true
      logger.error(
        `memory: store at ${settings.dir} is unreadable (${store.brokenFile ?? 'unknown file'}) — wrong or missing key? `
        + 'Writes are refused until the key is restored; writing now would overwrite the unreadable records for good.',
      )
    } else if (store.undecodableLines > 0 && !undecodableWarned) {
      undecodableWarned = true
      logger.warn(
        `memory: skipped ${store.undecodableLines} undecodable line(s) under ${settings.dir} — individual corrupt lines `
        + 'are tolerated, but a whole-file failure blocks writes.',
      )
    }
    // 语料换了，跨块去重的判定必须跟着作废（否则删掉技巧后召回段仍按旧结果排除它）。
    techniqueHitCache = undefined
  }

  /**
   * 取某个会话目录的召回桶内容。
   * @param cwd - 会话工作目录。
   * @returns 已加载的文档；桶未加载时为空数组。
   */
  const corpusFor = (cwd?: string): RecallDoc[] => corpora.get(bucketKey(resolveCwd(cwd))) ?? []

  track(store.readMetrics().then(loaded => {
    metrics = loaded
    metricsBaseline = { ...loaded }
  }))
  track(refresh())

  /** 取出（或新建）一个会话的瞬时层状态，并把它记为「当前会话」。 */
  const ensureLive = (session: Session): LiveSession => {
    const id = String(session.id)
    let state = live.get(id)
    if (state === undefined) {
      const cwd = cwdOf(session)
      const created: LiveSession = {
        sessionId: id,
        ...(cwd === undefined ? {} : { cwd }),
        startedAt: Date.now(),
        turns: [],
      }
      live.set(id, created)
      if (cwd !== undefined) lastCwd = cwd
      logger.debug(`memory: session ${id} entered`)
      // 新会话可能属于另一个项目：立即为其目录建立独立桶，避免沿用上一个项目的索引。
      track(refresh(cwd))
      // 技术栈画像决定技巧适用性；探测失败只是不做过滤，不阻断任何能力。
      if (cwd !== undefined) {
        track(detectStack(createFileView(cwd)).then(profile => {
          if (profile !== undefined) created.stack = profile
        }))
      }
      state = created
    }
    current = state
    return state
  }

  /** 取出（或补建）某一轮的要点容器，并限制单会话轮次数量。 */
  const turnOf = (state: LiveSession, turn: number): LiveTurn => {
    const last = state.turns.at(-1)
    if (last !== undefined && last.turn === turn) return last
    const created: LiveTurn = { turn, user: '', assistant: '', tools: [], files: [] }
    state.turns.push(created)
    if (state.turns.length > settings.maxTurnsPerSession) state.turns.shift()
    return created
  }

  /** 构造一次模型提炼调用；llm 不可用时抛错，由 `distill` 回退到规则路径。 */
  const modelCaller = (route: ModelRoute): LlmTextCaller => {
    return async (system, user) => {
      const llm = ctx.get('llm') as LlmStreamLike | undefined
      if (llm === undefined) throw new Error('llm service is not available')
      const options: GenerateOptions = {
        provider: route.provider,
        model: route.model,
        system,
        messages: [createUserMessage({
          content: [{ type: 'text', text: user }],
          source: PLUGIN_MESSAGE_SOURCE as UserMessage['source'],
        })],
      }
      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream(options)) assembler.push(chunk)
      if (assembler.finish.kind !== 'stop') {
        throw new Error(`distill call finished with "${assembler.finish.kind}"`)
      }
      return assembler.blocks()
        .filter(block => block.type === 'text')
        .map(block => (block as { text: string }).text)
        .join('\n')
    }
  }

  /** 解析提炼路由：配置优先，其次复用会话最近一次请求的路由。 */
  const routeFor = (state: LiveSession): ModelRoute | undefined => {
    if (settings.provider !== undefined && settings.model !== undefined) {
      return { provider: settings.provider, model: settings.model }
    }
    return state.route
  }

  /** 升级阈值：由配置收敛而来，观测与预警共用同一份。 */
  const escalation: EscalationThresholds = {
    warn: settings.failureWarnAfter,
    ask: settings.failureAskAfter,
    block: settings.failureBlockAfter,
  }

  /**
   * 失败层的写入串行化队列。
   *
   * 失败写入是「读-改-写」：并发的两次写入各自读到同一份旧快照，
   * 后写者会把前者的更新整段回滚（例如把刚补上的 remedy 抹掉）。
   * 因此所有失败层写入必须走同一条链，保证 FIFO。
   */
  let failureWrites: Promise<void> = Promise.resolve()
  /**
   * 串行执行一次失败层写入，并把结果回传给调用方。
   * @param task - 实际写入操作。
   * @returns 写入结果；失败时 reject（调用方决定如何处理）。
   */
  const runFailureWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const result = failureWrites.then(task)
    const guarded = result.then(() => undefined).catch(error => {
      logger.warn(`memory: failure write failed: ${describe(error)}`)
    })
    failureWrites = guarded
    track(guarded)
    return result
  }

  /** 取出（或新建）一个会话的失败观测状态。 */
  const failureState = (sessionId: string): {
    callNames: Map<string, string>
    callArgs: Map<string, string>
    lastMachineKey?: string
    lastMachineTurn?: number
    lastSeenTurn: Map<string, number>
    warned: Map<string, { turn: number; recordId: string }>
    advisoriesSent: Map<string, number>
    repeatAt: Map<string, number>
    observedCount: Map<string, number>
    forgiven: Set<string>
    /** 本地初筛命中的纠偏**候选**原文；是否真是纠偏由模型定夺，见 `persist`。 */
    correctionCandidates: string[]
  } => {
    let state = failuresBySession.get(sessionId)
    if (state === undefined) {
      state = {
        callNames: new Map(),
        callArgs: new Map(),
        lastSeenTurn: new Map(),
        warned: new Map(),
        advisoriesSent: new Map(),
        repeatAt: new Map(),
        observedCount: new Map(),
        forgiven: new Set(),
        correctionCandidates: [],
      }
      failuresBySession.set(sessionId, state)
    }
    return state
  }

  /** 当前会话正在进行的轮次。 */
  const currentTurnOf = (state: LiveSession): number => state.turns.at(-1)?.turn ?? 0

  /**
   * 记录一次失败观测：同指纹合并计数，并同步内存索引。
   *
   * 两条关键处理：
   * 1. **记录前先撤销本会话的预警记账** —— 预警之后又复现，说明预警没生效，
   *    不能让这次复现被误算成「防住了」；
   * 2. 落盘是后台任务，但 `lastSeenTurn` **同步**更新，保证与 `turn/end` 的
   *    预防结算不会因为异步写入而错序。
   *
   * @param state - 会话状态。
   * @param observation - 失败观测。
   * @param remedy - 已知的正确做法（模型认定的纠偏或人工补充时提供）。
   * @param guard - 可执行的守卫条件。
   * @param trigger - 触发方式；缺省时由指纹推导一个粗粒度描述。
   * @returns 写入完成的 promise（异常已被吞掉）；同流程里若有 `refresh()`，应先 await 它。
   */
  const recordFailure = (
    state: LiveSession,
    observation: FailureObservation,
    remedy?: string,
    guard?: FailureRecord['guard'],
    trigger?: string,
  ): Promise<void> => {
    const session = failureState(state.sessionId)
    session.warned.delete(observation.fingerprint.key)
    session.lastSeenTurn.set(observation.fingerprint.key, currentTurnOf(state))
    session.observedCount.set(
      observation.fingerprint.key,
      (session.observedCount.get(observation.fingerprint.key) ?? 0) + 1,
    )

    const scope = settings.scopeFailure
    const cwd = scope === 'project' ? state.cwd : undefined
    // 失败层同样要过统一安全管线。它的 symptom / remedy / trigger 都会被注入后续会话，
    // 而 scopeFailure 默认为 global —— 只脱敏不去标识化的话，错误首行里的项目路径与
    // 私有标识会跨项目留存。指纹的 key 由**原文**算出，先算后洗，因此键保持稳定。
    const fingerprint = observation.fingerprint.template === undefined
      ? observation.fingerprint
      : { ...observation.fingerprint, template: sanitizeForStore(observation.fingerprint.template, state) }
    const symptom = sanitizeForStore(observation.symptom, state)
    const cleanRemedy = remedy === undefined ? undefined : sanitizeForStore(remedy, state)
    // 每条记录都带上触发方式：它是「已解决之后还能在相似场景被提前端出来」的唯一依据。
    const derived = trigger ?? deriveTrigger({
      ...(observation.fingerprint.tool === undefined ? {} : { tool: observation.fingerprint.tool }),
      ...(observation.fingerprint.errorName === undefined ? {} : { errorName: observation.fingerprint.errorName }),
      ...(observation.fingerprint.template === undefined ? {} : { template: observation.fingerprint.template }),
    })
    const cleanTrigger = derived === undefined ? undefined : sanitizeForStore(derived, state)
    // 返回可等待的 promise：注入侧的 `refresh()` 会从磁盘**整体覆盖**内存索引，若同一流程里
    // 先发起写入、再 refresh，就会把刚写好的字段（如 remedy）用旧快照冲掉（DEF-09）。
    // 调用方要么 await，要么让 `runFailureWrite` 的 track 兜住；这里统一吞掉异常，
    // 使「不 await」也不会产生 unhandled rejection。
    return runFailureWrite(async () => {
      const { records } = await store.upsertFailures(
        [{
          fingerprint,
          symptom,
          ...(state.stack === undefined ? {} : { stack: state.stack }),
          ...(cleanRemedy === undefined ? {} : { remedy: cleanRemedy }),
          ...(cleanTrigger === undefined ? {} : { trigger: cleanTrigger }),
          ...(guard === undefined ? {} : { guard }),
        }],
        {
          scope,
          ...(cwd === undefined ? {} : { cwd }),
          partition: settings.partition,
          sessionId: state.sessionId,
          // 回合内次数（`episodeOccurrences`）：未复发过时等于累计值，复发后从重开点重新起算 ——
          // 一条 77 次的老记录复发不会直接跳到 ask / block。
          enforcement: record => enforcementFor(episodeOccurrences(record), escalation),
        },
      )
      for (const record of records) {
        failureById.set(record.id, record)
        failureByKey.set(record.fingerprint.key, record)
      }
    }).catch(() => undefined)
  }

  /**
   * 把一句「正确做法」挂到本会话最近一次机械失败上。
   *
   * 自动观测只能发现「又犯了同一个错」，说不出正确做法；而正确做法几乎总是紧跟在
   * 失败之后由用户给出。把两者接起来，拦截理由才不是一句空话。
   *
   * @param state - 会话状态。
   * @param remedy - 用户给出的正确做法。
   * @returns 写入完成的 promise（异常已被吞掉）。
   */
  const attachRemedyToLastFailure = (state: LiveSession, remedy: string): Promise<void> => {
    const key = failuresBySession.get(state.sessionId)?.lastMachineKey
    if (key === undefined) return Promise.resolve()
    // 读-改-写必须整体在队列里完成：若在队列外先改内存索引，
    // 先前排队的那次 upsert 完成时会把它的旧快照写回索引，remedy 就被抹掉了。
    return runFailureWrite(async () => {
      const record = failureByKey.get(key)
      if (record === undefined || record.remedy.length > 0) return
      // 与 `recordFailure` 同一口径：remedy 会进全局域并被注入，必须先过去标识化。
      const updated: FailureRecord = { ...record, remedy: sanitizeForStore(remedy, state), updatedAt: Date.now() }
      failureById.set(updated.id, updated)
      failureByKey.set(key, updated)
      await store.updateFailure(updated, updated.scope === 'project' ? state.cwd : undefined)
    }).catch(() => undefined)
  }

  /**
   * 结算「防住了」：预警已发出、观察窗口内该指纹未再复现，则计入 `prevented`。
   *
   * 没有这一步，「防止继续犯错」就只能靠感觉 —— 有效性必须有可观测的闭环。
   *
   * @param state - 会话状态。
   * @param turn - 刚结束的轮次。
   */
  const settlePrevention = (state: LiveSession, turn: number): void => {
    const session = failuresBySession.get(state.sessionId)
    if (session === undefined) return
    for (const [key, hint] of [...session.warned]) {
      if ((session.lastSeenTurn.get(key) ?? -1) >= hint.turn) continue
      if (turn - hint.turn < settings.failurePreventWindowTurns) continue
      session.warned.delete(key)
      // 同样把读-改-写整体放进队列，避免被在途写入回滚。
      void runFailureWrite(async () => {
        const record = failureByKey.get(key)
        if (record === undefined) return
        const updated: FailureRecord = {
          ...record,
          prevented: record.prevented + 1,
          updatedAt: Date.now(),
        }
        failureById.set(updated.id, updated)
        failureByKey.set(key, updated)
        await store.updateFailure(updated, updated.scope === 'project' ? state.cwd : undefined)
      })
    }
  }

  /**
   * 对一条技巧草稿做去标识化与限额收敛。
   *
   * 凭据脱敏已在 `distill`/`redact` 内完成；这里补**占位符化**：
   * 用会话自己触及的文件名推导项目私有标识，把它们换成种类化占位符，
   * 让知识可以安全地进入全局域。库/SDK 符号不受影响（不在项目文件里）。
   *
   * @param draft - 待处理草稿。
   * @param state - 来源会话状态。
   * @returns 可落盘的草稿。
   */
  const abstractDraft = (draft: TechniqueDraft, state: LiveSession | undefined): TechniqueDraft =>
    abstractTechniqueDraft(draft, {
      identifiers: identifiersFromPaths((state?.turns ?? []).flatMap(turn => turn.files)),
      exampleMaxLines: settings.exampleMaxLines,
      exampleMaxChars: settings.exampleMaxChars,
      // 证据由提炼管线补上会话来源，不采信模型自述。
      evidence: state === undefined ? [] : [{ kind: 'session', sessionId: state.sessionId }],
    })

  /**
   * 把**工作区外**的绝对路径替换为 `[EXTERNAL-PATH]`（工作区内路径保留原样）。
   *
   * @param value - 任意文本。
   * @param cwd - 当前会话工作目录；缺省时不认为任何路径在工作区内。
   * @returns 处理后的文本。
   */
  const scrubExternalPath = (value: string, cwd: string | undefined): string =>
    value.replace(/\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/gu, match =>
      keepInsideWorkspace([match], cwd).length > 0 ? match : '[EXTERNAL-PATH]')

  /**
   * 落盘前的**统一安全管线**：凭据脱敏 → 项目私有标识占位 → 工作区外绝对路径占位。
   *
   * 四层共用这一条管线（技巧层走 {@link abstractDraft}，内部是同一套 `abstractText`）。
   * 之所以必须逐层都过：`global` 作用域的层会跨项目复用，任何一层漏掉去标识化，
   * 就等于给项目私有标识开了一条绕开策略的通道。
   *
   * 只用于**自由文本**。`tags` 这类检索元数据不套占位符 —— 元数据一旦被 `<Class1>`
   * 之类占位符替换就再也检索不到（历史上把 `domain`/`tags` 打成 `<id1>` 就是这么来的），
   * 它们只做凭据脱敏。
   *
   * @param value - 待落盘文本。
   * @param state - 来源会话状态（用于推导项目私有标识）。
   * @param cwd - 会话工作目录；缺省取 `state.cwd`。
   * @returns 可落盘文本。
   */
  const sanitizeForStore = (value: string, state: LiveSession | undefined, cwd?: string): string => {
    if (value.length === 0) return value
    const identifiers = identifiersFromPaths((state?.turns ?? []).flatMap(turn => turn.files))
    return scrubExternalPath(abstractText(value, { identifiers }).text, cwd ?? state?.cwd)
  }

  /**
   * 判断一条草稿是否允许写入目标作用域。
   *
   * `confidential` 默认只能留在项目域：它是业务机密，全局扩散的代价不可逆。
   *
   * @param draft - 技巧草稿。
   * @param scope - 目标作用域。
   * @returns 允许写入时为 `true`。
   */
  const storable = (draft: TechniqueDraft, scope: MemoryScope): boolean =>
    scope === 'project' || settings.allowConfidentialGlobal || (draft.sensitivity ?? 'internal') !== 'confidential'

  /**
   * 把「纠偏认定结果」落成失败层记录，并把正确做法挂到最近一次机械失败上。
   *
   * 两个来源，对应两段式筛选的第二段：
   *
   * - `model`：模型在反思里给出的 `corrections`（触发方式 / 错在哪 / 正确做法齐全）。
   *   模型说「不是纠偏」时不落任何记录 —— 这正是本地初筛那点误报被拦下的地方。
   * - `local`：没有模型路由时的**降级**路径，直接用本地初筛候选，但要求本会话内刚发生过
   *   一次机械失败才认。没有失败现场的「again」几乎都是误报，而「用户紧跟一次失败给出
   *   正确做法」恰好就是有失败现场的那种情形 —— 降级只保留真正有价值的那一半。
   *
   * @param state - 会话状态。
   * @param corrections - 模型认定的纠偏（`local` 模式下忽略）。
   * @param mode - 认定来源。
   */
  const applyCorrections = async (
    state: LiveSession,
    corrections: readonly CorrectionDraft[],
    mode: 'model' | 'local',
  ): Promise<void> => {
    const session = failureState(state.sessionId)
    const candidates = session.correctionCandidates
    // 这批候选已经有结论了，无论结论是「是」还是「不是」都不再保留，避免下轮重复处理。
    session.correctionCandidates = []

    const drafts: { fingerprint: FailureFingerprint; symptom: string; remedy: string; trigger?: string }[] = []
    if (mode === 'model') {
      for (const correction of corrections) {
        // 指纹取模型**归一化后**的表述，而不是用户原句：同一件事换个说法还能合并成一条。
        const fingerprint = semanticFingerprint(`${correction.trigger} ${correction.wrong}`)
        if (fingerprint === undefined) continue
        drafts.push({
          fingerprint,
          symptom: `用户纠偏：${correction.wrong}`,
          remedy: correction.correctApproach,
          trigger: correction.trigger,
        })
      }
    } else {
      // DEF-04：只认「紧跟一次失败」的纠偏。失败必须发生在最近 CORRECTION_WINDOW_TURNS
      // 轮之内，否则跨话题的「不要再…」会把 remedy 挂到无关的旧失败上。
      const key = session.lastMachineKey
      const failedTurn = session.lastMachineTurn
      const windowOk = key !== undefined
        && failedTurn !== undefined
        && currentTurnOf(state) - failedTurn <= CORRECTION_WINDOW_TURNS
      if (!windowOk || key === undefined) return
      // DEF-01：机械失败的写入是异步的，必须在**写队列内**读它的触发方式；
      // 在队列外读到的可能是尚未落地的旧索引，`failureTrigger` 会退化成纠偏原话本身。
      const trigger = await runFailureWrite(async () => {
        const context = failureByKey.get(key)
        return context === undefined ? undefined : failureTrigger(context)
      }).catch(() => undefined)
      for (const candidate of candidates) {
        const fingerprint = semanticFingerprint(candidate)
        if (fingerprint === undefined) continue
        drafts.push({
          fingerprint,
          symptom: `用户纠偏：${candidate}`,
          remedy: candidate,
          ...(trigger === undefined ? {} : { trigger }),
        })
      }
    }
    if (drafts.length === 0) return
    const first = drafts[0] as (typeof drafts)[number]
    // 必须等这些写入落地再返回：`persist` 收尾会 `refresh()`，而 refresh 是从磁盘
    // 整体覆盖内存索引 —— 不等就会把刚写的 remedy 用旧快照冲掉（DEF-09）。
    await Promise.all(drafts.map(draft => recordFailure(
      state,
      { fingerprint: draft.fingerprint, symptom: draft.symptom },
      draft.remedy,
      undefined,
      draft.trigger,
    )))
    // 用户纠偏通常紧跟在一次失败之后：那句「应该怎么做」正是这条失败缺的 remedy。
    await attachRemedyToLastFailure(state, first.remedy)
  }

  /**
   * 提炼并落盘：情景层每次会话一条，语义层与技巧层仅在模型提炼成功时合并。
   *
   * @param state - 会话状态。
   * @param transcript - 会话要点快照。
   * @param route - 模型路由；`undefined` 表示只走本地规则路径（不产出技巧）。
   * @param correctionsMode - 纠偏认定方式：`model` 用模型产出，`local` 用本地候选严格降级，`skip` 不处理。
   * @returns 实际生效的提炼来源与技巧新建/合并计数。
   */
  const persist = async (
    state: LiveSession,
    transcript: Transcript,
    route: ModelRoute | undefined,
    correctionsMode: 'model' | 'local' | 'skip' = 'skip',
  ): Promise<{ source: ExtractionSource; created: number; merged: number }> => {
    const result = await distill(transcript, {
      ...(route === undefined ? {} : { call: modelCaller(route) }),
      timeoutMs: settings.distillTimeoutMs,
    })
    // 情景层与语义层的自由文本都要过统一安全管线：凭据脱敏 + 项目私有标识占位 +
    // 工作区外绝对路径占位。文件列表另由 keepInsideWorkspace 归一为相对路径，
    // tags 是检索元数据，只做凭据脱敏（占位符会毁掉检索）。
    const raw = result.memory
    const clean = (value: string): string => sanitizeForStore(value, state, state.cwd)
    const memory = {
      ...raw,
      title: clean(raw.title),
      summary: clean(raw.summary),
      decisions: raw.decisions.map(clean),
      todos: raw.todos.map(clean),
      files: keepInsideWorkspace(raw.files, state.cwd),
      tags: redactAll(raw.tags),
      facts: raw.facts.map(fact => ({ kind: fact.kind, text: clean(fact.text) })),
      techniques: raw.techniques.map(draft => abstractDraft(draft, state)),
      corrections: raw.corrections.map(correction => ({
        trigger: clean(correction.trigger),
        wrong: clean(correction.wrong),
        correctApproach: clean(correction.correctApproach),
      })),
    }
    if (correctionsMode !== 'skip') {
      // DEF-03：模型路由存在但调用失败时，`distill` 会静默回退规则路径（`corrections` 恒空）。
      // 把这种情况当成「模型没给出结论」而不是「模型说不是纠偏」—— 走本地降级，否则
      // 超时/非法 JSON 这类正是规则兜底要救的场景会把纠偏永久丢掉。
      const effective = correctionsMode === 'model' && result.source !== 'model' ? 'local' : correctionsMode
      await applyCorrections(state, memory.corrections, effective)
    }

    // 情景层：默认留在项目域（原始摘要含路径与原话）。
    const episodicScope = settings.scopeEpisodic
    const episodicCwd = episodicScope === 'project' ? state.cwd : undefined
    const record: EpisodicRecord = {
      id: `ep_${randomUUID()}`,
      ts: Date.now(),
      sessionId: state.sessionId,
      scope: episodicScope,
      partition: settings.partition,
      ...(episodicCwd === undefined ? {} : { cwd: episodicCwd }),
      title: memory.title,
      summary: memory.summary.slice(0, MAX_SUMMARY_CHARS),
      decisions: memory.decisions,
      files: memory.files,
      todos: memory.todos,
      tags: memory.tags,
      source: result.source,
    }
    await store.saveEpisodic(record)

    if (result.source === 'model' && memory.facts.length > 0) {
      const semanticScope = settings.scopeSemantic
      const semanticCwd = semanticScope === 'project' ? state.cwd : undefined
      await store.upsertSemantic(memory.facts, {
        scope: semanticScope,
        partition: settings.partition,
        ...(semanticCwd === undefined ? {} : { cwd: semanticCwd }),
        sessionId: state.sessionId,
        tags: memory.tags,
      })
    }

    let created = 0
    let merged = 0
    // C：落盘前的**免费**过滤（不花模型钱）。模型很容易把「本会话刚检索到的库内条目」或
    // 「同一领域既有结论」换个措辞再交一遍 —— 那不是学习，是自我循环，会让库以近重复条目
    // 膨胀、把注入预算耗在互相复述上。阈值不是拍脑袋：真库实测「最近 2 小时模型显式保存的
    // 13 条真新知识」对全库的最大包含度是 **0.412**，而库内近重复的 top10 在 0.53–0.63，
    // 因此库内复述取 0.6（留 0.19 余量）、「本会话刚读过」取 0.5（更该拦）。
    const candidates = settings.techniques
      ? memory.techniques.filter(draft => storable(draft, settings.scopeTechnique))
      : []
    const libraryTexts = [...techniqueById.values()].map(record => techniqueText(record))
    const sessionTexts = [...(retrievedBySession.get(state.sessionId) ?? [])]
      .map(id => techniqueById.get(id))
      .filter((record): record is TechniqueRecord => record !== undefined)
      .map(record => techniqueText(record))
    const drafts: TechniqueDraft[] = []
    for (const draft of candidates) {
      const text = draftText(draft)
      if (maxContainment(text, sessionTexts, tokenize) >= SESSION_RESTATEMENT_RATIO) {
        restatementDrops.push(`${draft.name}（本会话已读过）`)
        continue
      }
      if (maxContainment(text, libraryTexts, tokenize) >= LIBRARY_RESTATEMENT_RATIO) {
        restatementDrops.push(draft.name)
        continue
      }
      drafts.push(draft)
    }
    if (drafts.length > 0) {
      const techniqueScope = settings.scopeTechnique
      const techniqueCwd = techniqueScope === 'project' ? state.cwd : undefined
      const stored = await store.upsertTechniques(drafts, {
        scope: techniqueScope,
        ...(techniqueCwd === undefined ? {} : { cwd: techniqueCwd }),
        partition: settings.partition,
        sessionId: state.sessionId,
        provenance: result.source === 'model' ? 'model' : 'rule',
      })
      created = stored.created
      merged = stored.merged
    }

    await refresh(state.cwd)
    if (result.fallbackReason !== undefined) {
      logger.warn(`memory: ${state.sessionId} distilled by rules (${result.fallbackReason})`)
    }
    return { source: result.source, created, merged }
  }

  /**
   * 自上次反思以来新增的轮次。摊销口径的唯一来源。
   * @param state - 会话状态。
   * @returns 尚未反思过的轮次。
   */
  const turnsSinceReflection = (state: LiveSession): LiveTurn[] =>
    state.turns.slice(state.reflectedTurns ?? 0)

  /**
   * 窗口里有没有**新领域**：出现了「库里没有任何技巧覆盖的文件」。
   *
   * 这是退避的解药，也是「值得学习」的正判据：真实工作里最值得沉淀的时刻，是碰到
   * 库还不认识的东西（新模块、没见过的 API、陌生工具链）。实测（GT6 移植）：库覆盖了该
   * 领域之后，词面新颖度闸门把反思长期关在门外 —— `reflections` 卡在 17、`model` 产出停在
   * 11:04，而同期模型自己 `technique_save` 了 13 条。退避因此必须是**频率限制**而不是开关。
   *
   * 判据用「文件主键有没有被任何技巧的正文/符号命中」而不是词面重叠：前者与库的覆盖度直接
   * 相关，后者会被「同一领域里的常见词」压低到阈值以下。
   *
   * @param fresh - 自上次反思以来新增的轮次。
   * @returns 是否存在未被任何技巧覆盖的文件。
   */
  const hasNewGround = (fresh: readonly LiveTurn[]): boolean => {
    const files = [...new Set(fresh.flatMap(turn => turn.files))]
    if (files.length === 0) return false
    const docs = [...techniqueById.values()].map(record => toTechniqueDocs([record])[0]).filter(doc => doc !== undefined)
    return files.some(file => {
      // 「新领域」不等于「库还没覆盖」：**已经为它花过一次反思却一无所获**的地面不算新 ——
      // 否则遇到「库永远学不会的领域」时，每次窗口都算新领域，退避形同虚设、成本失控
      // （既有用例「纯重复会话不新建记录且模型调用为 0」正是这个反例）。
      if (spentGround.has(file)) return false
      const base = file.split(/[\\/]/u).at(-1) ?? file
      // 用**主键**（去掉扩展名）取词元：扩展名不是知识证据，否则 `newmodule.ts` 会被库里
      // 任意含 `ts` 的技巧判成「已覆盖」（`ADVISORY_NOISE` 也已收录扩展名，此处是双保险）。
      const terms = [...new Set(tokenize(base.replace(/\.[A-Za-z0-9]{1,8}$/u, '')))]
      if (terms.length === 0) return false
      return advisoryMatches(docs, terms, { limit: 1 }).length === 0
    })
  }

  /** 已经花过一次反思却无所获的文件（进程内）：用于把「新领域」限成「**尚未**花过钱的地面」。
   * 进程内即可 —— 重启后重试一次是合理代价，而它换来的是「不会在同一片地面反复付费」。 */
  const spentGround = new Set<string>()

  /**
   * 决定这次是否**花钱**调用模型做反思。
   *
   * 这是「前期投入、后期节省」得以成立的关键闸门：没有新信息就不调用。
   * 三道闸门依次是：新增轮次够不够 `reflectMinTurns`、有没有学习信号、
   * 词面新颖度是否达到 `reflectNoveltyThreshold`。
   *
   * **用户纠偏是唯一的例外**：它绕过退避，也不再受新颖度闸门约束。两个原因：
   *
   * 1. 退避不能是死锁 —— `metrics.backoff` 只在「某次反思真的有新产出」时才清零，
   *    若退避期间一律不反思，就永远等不到清零的那次反思（这曾是真实缺陷）。
   * 2. 纠偏本身稀有，且是「用户明确说不是这样」的直接证据，卡在词面新颖度上
   *    会把最有价值的信号挡在门外。
   *
   * @param state - 会话状态。
   * @param transcript - 会话要点快照。
   * @returns 是否反思与原因。
   */
  const reflectDecision = (state: LiveSession, transcript: Transcript): { reflect: boolean; reason: string } => {
    if (!settings.reflectOnSessionEnd) return { reflect: false, reason: 'reflection disabled' }
    // 摊销口径：只看上次反思之后**新增**的轮次。首轮与旧口径等价（总轮次），此后
    // 每积累 reflectMinTurns 个新轮次就有一次机会 —— 长驻会话不必等到进程关闭才沉淀。
    const fresh = turnsSinceReflection(state)
    if (fresh.length < settings.reflectMinTurns) {
      return { reflect: false, reason: `only ${fresh.length} new turn(s)` }
    }
    if (!hasLearningSignal(fresh)) return { reflect: false, reason: 'no learning signal' }
    if (hasCorrectionSignal(fresh)) {
      return { reflect: true, reason: `${fresh.length} new turn(s), user correction` }
    }
    // 退避是**频率限制**而不是永久开关：只在「连续空产出 **且这一窗口没有新领域**」时跳过。
    // 旧实现一旦退避就再也不会反思（清零要求「有一次反思产出新东西」），于是自动学习被
    // 永久关闭 —— 实测 reflections 卡在 17、model 产出停在 11:04，而同期模型自己存了 13 条。
    const newGround = hasNewGround(fresh)
    if (metrics.backoff && !newGround) {
      return { reflect: false, reason: 'backoff (no new ground in this window)' }
    }
    // 比较必须「同口径」：既有技巧是**去标识化后**存储的，转录也要先过同一道占位符化，
    // 否则项目私有标识符每次都算「新词」，闸门永远关不上。
    const identifiers = identifiersFromPaths(fresh.flatMap(turn => turn.files))
    const query = abstractText(transcriptText({ ...transcript, turns: fresh }), { identifiers }).text
    const novelty = noveltyRatio(
      query,
      [...techniqueById.values()].map(record => techniqueText(record)),
    )
    // 有新领域时不看词面新颖度：库覆盖了该领域之后，这个数必然被压低（正是它把学习关掉的）。
    if (newGround) return { reflect: true, reason: `${fresh.length} new turn(s), new ground` }
    if (novelty < settings.reflectNoveltyThreshold) return { reflect: false, reason: `novelty ${novelty.toFixed(2)}` }
    return { reflect: true, reason: `${fresh.length} new turn(s), novelty ${novelty.toFixed(2)}` }
  }

  /**
   * 反思闸门最近一次判定（进程内）：回答「这一轮为什么没学」。
   *
   * 三条闸门（新增轮次 / 学习信号 / 退避与新领域 / 词面新颖度）任一拦下都会让模型调用为 0，
   * 而 `memory_stats` 原有的 `reflections=17` 只能说明「没学」，说不清是「没东西可学」还是
   * 「判据写坏了」。与 `gateTally` 同理：拦下的东西不留痕迹，就必须显式报出来。
   */
  const reflectTally: { decisions: number; last: string } = { decisions: 0, last: 'no decision yet' }

  /**
   * 按闸门决定是否反思，并把结果计入「经验复利」指标。
   *
   * 两个调用点共用同一条路径：**每轮末的摊销触发**（`turn/end`，长驻会话的主力）
   * 与**会话末收尾**（`session/disposed`，兜最后一段）。两者口径一致 —— 是否反思
   * 只看「自上次反思以来新增了多少轮」，因此进程不关闭也不会让沉淀无限期推迟。
   *
   * @param state - 会话状态。
   */
  const settleSession = async (state: LiveSession, options: { ruleFallback?: boolean } = {}): Promise<void> => {
    const transcript = snapshotTranscript(state)
    const decision = reflectDecision(state, transcript)
    const route = decision.reflect ? routeFor(state) : undefined
    // 判定的**理由**必须能被外面看见：`memory_stats` 只报 reflections/skipped/backoff 时，
    // 「为什么这次没学」无从回答（是真没新东西？还是闸门卡住了？），而这正是自动学习
    // 上线后最常被问的问题。这里记进程内最近一次判定，不落盘。
    reflectTally.decisions += 1
    reflectTally.last = !decision.reflect
      ? `skip — ${decision.reason}`
      : route === undefined
        ? `reflect (${decision.reason}) but no model route available`
        : `reflect — ${decision.reason}`
    if (route === undefined) {
      // 没有可用模型路由：只走规则路径（仍然落盘情景摘要，但不产出技巧）。
      // 每轮末那个调用点已经写过一次规则摘要，用 `ruleFallback: false` 免去重复落盘。
      // 没有模型可用：纠偏只能走本地严格降级（要求本会话内刚发生过机械失败）。
      if (options.ruleFallback !== false) await persist(state, transcript, undefined, 'local')
      if (decision.reflect) {
        metrics.skipped += 1
        logger.debug(`memory: reflection skipped for ${state.sessionId} (no model route available)`)
      } else {
        logger.debug(`memory: reflection skipped for ${state.sessionId} (${decision.reason})`)
      }
      return
    }
    // 反思是一次有界调用：转录按配置截断后再送审。
    const windowTurns = turnsSinceReflection(state)
    const capped = capTranscript(transcript, settings.reflectMaxTranscriptChars)
    // 只有真正付出模型调用才推进水位。被闸门拦下或没有路由时不推进，
    // 这些轮次留待下次继续参与判定，不会被永久跳过。
    state.reflectedTurns = state.turns.length
    const outcome = await persist(state, capped, route, 'model')
    metrics.reflections += 1
    if (outcome.created > 0) {
      metrics.newTechniques += outcome.created
      metrics.duplicateTechniques += outcome.merged
      metrics.emptyStreak = 0
      metrics.backoff = false
    } else {
      metrics.duplicateTechniques += outcome.merged
      metrics.emptyStreak += 1
      metrics.backoff = metrics.emptyStreak >= settings.reflectBackoffAfterEmpty
    }
    // 这一窗口的文件记成「已花过钱的地面」——**无论产出与否**。两个理由：
    // 1. 库里的正文经去标识化（`src/BlockRegistry.java` → 占位符），文件真名通常不在库里，
    //    所以「库未覆盖」会把已覆盖的文件也判成新领域；靠这次记账兜住成本。
    // 2. 退避期间的语义是「一片地面只试一次」：新文件给一次机会，重复窗口不再付费。
    for (const turn of windowTurns) for (const file of turn.files) spentGround.add(file)
    logger.debug(
      `memory: reflected on ${state.sessionId} (${decision.reason}): +${outcome.created} new, ${outcome.merged} merged`,
    )
    // 计数器当场落盘。只在 `session/disposed` 写的话，长驻会话 —— 正是摊销反思要服务的
    // 那类 —— 重启后会把「前期投入」的账目丢掉，`memory_stats` 的复利指标永远是 0。
    await store.saveMetrics(metrics)
    // 这一笔把遥测也一起写下去了，节流窗口随之刷新（否则会在 60 秒内再写一次同样的内容）。
    metricsDirty = false
    metricsSavedAt = Date.now()
  }

  /**
   * 把召回结果渲染成一段可注入 system prompt 的文本。
   *
   * 三处安全设计：
   * 1. 只读**当前会话目录所属的桶**（跨项目隔离）。
   * 2. 头部声明记忆为不可信数据、不得作为指令（抵御持久化提示注入）。
   * 3. 正文经 {@link sanitizeForInjection} 剥离控制字符、中性化可与结构混淆的标记，
   *    并中和会被模板插值器误认的 `{{`。
   *
   * @param query - 召回查询词（通常是当前会话最近的用户输入）。
   * @returns 注入文本；无可注入内容时为空串。
   */
  /**
   * 注入门槛的进程内计数：回答「门槛到底在不在干活」。
   *
   * 为什么需要它：门槛拦下的东西是**看不见的**（不注入 = 上下文里没有痕迹），出了
   * 「不相关技巧仍被注入」这类问题时只能靠会话记录考古。这里把每次判定的 keep/drop
   * 计数与丢弃原因打一行 debug，并在 `memory_stats` 里报累计值。不落盘：它回答的是
   * 「本次运行」，与跨会话的经验复利是两类指标。
   */
  const gateTally = { kept: 0, dropped: 0, lastKept: 0, lastDropped: 0 }

  /**
   * 上报一次注入渲染的门槛判定结果。
   *
   * @param section - 注入段名（`recall` / `techniques`）。
   * @param query - 本轮判定用的用户原话。
   * @param decisions - 本次渲染的全部候选判定。
   */
  const reportGate = (section: string, query: string, decisions: readonly GateDecision[]): void => {
    if (decisions.length === 0) return
    const kept = decisions.filter(item => item.kept).length
    const dropped = decisions.filter(item => !item.kept)
    gateTally.kept += kept
    gateTally.dropped += dropped.length
    gateTally.lastKept = kept
    gateTally.lastDropped = dropped.length
    // P4：同一份计数也落盘，热重载之后「门槛到底有没有在干活」还能回答。
    metrics.gateKept += kept
    metrics.gateDropped += dropped.length
    metricsDirty = true
    track(flushMetrics())
    const detail = dropped.slice(0, 5)
      .map(item => `${item.id.slice(0, 11)}(matched=${item.matched},strong=${item.strong},generic=${item.generic})`)
      .join(' ')
    logger.debug(
      `memory: gate[${section}] query="${query.slice(0, 50)}" kept=${kept} dropped=${dropped.length}`
      + (detail.length === 0 ? '' : ` dropped≈${detail}`),
    )
  }

  /**
   * 每个会话已经「推过」的技巧 id。
   *
   * 顾问出现在动作点，必须去重：同一条知识只提一次（上限见 {@link ADVISORY_MAX_PER_SESSION}）。
   */
  const advisorySeen = new Map<string, Set<string>>()

  /**
   * ③ 文件级精确命中（0.2.14）：本会话「某张卡的针**已经在这个文件上**逐字命中过」的关联。
   *
   * 为什么需要它：L4 只看**这一次调用**的参数里有没有针 —— 而真实的改动常常落在同一个文件的
   * 第二、第三处（补一个分支、改一行），那时参数里已经没有符号了，同一张卡就从「精确命中」掉回
   * 「证据词」档，容易被别的卡挤掉。记下「针 + 文件」的关联，后续对该文件的改动仍按精确命中算。
   *
   * 会话级状态：这是本会话观测到的事实（`read`/`grep`/`edit` 哪个文件出现过这个符号），
   * 会话结束即作废，不跨会话污染；每个会话最多记 {@link NEEDLE_FILES_PER_SESSION} 个文件。
   */
  const needleFiles = new Map<string, Map<string, Set<string>>>()

  /** 本会话**读过**（search/get/memory_search 命中）的技巧 id：用于拦「复述刚读到的条目」。 */
  const retrievedBySession = new Map<string, Set<string>>()
  /**
   * L1 引用检测的会话状态：**推给过**本会话的技巧（注入 / 召回段 / 顾问），以及其中**已被引用**的。
   *
   * 为什么需要它：`technique_apply`（显式回报）是唯一的"被采用"信号，实测是 0 —— 于是
   * 「模型到底有没有用上推给它的知识」完全不可测，任何改进都无法验收。这里用**插件自己能看到
   * 的证据**补一个信号：卡片的符号/调用名出现在了模型随后的工具调用参数里。
   */
  const surfacedBySession = new Map<string, Set<string>>()
  const referencedBySession = new Map<string, Set<string>>()
  /** 引用针缓存：符号面在运行期不变，按卡算一次。 */
  const needlesById = new Map<string, string[]>()
  /**
   * **泛化针**：在 ≥{@link GENERIC_NEEDLE_CARDS} 张卡上都成立的符号（每次 `refresh` 重算）。
   *
   * 它们不能说明「是这张卡被用上了」，因此既不参与 L1 引用记账，也不参与 L4 的精确命中。
   */
  let genericNeedles: ReadonlySet<string> = new Set()

  /** 落盘前被判为复述而丢弃的候选（进程内计数，供 `memory_stats` 观测过滤是否在干活）。 */
  const restatementDrops: string[] = []

  /** 召回命中里被判为**彼此近重复**而丢弃的 id（进程内计数，同上）。 */
  const recallDedupeDrops: string[] = []

  /**
   * 失败预警的注入门槛计数（进程内，供 `memory_stats` 观测）：
   * `skippedIrrelevant` = 与本会话动作无关而没注入；`skippedBudget` = 每会话总量已用完。
   */
  const failureGateTally = { skippedIrrelevant: 0, skippedBudget: 0 }

  /**
   * 每个会话最后一次投递顾问的**轮号**（每轮最多一条）。
   *
   * 为什么按轮节流：实测（gt6 移植会话）两条顾问在同一轮里各带 2 个 id，把当时的每会话
   * 上限（3）一轮耗尽，之后 10+ 轮完全沉默 —— 而同一份记录显示那些轮里有 10/16、12/17、
   * 8/14、3/12 个动作明明有强证据命中。把预算摊到多轮比在一轮里连推两条有用得多：
   * 模型是跨轮推进任务的。
   */
  const advisoryLastTurn = new Map<string, number>()

  /**
   * 每个会话已投递的**首触顾问条数**（上限 `firstContactAdvisoryMax`）。
   *
   * 与 `advisorySeen` 的区别：那份是「同一条 id 只推一次」的去重，挡不住**每轮推不同的一条** ——
   * 未检索会话正是这样在 149 轮里收下 89 条首触顾问。这里按会话计**总次数**，与推的是哪条无关。
   */
  const firstContactPushed = new Map<string, number>()

  /**
   * 首触顾问的进程内计数（供 `memory_stats` 诊断，评审 F4）。
   *
   * 其它通道都有计数（门槛、去重、失败闸门），唯独首触没有 —— 于是「这个会话为什么没收到首触」
   * 只能靠猜。这里记两件事：投递了几条，以及有多少会话**撞到过每会话上限**。
   */
  const firstContactTally = { pushed: 0, cappedSessions: new Set<string>() }

  /**
   * 每个会话**上次以全文形态注入常驻规则**时的规则集签名与轮号（0.2.10 的 ②a）。
   *
   * 常驻规则每轮都在，是召回段里唯一必然重复的部分：真库里 preference/constraint 正文中位数
   * 57 字符，而它们每轮都按全文重印一遍（实测 5522 次条目出现里只有 425 条不同 = 92% 是重复）。
   * 规则集不变而且距上次全文没超过 `standingRuleFullEveryTurns` 轮时，改发紧凑形态。
   */
  const standingFullShown = new Map<string, { signature: string; turn: number | undefined }>()

  /**
   * ① 每个会话「**已经完整投递过**的召回条目」→ `{ 内容指纹, 上次全文投递的轮号 }`。
   *
   * 为什么要它：实测 674 个不同条目 / 7,618 次出现（平均每条发 11 次），**86.1% 的条目字符是重复** ——
   * 而注入块就躺在对话历史里，逐轮重印是纯付费。已给过且内容未变的条目改发指针形态。
   *
   * 为什么不能「只发一次」：长会话里早期注入会被宿主的 compaction 裁掉，那时「已经给过」不成立。
   * 因此收到任何 `compaction/*` 事件就把本会话的记账整份作废（`standingFullShown` 同理 ——
   * 它的全文也可能已经被裁掉）。只记当轮**真的完整落在块里**的条目（与 ②a 的 F2 判据同源）。
   */
  const repeatSent = new Map<string, Map<string, { hash: string; fullTurn: number | undefined }>>()

  /** 动作点顾问：从工具调用里抽文件路径与调用名，只认强证据命中。 */
  const advisoryFor = (exec: { name: string; arguments: unknown }): string | undefined => {    if (!settings.techniques || !settings.techniqueAdvisory) return undefined
    const sessionId = current?.sessionId
    if (sessionId === undefined) return undefined
    const seen = advisorySeen.get(sessionId) ?? new Set<string>()
    if (seen.size >= settings.techniqueAdvisoryMax) return undefined
    const liveTurn = current?.turns.at(-1)?.turn
    if (liveTurn !== undefined && advisoryLastTurn.get(sessionId) === liveTurn) return undefined
    // `ToolExecution.arguments` 是 `unknown`（不同工具形态不同）：统一收敛成 JSON 文本。
    const raw = typeof exec.arguments === 'string' ? exec.arguments : JSON.stringify(exec.arguments ?? {})
    const terms = advisoryTerms(raw)
    // 动作点是「文件 / 调用名」驱动的：没有这两样就推不出精确匹配。
    if (terms.length === 0) return undefined
    const corpus = gatedCorpus(current?.cwd)
      // 默认连草稿一起看：真实的库里绝大多数知识还是草稿（实测 25 已验证 / 329 草稿），
      // 只看已验证等于在最需要顾问的场景（移植、新框架）里不发声。草稿**只给标题与 id**、
      // 如实标注未验证，正文仍要模型显式 `technique_get` —— 这是「不自动注入未验证知识」
      // 的边界内能给的最大帮助。
      .filter(doc => doc.layer !== 'technique' || settings.techniqueAdvisoryDrafts || doc.meta?.status !== 'draft')
    // L4：改文件的动作点**优先**推"符号逐字出现在这次编辑里"的那条。
    //
    // 为什么是"优先"而不是"只认"：实测 **52% 的注入卡没有可匹配的符号面**（散文型 subject、
    // 没有 api），硬过滤等于在编辑点让一半库彻底失声 —— 而 0.2.8 的输入侧去伪（P0）之后，
    // 动作点的泛化证据词噪声已经从"18 行里 11 行"降到最近窗口的 0 行（2 条动作点顾问全部对题）。
    // 所以这里只做**排序偏好**：有精确命中就用精确的，没有才回退到证据词规则。
    //
    // ③ 文件级（0.2.14）：除了「这次参数里有针」，**本会话已经在这个文件上命中过针**的卡也算精确
    // 命中 —— 同一文件的第二、第三处改动参数里往往已经没有符号了，那时不该掉回证据词档。
    const precise = ADVISORY_PRECISE_TOOLS.has(exec.name)
      ? corpus.filter(doc => doc.layer !== 'technique'
        || needleInArgs(doc.id, raw)
        || filePrecise(doc.id, raw))
      : []
    // ③ 记下关联：本次调用里逐字命中针的卡与这次触及的文件绑定（供后续同文件的调用使用）。
    // 无论这一轮有没有真的推出顾问都要记 —— 「命中过」是事实，与「推过」无关。
    if (precise.length > 0) {
      noteNeedleFiles(
        precise.filter(doc => doc.layer === 'technique' && needleInArgs(doc.id, raw)).map(doc => doc.id),
        raw,
      )
    }
    // ③ 多符号优先（0.2.14）：精确层里**命中 ≥2 个针**的卡先成档 —— 一个针可能是巧合（项目里
    // 同名符号、路径里撞上），两个针同时逐字命中基本就锁定是这张卡。用排序偏好而不是硬过滤：
    // 没有卡到 2 个针时（`strong` 为空）整层照旧按证据词排，精确层不会空转。
    const strong = new Set(precise.filter(doc => needleHitCount(doc.id, raw) >= 2).map(doc => doc.id))
    const preciseHits = precise.length === 0
      ? []
      : advisoryMatches(precise, terms, {
        limit: 1,
        seen,
        ...(strong.size === 0 ? {} : { prefer: strong }),
      })
    // 精确层里**没有可推的卡**（比如那张卡本轮已经推过、或被 `seen` 挡掉）时照旧回退证据词规则：
    // 「有精确命中就用精确的」说的是**排序偏好**，不是「精确层一旦非空就闭嘴」—— 后者会让同一文件
    // 第二次改动时，本来能命中的泛化卡（52% 的卡没有符号面）彻底失声。既有用例正是钉这一条。
    const hits = preciseHits.length > 0 ? preciseHits : advisoryMatches(corpus, terms, { limit: 1, seen })
    if (hits.length === 0) return undefined
    for (const hit of hits) seen.add(hit.id)
    advisorySeen.set(sessionId, seen)
    noteSurfaced(hits.map(hit => hit.id))
    if (liveTurn !== undefined) advisoryLastTurn.set(sessionId, liveTurn)
    logger.debug(`memory: advisory on ${exec.name} → ${hits.map(hit => hit.id.slice(0, 11)).join(', ')}`)
    return advisoryText(hits.map(hit => {
      // 0.2.8：把要点**直接带进上下文**，不再要模型为看一眼而多调一次 `technique_get` ——
      // 实测 18 条顾问都写了「technique_get to read it」，其中 0 条被执行，差别就在这一步的成本。
      const record = techniqueById.get(hit.id)
      const gist = (record === undefined ? '' : gistOf(record)).trim()
      return `· ${hit.label} [${hit.id.slice(0, 11)}]${hit.draft ? ' (draft, unverified)' : ''} matched `
        + `${hit.strong.join(', ')}`
        + (gist.length === 0 ? '' : ` — ${gist.slice(0, 200)}`)
        + ' — technique_get for the full steps.'
    }))
  }

  /**
   * 首触顾问：会话还没查过库时，把**与本轮请求最相关的那条技巧连同要点**直接推到动作点。
   *
   * 为什么不再只靠「本会话还没查过库」那句提醒：实测 24 小时里那条提醒出现了 145 次，
   * 而模型主动查询率仍是 **1%**（16/2420）；同一批会话里动作点顾问的跟进率是 **31%**。
   * 差别不在文字，在**出现的位置**：提醒躺在系统提示里，顾问出现在模型刚做完一次动作、
   * 正要决定下一步的那一刻。所以这里把提醒内容换成真东西，并走同一条已证明有效的通道。
   *
   * 三条约束与 `advisoryFor` 完全一致（同一份 `seen` / `advisoryLastTurn` 预算），
   * 外加一条它独有的约束：**每会话总数上限** `firstContactAdvisoryMax`（默认 1）。首触与
   * 动作点不同 —— 动作点由「模型正在动某个东西」驱动，本身就稀有；首触只由「还没查过库」
   * 驱动，而未检索会话可能连续几十轮都满足这个条件，所以它必须自己数次数。
   * 命中的是过门槛的检索结果（跑题不推）、每会话有总量上限、同一轮最多一条。
   *
   * @returns 顾问正文；不该推或没有过门槛的命中时 `undefined`。
   */
  const firstContactNote = (): string | undefined => {
    if (!settings.techniques || !settings.firstContactAdvisory) return undefined
    const sessionId = current?.sessionId
    if (sessionId === undefined || consultedSessions.has(sessionId)) return undefined
    // 次数上限先于检索判断：它的目的是「这个会话别再为首触花钱」，与有没有命中无关。
    const pushed = firstContactPushed.get(sessionId) ?? 0
    if (pushed >= settings.firstContactAdvisoryMax) {
      firstContactTally.cappedSessions.add(sessionId)
      return undefined
    }
    const seen = advisorySeen.get(sessionId) ?? new Set<string>()
    if (seen.size >= settings.techniqueAdvisoryMax) return undefined
    const liveTurn = current?.turns.at(-1)?.turn
    if (liveTurn !== undefined && advisoryLastTurn.get(sessionId) === liveTurn) return undefined
    const query = current?.turns.at(-1)?.user ?? ''
    if (query.trim().length === 0) return undefined
    // 用**顾问同款强证据匹配**而不是技巧段的检索：两条通道的取向不同 ——
    // 技巧段只给已验证知识（未验证的不自动注入），而顾问按设计可以推草稿并如实标注
    // （真库里 90% 是草稿，只看已验证等于在最需要它的场景里不发声）。未受邀请就推东西，
    // 精度比召回重要，所以坚持「命中必须是符号/领域这类强证据」。
    const corpus = gatedCorpus(current?.cwd).filter(doc => doc.layer === 'technique'
      && (settings.techniqueAdvisoryDrafts || doc.meta?.status !== 'draft'))
    const terms = [...new Set(tokenize(query))]
    const [top] = terms.length === 0 ? [] : advisoryMatches(corpus, terms, { limit: 1, seen })
    if (top === undefined) return undefined
    const record = techniqueById.get(top.id)
    const draft = record?.status === 'draft'
    const gist = (record?.gist ?? '').trim()
    const label = top.label.slice(0, 120)
    seen.add(top.id)
    advisorySeen.set(sessionId, seen)
    firstContactPushed.set(sessionId, pushed + 1)
    firstContactTally.pushed += 1
    noteSurfaced([top.id])
    if (liveTurn !== undefined) advisoryLastTurn.set(sessionId, liveTurn)
    logger.debug(`memory: first-contact advisory → ${top.id.slice(0, 11)}`)
    return advisoryText([
      `· 本会话还没查过知识库。与本轮最相关的一条：${label} [${top.id.slice(0, 11)}]`
      + `${draft ? ' (draft, unverified)' : ''}`
      + (gist.length === 0 ? '' : ` — ${gist.slice(0, 200)}`)
      + ' — technique_get for the full steps.',
    ])
  }

  /**
   * 把顾问正文包成宿主认识的 `UserMessage`。
   *
   * 来源必须是 `plugin`：宿主据此把它当注入上下文，**本插件的捕获端也按结构识别**
   * （`isInjectedUserMessage` 见 `source.kind === 'plugin'` 就整条丢弃）。用 `user` 来源
   * 会让这段文本变成「用户原话」，正是我们要防的自我放大。
   *
   * @param text - 顾问正文（以 `ADVISORY_MARKER` 起头）。
   * @returns 可直接放进 `additionalContexts` 的消息。
   */
  const advisoryMessage = (text: string): UserMessage => {
    // P4：顾问是**独立消息**通道，条数只能在这里数（注入块那段计数看不到它们）。
    metrics.advisories += 1
    metricsDirty = true
    track(flushMetrics())
    return {
      id: `ms_${randomUUID()}` as UserMessage['id'],
      role: 'user',
      content: [{ type: 'text', text }],
      source: PLUGIN_MESSAGE_SOURCE as UserMessage['source'],
    }
  }

  /**
   * ① **技巧**条目的重复形态：技巧的「全文」就是索引行（真正的正文始终要 `technique_get`），
   * 所以这里省掉的是「做法 / 何时用 / 状态」那一整行，而不是正文。
   *
   * 措辞刻意**不沿用**召回段那句「full text delivered」—— 技巧这一路从来没给过正文，只有索引行；
   * 写成「全文已给」会让模型以为手里已有步骤与示例，于是不再 `technique_get`（评审 F1）。
   * 召回段与技巧段都调它，因此两段对同一条卡的措辞必然一致。
   *
   * @param hit - 命中的技巧（id 与语料正文）。
   * @param record - 技巧记录；查不到记录时退化成 id + 首句。
   * @returns 指针行正文。
   */
  const repeatTechniquePointer = (hit: { id: string; text: string }, record: TechniqueRecord | undefined): string =>
    (record !== undefined
      ? `${record.id.slice(0, 11)} ${record.name}`
      : `${hit.id.slice(0, 11)} ${compactStandingText(hit.text)}`)
    + ' — unchanged, index line given earlier in this session (technique_get for the full card)'

  /**
   * ① 重复条目的指针形态：可寻址的把手 + 首句（上限与常驻紧凑形态同口径，默认 60 字符）。
   * 技巧给「id + 名称」（正文本来就要 `technique_get`），其余给「id + 首句」—— 有 id 才能被
   * `memory_search` / `memory_forget` 这类工具对上。
   *
   * 放在这里（而不是某个段自己的渲染函数里）是因为**召回段与技巧段共用**这套 ① 记账：
   * 同一张卡在这一轮可能由任一段渲染（`injectedTechniqueHits` 保证不会两段同时渲染同一条），
   * 两段必须用同一份 `repeatSent` 与同一句措辞，否则「已给过」这件事在两段之间会各说各话。
   *
   * ⚠️ **技巧条目转交 {@link repeatTechniquePointer}**（评审 F1）：召回段里的技巧条目同样只发
   * 索引行（②c 之后），从没给过 `summary` / `steps` / `pitfalls`。这里若沿用「full text delivered」，
   * 模型会以为手里已有全文 —— 而这些卡恰恰是技巧段放不下的第 N 条起，`pitfalls` / `verify`
   * 从未进过上下文，且不带 `technique_get` 的入口提示。生产实证：真会话注入里抓到过
   * `(technique) tq_7ce809a7 … — unchanged, full text delivered earlier in this session`。
   *
   * @param hit - 命中的条目（id 与正文）。
   * @param record - 技巧记录；非技巧条目为 `undefined`。
   * @returns 指针行正文。
   */
  const repeatPointerLine = (hit: { id: string; text: string }, record: TechniqueRecord | undefined): string =>
    record !== undefined
      ? repeatTechniquePointer(hit, record)
      : `${hit.id.slice(0, 11)} ${compactStandingText(hit.text)} — unchanged, full text delivered earlier in this session`

  const renderInjection = (query: string): string => {
    // DEF-12：召回语料里含 `toTechniqueDocs(...)`，而 `recall()` **不看状态** —— 草稿技巧
    // 会带着 `(technique)` 标签从这条通道进入上下文，与「草稿不参与自动注入」的承诺冲突，
    // 更糟的是让未经验证的知识获得了注入权威。专用技巧段走 `recallTechniques()` 有硬过滤，
    // 这里补上同一口径。工具侧（`memory_search` / `technique_search(includeDrafts)`）不受影响：
    // 那是模型显式发起的检索，看得到草稿是特性。
    //
    // 另一条过滤：**本会话自己的情景摘要不注入**。模型手里已经有这段对话，
    // 把自己的摘要再喂一遍既是纯重复（每轮都花 token、还占掉一个召回名额），
    // 又会被标成「(past session)」—— 那是在谎报来源，模型会当第三方知识看。
    // 记录照常落盘（后续会话要用），只是不回灌给写下它的那个会话；
    // 显式检索（`memory_search`）不受影响，模型主动查仍查得到。
    // 第三条过滤：**技巧段已经给过的技巧不再在召回段重复一遍**。两块各有各的形态
    // （召回段给的是完整正文，技巧段给的是要点 + id），同一条各付一次纯属浪费 ——
    // 实测真库上技巧段 3 条里有 2 条在召回段重复，合计 1857 字符，比技巧段全文还长。
    // 技巧层关掉时不去重（没有技巧段可与之重复）。
    const injectedTechniqueIds = new Set(injectedTechniqueHits(query).map(hit => hit.id))
    const selfSession = current?.sessionId
    const docs = gatedCorpus(current?.cwd).filter(doc => {
      // 已被取代的语义事实不注入（`memory_search` 仍能看到，并标 `superseded`）。
      if (doc.meta?.superseded === true) return false
      if (doc.layer === 'episodic' && selfSession !== undefined && doc.meta?.sessionId === selfSession) return false
      if (doc.layer !== 'technique') return true
      if (injectedTechniqueIds.has(doc.id)) return false
      const record = techniqueById.get(doc.id)
      return record !== undefined && injectable(record)
    })
    if (docs.length === 0) return ''
    // 常驻规则（长期偏好 / 约束）**不经过检索**：它们适用于任何任务，靠词重叠命中是
    // 碰运气 —— 一条「不要自动提交」的约束在本轮聊正则时一个词都对不上，于是永远不进上下文，
    // 而它恰恰是最该一直在的那类记忆。因此从检索语料里**摘出来**，按最新优先直取，
    // 排在检索命中之前。摘出来这一步是必须的：留在语料里的话 `injectStandingRules`
    // 的条数上限与 `0`（关闭）就管不住它们 —— 它们会从检索那条路照样进来。
    const standing = docs
      .filter(doc => isStandingRule(doc))
      .sort((left, right) => right.ts - left.ts)
      .slice(0, settings.injectStandingRules)
    const standingIds = new Set(standing.map(doc => doc.id))
    const queryDocs = docs.filter(doc => !standingIds.has(doc.id))
    // 与技巧层同一套 facet 机制：情景/语义层同样会「一句话讲了好几件事」，
    // 而且**当前轮碰过的文件**是比措辞更可靠的键（"为什么这个测试挂了"里没有文件名）。
    const recallDecisions: GateDecision[] = []
    const hits = recallDocsFacets(query, queryDocs, {
      limit: settings.recallLimit,
      extra: searchExtrasFor(current?.turns ?? [], query),
      gate: settings.injectionGate,
      onDecision: decision => recallDecisions.push(decision),
    })
    reportGate('recall', query, recallDecisions)
    const merged = [
      ...standing.map(doc => ({
        layer: doc.layer,
        id: doc.id,
        text: doc.text,
        ts: doc.ts,
        ...(doc.meta === undefined ? {} : { meta: doc.meta }),
      })),
      // 检索命中里若已含同一条常驻规则，不再重复一遍。
      ...hits.filter(hit => !standingIds.has(hit.id)),
    ]
    if (merged.length === 0) return ''
    // 命中**彼此**近重复时只留最能代表它的那一条（排序在前者胜）。同一段里塞 5 份
    // 措辞略异的同一件事，模型要付 5 遍 token 才读到一条信息，而且更难判断「这是同一件事」。
    // 比较**开头 80 字符**而不是「首行」：注入前正文会被压成单行，按 `\n` 切根本没有
    // 首行之别；而真实的重复（同一份请求写下的 N 份摘要）差别在后面，开头一长段完全一致。
    const headOf = (text: string): string => compactEntryText(text).slice(0, 80)
    const kept: typeof merged = []
    for (const hit of merged) {
      if (standingIds.has(hit.id)) { kept.push(hit); continue }
      const head = headOf(hit.text)
      // 两个条件缺一不可：**开头一致**挡掉「同一份记录写下的 N 份摘要」（真库实测它们彼此
      // 包含度 0.864–0.946），而「构建命令变体 1 / 变体 2」这类**同题不同参数**的条目
      // 开头就分叉，必须各自保留 —— 只按包含度去重会把它们合并，等于删掉可执行信息。
      if (kept.some(other => headOf(other.text) === head
        && maxContainment(hit.text, [other.text], tokenize) >= RECALL_DUPLICATE_RATIO)) {
        recallDedupeDrops.push(hit.id)
        continue
      }
      kept.push(hit)
    }
    // L1：这一块推给本会话的技巧记下来，供引用检测用。
    noteSurfaced(kept.filter(hit => hit.layer === 'technique').map(hit => hit.id))
    // ②a：常驻规则的全文/紧凑切换。全文的时机有四个：从没见过、规则集变了（增删改都会换签名）、
    // **同一轮内重复渲染**（宿主的 `text()` 是惰性回调，一轮里可能被调多次，同一轮必须给同一个
    // 形态，否则同一份上下文里出现两种写法）、以及距上次全文已过 `standingRuleFullEveryTurns` 轮。
    const standingSignature = standing.map(doc => doc.id).join(',')
    const standingSession = current?.sessionId
    const standingTurn = current?.turns.at(-1)?.turn
    const shownBefore = standingSession === undefined ? undefined : standingFullShown.get(standingSession)
    const fullEvery = settings.standingRuleFullEveryTurns
    const showFullStanding = shownBefore === undefined
      || shownBefore.signature !== standingSignature
      || (standingTurn !== undefined && shownBefore.turn === standingTurn)
      || (fullEvery > 0 && standingTurn !== undefined && shownBefore.turn !== undefined
        && standingTurn - shownBefore.turn >= fullEvery)
    // ①：本会话已完整给过、内容未变的条目改发指针形态。注入块就在对话历史里，模型上一轮已经读过；
    // 逐轮重印是纯付费（实测 674 个条目 / 7,618 次出现，**86.1% 的条目字符是重复**）。
    // 指针的两种形态（召回段 / 技巧段）与理由见 `repeatPointerLine` / `repeatTechniquePointer`。
    const repeatSession = current?.sessionId
    const sentForSession = settings.recallRepeatCompact && repeatSession !== undefined
      ? repeatSent.get(repeatSession)
      : undefined
    const renderedEntries: { id: string; hash: string; line: string; full: boolean }[] = []
    const lines = kept.map((hit, index) => {
      const kind = recallLabel(hit.layer, hit.meta?.kind)
      // 逐条整形（去掉与正文重复的标题 + 封顶）：整块预算再砍尾巴时，至少不会出现半截条目。
      // 常驻规则在非全文轮改走紧凑形态 —— 它保的仍是「一句可执行的话」，不是标题。
      //
      // ②c：**技巧层在召回段里也只给索引行**（名称 / 状态 / 做法要点 / 触发条件 / id），与技巧段
      // 同构，不再把 400 字符的正文再印一遍。依据是实测：召回段里 569 条技巧条目平均 391 字符
      // （基本顶到 `RECALL_ENTRY_CHARS`），而技巧段对同一条只花约 180 字符 —— 同一类知识两条通道
      // 两种颗粒度，既不一致，又让技巧条目吃掉召回段 11.7% 的块成本。正文统一交给 `technique_get`。
      // 注意这**不是**把技巧从召回段删掉：技巧段只放得下 `techniqueLimit` 条，第 4 条起仍由召回段
      // 呈现（否则它们会彻底消失，见 DEF-29），只是改用同一个索引行形态。
      const record = hit.layer === 'technique' ? techniqueById.get(hit.id) : undefined
      const standingRule = standingIds.has(hit.id)
      const hash = contentHash(hit.text)
      const previous = sentForSession?.get(hit.id)
      // 全文的时机：常驻规则走 ②a 自己的节奏（不参与 ①，否则「每轮在场」的语义会被指针吃掉）、
      // 从没见过、**内容变了**、同一轮内重复渲染（保持同形态）、以及距上次全文已过 N 轮；
      // 收到 compaction 事件时记账会被整份作废，于是这里自然回到「从没见过」。
      const showFull = standingRule
        || previous === undefined
        || previous.hash !== hash
        || (standingTurn !== undefined && previous.fullTurn === standingTurn)
        || (fullEvery > 0 && standingTurn !== undefined && previous.fullTurn !== undefined
          && standingTurn - previous.fullTurn >= fullEvery)
      const body = showFull
        ? (record !== undefined
          ? techniqueInjectionLine(record)
          : standingRule && !showFullStanding
            ? compactStandingText(hit.text)
            : compactEntryText(hit.text))
        : repeatPointerLine(hit, record)
      const line = `${index + 1}. (${kind}) ${sanitizeForInjection(body)}`
      renderedEntries.push({ id: hit.id, hash, line, full: showFull })
      return line
    })
    // 常驻规则与「本轮相关」的条目在同一个块里，必须让模型分清语气差别，否则它会把
    // 一条与本轮无关的偏好当成跑题的噪声而忽略掉。
    const rendered = renderBlock(
      RECALL_BLOCK,
      standing.length === 0 ? [] : STANDING_RULE_NOTICE,
      lines,
      settings.recallChars,
    )
    // 记账只在常驻**全文**真的落进这一块之后才推进。评审 F2：`clipHead` 保头截断，预算不足时
    // 会把末尾的常驻规则截在句子中间；被截断却记成「已发全文」，这条规则在
    // `standingRuleFullEveryTurns` 轮内就再也没机会完整出现过（下次只会给紧凑形态）。
    // 判据是「渲染结果里确实含常驻那几行的完整文本」—— 早退与空 query 的情形自然也挡在外面。
    if (standingSession !== undefined && standing.length > 0 && showFullStanding
      && rendered.includes(lines.slice(0, standing.length).join('\n'))) {
      standingFullShown.set(standingSession, { signature: standingSignature, turn: standingTurn })
    }
    // ① 记账（同样只记**真的完整落在块里**的条目）：只有全文形态那一次才推进 `fullTurn` ——
    // 指针形态若也推进，定期重发会被自己顶掉，「每 N 轮给一次全文」就永远不触发。
    if (repeatSession !== undefined && renderedEntries.length > 0) {
      const state = repeatSent.get(repeatSession) ?? new Map<string, { hash: string; fullTurn: number | undefined }>()
      for (const entry of renderedEntries) {
        if (!rendered.includes(entry.line)) continue
        const previous = state.get(entry.id)
        state.set(entry.id, {
          hash: entry.hash,
          fullTurn: entry.full ? standingTurn : previous?.fullTurn,
        })
      }
      repeatSent.set(repeatSession, state)
    }
    return rendered
  }

  /**
   * 注入与技巧检索共用的语料：按 `appliesTo` 闸门筛掉「判得出来且明确不适用」的技巧。
   *
   * 过滤放在语料层而不是打分之后，是为了让**两条后端**（内存 BM25 与 SQLite 索引）口径一致：
   * 打分器返回的 id 也要能在这份语料里找到，找不到就被丢掉。
   *
   * @param cwd - 会话工作目录。
   * @returns 已过滤的文档。
   */
  const gatedCorpus = (cwd: string | undefined): RecallDoc[] => {
    const files = (current?.turns ?? []).flatMap(turn => turn.files)
    const stack = current?.stack
    return corpusFor(cwd).filter(doc => doc.layer !== 'technique'
      || appliesToAllows(doc.meta?.appliesTo, { files, ...(stack === undefined ? {} : { stack }) }))
  }

  /**
   * 本轮技巧段会注入哪几条技巧（同一轮只算一次）。
   *
   * 两个 section 都从这里取，为的是**跨块去重**：记忆召回段的语料里也含技巧层，
   * 各渲染各的时同一条技巧会以两种形态各付一遍 token —— 实测真库上技巧段 3 条里有 2 条
   * 在召回段又出现一次，而且召回段那份是更长的正文（1857 字符 vs 技巧段全文 1137）。
   * section 的渲染顺序不保证，所以谁先渲染谁算，另一个人直接拿缓存。
   *
   * @param query - 本轮召回查询词。
   * @returns 技巧段将注入的命中；未开启技巧层时为空。
   */
  const injectedTechniqueHits = (query: string): readonly RecalledMemory[] => {
    if (!settings.techniques) return []
    if (techniqueHitCache?.query === query) return techniqueHitCache.hits
    const docs = gatedCorpus(current?.cwd)
    const decisions: GateDecision[] = []
    const hits = docs.length === 0 ? [] : recallFacets(query, docs, {
      limit: settings.techniqueLimit,
      ...(current?.stack === undefined ? {} : { stack: current.stack }),
      partition: settings.partition,
      symbols: symbolsInText(query),
      extra: searchExtrasFor(current?.turns ?? [], query),
      scorer: indexScorer(false),
      gate: settings.injectionGate,
      onDecision: decision => decisions.push(decision),
    })
    reportGate('techniques', query, decisions)
    techniqueHitCache = { query, hits }
    return hits
  }

  /**
   * 渲染技巧层的**索引**注入。
   *
   * 只给索引行（名称 / 状态 / 适用栈 / 触发条件 / id），完整步骤与示例交给
   * `technique_get` 按需展开 —— 这是控制上下文成本的关键。
   *
   * 过滤链：状态（草稿与废弃不注入）→ 分区 → 技术栈 → BM25 + 置信度。
   * 敏感级别不在这里过滤 —— `confidential` 在**写入时**就进不了全局域。
   *
   * ①（0.2.x）：本会话已经给过索引行、且内容未变的条目改发**指针**（id + 名称 + 去哪儿取正文）。
   * 依据是实测：技巧段占插件注入成本 31.8%，其中**同一会话内重复给的索引行**占该段 36.5% ——
   * 「哪条技巧和当前任务相关」在一个会话里是稳定属性，逐轮重印整行是纯付费。同一轮内重复渲染、
   * 内容变化、以及每 `standingRuleFullEveryTurns` 轮仍给完整索引行（与召回段同一套记账与节奏）。
   *
   * @param query - 召回查询词（通常是当前会话最近的用户输入）。
   * @returns 注入文本；无可注入内容时为空串。
   */
  const renderTechniqueInjection = (query: string): string => {
    if (!settings.techniques) return ''
    const hits = injectedTechniqueHits(query)
    if (hits.length === 0) return ''
    noteSurfaced(hits.map(hit => hit.id))
    const repeatSession = current?.sessionId
    const sentForSession = settings.recallRepeatCompact && repeatSession !== undefined
      ? repeatSent.get(repeatSession)
      : undefined
    // 与召回段用同一个「第几轮」时钟：两个段共用 `standingRuleFullEveryTurns`，各算各的会不一致。
    const repeatTurn = current?.turns.at(-1)?.turn
    const fullEvery = settings.standingRuleFullEveryTurns
    const entries: { id: string; hash: string; line: string; full: boolean }[] = []
    const lines = hits.map((hit, index) => {
      const record = techniqueById.get(hit.id)
      const hash = contentHash(hit.text)
      const previous = sentForSession?.get(hit.id)
      const showFull = previous === undefined
        || previous.hash !== hash
        || (repeatTurn !== undefined && previous.fullTurn === repeatTurn)
        || (fullEvery > 0 && repeatTurn !== undefined && previous.fullTurn !== undefined
          && repeatTurn - previous.fullTurn >= fullEvery)
      const body = showFull
        ? (record === undefined ? hit.text : techniqueInjectionLine(record))
        : repeatTechniquePointer(hit, record)
      const line = `${index + 1}. ${sanitizeForInjection(body)}`
      entries.push({ id: hit.id, hash, line, full: showFull })
      return line
    })
    // 没注册工具时别提工具名：指向一个不存在的工具只会让模型白试一轮。
    const extraHeader = settings.registerTools ? TECHNIQUE_ADOPTION_NOTICE : []
    const rendered = renderBlock(TECHNIQUE_BLOCK, extraHeader, lines, settings.techniqueChars)
    // 记账与召回段同一条规矩：只有**真的完整落进块里**的条目才推进，且只有全文那一次推进
    // `fullTurn`（指针形态若也推进，「每 N 轮给一次完整索引行」会被自己顶掉）。
    if (repeatSession !== undefined && entries.length > 0) {
      const state = repeatSent.get(repeatSession) ?? new Map<string, { hash: string; fullTurn: number | undefined }>()
      for (const entry of entries) {
        if (!rendered.includes(entry.line)) continue
        const previous = state.get(entry.id)
        state.set(entry.id, {
          hash: entry.hash,
          fullTurn: entry.full ? repeatTurn : previous?.fullTurn,
        })
      }
      repeatSent.set(repeatSession, state)
    }
    return rendered
  }

  /**
   * 渲染「工作前先检索」的常驻指引。
   *
   * 三个返回空串的前提，都是为了**不付没有回报的 token**：
   * 1. 配置关掉了指引；
   * 2. 没注册工具 —— 指引全是工具名，指向不存在的工具只会让模型白试一轮；
   * 3. 库里没有任何可检索的东西 —— 此时「先查一下」查不到任何结果，纯属浪费。
   *
   * 第 3 条刻意用「**库非空**」而不是「本轮有命中」：最需要这条指引的，正是那些
   * 库里一条现成经验都没有的陌生任务（模型得先知道库存在、且知道该主动查）。
   * 也正因如此，技巧层关掉时也要给出只提 `memory_search` 的版本。
   *
   * @returns 注入文本；不该注入时为空串。
   */
  /**
   * 本会话是否已经查过知识库（`technique_search` / `memory_search` 都算）。
   *
   * 只用于**关掉**那条「本会话还没查过库」的提醒：一旦查过就不再重复说 —— 提示语因此是
   * 有界且自我消除的成本，而不是每轮都付的常驻文本。空的搜索结果也算「查过」：
   * 提示语要解决的是「没想到去查」，不是「查了没结果」。
   */
  const consultedSessions = new Set<string>()

  /**
   * 汇总库的覆盖：条数 + 主题（领域优先，退到首个标签）。
   *
   * 刻意**不按当前技术栈过滤主题**：有 MC 技巧的任务与有 PlantUML 技巧的任务都该知道
   * 「库里确实有东西」。写死某个技术栈会让别的任务收不到这条信号（实测 MC 移植会话里
   * 模型 147 次工具调用一次没查库，而提示语只说了一句通用策略）。
   *
   * @param docs - 当前会话可见的语料。
   * @returns 已验证/草稿条数与主题标签（按条数降序，最多 6 个）。
   */
  const libraryCoverage = (docs: readonly RecallDoc[]): { verified: number; drafts: number; topics: string[] } => {
    const counts = new Map<string, number>()
    let verified = 0
    let drafts = 0
    for (const doc of docs) {
      if (doc.layer !== 'technique') continue
      if (doc.meta?.status === 'validated' || doc.meta?.status === 'canonical') verified += 1
      else if (doc.meta?.status === 'draft') drafts += 1
      // 领域与标签经常同一件事两种写法（`PlantUML` vs `plantuml`）：按小写归并，
      // 否则覆盖摘要会印出两条重复项。
      const topic = (doc.meta?.domain ?? doc.meta?.tags?.[0])?.toLowerCase()
      if (topic !== undefined && topic.length > 0) counts.set(topic, (counts.get(topic) ?? 0) + 1)
    }
    const topics = [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 6)
      .map(([topic, count]) => `${topic} (${count})`)
    return { verified, drafts, topics }
  }

  const renderGuidance = (): string => {
    if (!settings.guidance || !settings.registerTools) return ''
    const docs = corpusFor(current?.cwd)
    const hasMemories = docs.some(doc => doc.layer !== 'technique')
    // 草稿也算「查得到」：`technique_search(includeDrafts)` 正是要模型主动去翻未验证的知识。
    const hasTechniques = settings.techniques && docs.some(doc => doc.layer === 'technique')
    if (!hasMemories && !hasTechniques) return ''
    const sessionId = current?.sessionId
    if (settings.techniques && sessionId !== undefined && !consultedSessions.has(sessionId)) {
      const coverage = libraryCoverage(gatedCorpus(current?.cwd))
      const lines = unconsultedGuidanceLines(coverage.verified, coverage.drafts, coverage.topics)
      return renderBlock(GUIDANCE_BLOCK, [], lines, GUIDANCE_MAX_CHARS)
    }
    const lines = settings.techniques ? GUIDANCE_LINES : GUIDANCE_MEMORY_ONLY_LINES
    return renderBlock(GUIDANCE_BLOCK, [], lines, GUIDANCE_MAX_CHARS)
  }

  /**
   * 把工具入参整理成草稿：与自动提炼走同一条脱敏 + 去标识化管线。
   *
   * `base` 给定时是**按 id 就地更新**（DEF-32）：只覆盖显式给出的字段，其余沿用原记录；
   * 适用栈与敏感级别也沿用原记录 —— 改一句措辞不该顺手改掉它的适用性闸门。
   *
   * @param input - 工具入参。
   * @param base - 被更新的原记录；新建时省略。
   * @returns 已过安全管线的草稿。
   */
  const manualDraft = (input: TechniqueSaveInput, base?: TechniqueRecord): TechniqueDraft => {
    const gist = input.gist === undefined ? base?.gist : input.gist.trim()
    const steps = input.steps ?? base?.steps
    const invariants = input.invariants ?? base?.invariants
    const subject = input.subject === undefined ? base?.subject : input.subject.trim()
    const location = input.location === undefined ? base?.location : input.location.trim()
    const reuse = input.reuse === undefined ? base?.reuse : input.reuse.trim()
    const appliesTo = input.appliesTo === undefined ? base?.appliesTo : input.appliesTo.trim()
    const api = input.apiSymbols === undefined
      ? base?.api
      : input.apiSymbols.map(symbol => ({ symbol }))
    const example = input.example === undefined
      ? base?.example
      : { language: input.exampleLanguage ?? 'text', kind: 'usage' as const, code: input.example }
    const domain = normalizeDomain(input.domain ?? base?.domain)
    const draft: TechniqueDraft = {
      kind: input.kind ?? base?.kind ?? 'procedure',
      name: (input.name ?? base?.name ?? '').trim(),
      ...(gist === undefined ? {} : { gist }),
      when: (input.when ?? base?.when ?? '').trim(),
      summary: (input.summary ?? base?.summary ?? '').trim(),
      ...(steps === undefined ? {} : { steps: [...steps] }),
      ...(invariants === undefined ? {} : { invariants: [...invariants] }),
      ...(subject === undefined ? {} : { subject }),
      ...(location === undefined ? {} : { location }),
      ...(reuse === undefined ? {} : { reuse }),
      ...(appliesTo === undefined ? {} : { appliesTo }),
      ...(api === undefined ? {} : { api: [...api] }),
      ...(example === undefined ? {} : { example }),
      pitfalls: [...(input.pitfalls ?? base?.pitfalls ?? [])],
      verify: [...(input.verify ?? base?.verify ?? [])],
      stack: base?.stack ?? current?.stack ?? { languages: [] },
      ...(domain === undefined ? {} : { domain }),
      tags: (input.tags ?? base?.tags ?? []).map(tag => tag.toLowerCase()),
      evidence: base?.evidence ?? [],
      sensitivity: base?.sensitivity ?? 'internal',
      status: base?.status ?? 'draft',
    }
    return abstractDraft(draft, current)
  }

  /**
   * 用草稿的**内容字段**覆盖记录，簿记字段一律沿用原记录。
   *
   * 就地更新最容易犯的错是「顺手把计数清了」：`successes` / `verifications` / `status` 是
   * 这条技巧为什么被信任的全部依据，改措辞不该让它们归零。
   *
   * @param record - 原记录。
   * @param draft - 已过安全管线的新内容。
   * @param now - 更新时间。
   * @returns 可直接写入的记录。
   */
  const applyTechniqueContent = (record: TechniqueRecord, draft: TechniqueDraft, now: number): TechniqueRecord => ({
    id: record.id,
    ts: record.ts,
    updatedAt: now,
    scope: record.scope,
    partition: record.partition,
    status: record.status,
    sensitivity: record.sensitivity,
    stack: record.stack,
    evidence: record.evidence,
    deidentified: true,
    hits: record.hits,
    applied: record.applied,
    successes: record.successes,
    failures: record.failures,
    provenance: record.provenance,
    ...(record.verifications === undefined ? {} : { verifications: record.verifications }),
    ...(record.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: record.lastVerifiedAt }),
    ...(record.conflictsWith === undefined ? {} : { conflictsWith: record.conflictsWith }),
    // 遥测字段同样**必须沿用**（0.2.10 修）：这张白名单以前漏了 `retrieveCount` / `referenced`，
    // 于是一次「改措辞」就把「这条被检索过/被引用过」的记录清零 —— 归档判据正是读这两个字段，
    // 被清零的活卡会被误判成死重归档掉。
    ...(record.retrieveCount === undefined ? {} : { retrieveCount: record.retrieveCount }),
    ...(record.lastRetrievedAt === undefined ? {} : { lastRetrievedAt: record.lastRetrievedAt }),
    ...(record.referenced === undefined ? {} : { referenced: record.referenced }),
    ...(record.lastReferencedAt === undefined ? {} : { lastReferencedAt: record.lastReferencedAt }),
    // 归档位也沿用：`technique_save(id=…)` 是改内容，不该顺手把归档状态翻掉。
    // 要复活一条归档卡，靠的是 `technique_apply` 成功（见 `applyOutcome`）。
    ...(record.archivedAt === undefined ? {} : { archivedAt: record.archivedAt }),
    kind: draft.kind,
    name: draft.name.trim(),
    ...(draft.gist === undefined || draft.gist.trim().length === 0 ? {} : { gist: draft.gist.trim() }),
    when: draft.when.trim(),
    summary: draft.summary.trim(),
    ...(draft.steps === undefined ? {} : { steps: [...draft.steps] }),
    ...(draft.subject === undefined ? {} : { subject: draft.subject }),
    ...(draft.location === undefined ? {} : { location: draft.location }),
    ...(draft.reuse === undefined ? {} : { reuse: draft.reuse }),
    ...(draft.appliesTo === undefined ? {} : { appliesTo: draft.appliesTo }),
    ...(draft.invariants === undefined ? {} : { invariants: [...draft.invariants] }),
    ...(draft.api === undefined ? {} : { api: [...draft.api] }),
    ...(draft.example === undefined ? {} : { example: draft.example }),
    pitfalls: [...draft.pitfalls],
    verify: [...draft.verify],
    ...(draft.domain === undefined ? {} : { domain: draft.domain }),
    tags: [...new Set(draft.tags)].slice(0, MAX_TECHNIQUE_TAGS),
  })

  /**
   * 组装一段注入块：**头部与尾部边界永不截断**，只压缩中间的条目正文。
   *
   * 为什么不能对整段 `clipHead`：块头是「这些是不可信数据、不得当指令」的安全声明，
   * 边界是它的作用域围栏。按整段截断时，配置一压到最小预算，尾部的 `END` 甚至整块
   * 条目都会被裁掉 —— 模型收到的是半个头部、没有围栏的注入（DEF-08）。
   *
   * 因此上限约束的是**正文**：`limit - 固定开销`。当上限小于固定开销时，声明与边界
   * 仍会完整给出（长度会略超上限）—— 安全边界优先于长度上限。
   *
   * @param block - 块定义（提供头部与尾部）。
   * @param extraHeader - 追加在头部之后的固定行（如采用回报提示）。
   * @param lines - 条目行。
   * @param limit - 配置的字符上限。
   * @returns 可直接注入的整块文本。
   */
  const renderBlock = (
    block: InjectionBlock,
    extraHeader: readonly string[],
    lines: readonly string[],
    limit: number,
  ): string => {
    const head = [...block.header, ...extraHeader]
    // 固定开销 = 头部 + 尾部，再 +1 是正文与尾部之间的那个换行 —— 漏掉它会让总长比
    // 配置上限多 1 个字符（DEF-13，白盒用例实测 520 → 521）。
    const fixed = `${head.join('\n')}\n${block.footer}`.length + 1
    const budget = Math.max(0, limit - fixed)
    const body = lines.join('\n')
    // budget 必须显式判 0：`clipHead(body, 0)` 会走 `slice(0, -1)` 把**几乎整段**正文留下，
    // 等于上限失效（实测最小预算下反而注入了 840 字符）。
    const clipped = budget <= 0 ? '' : (body.length <= budget ? body : clipHead(body, budget))
    return [...head, ...(clipped.length > 0 ? [clipped] : []), block.footer].join('\n')
  }

  /**
   * 失败预警/提醒共用的「当前动作上下文」：最近 3 轮的用户原话、工具名与文件路径。
   *
   * 两者口径刻意不同：
   * - **词元上下文**只看最近 3 轮：措辞与文件是「当下在干什么」，久了就不代表现在；
   * - **工具集合**看整个会话：会话用什么工具是稳定属性，而成本本身由「逐指纹一次 +
   *   每会话总量上限」兜住，不需要再靠缩短窗口来省。
   *
   * @param state - 当前会话状态。
   * @returns 上下文的词元集合与本会话用过的工具名。
   */
  const failureActionContext = (state: LiveSession): { contextTokens: Set<string>; sessionTools: Set<string> } => {
    const query = [
      ...state.turns.slice(-3).map(turn => turn.user),
      ...state.turns.slice(-3).flatMap(turn => turn.tools),
      ...state.turns.slice(-3).flatMap(turn => turn.files),
    ].join('\n')
    return {
      contextTokens: new Set(tokenize(query)),
      sessionTools: new Set(state.turns.flatMap(turn => turn.tools)),
    }
  }

  /**
   * 渲染失败预警注入。
   *
   * 排序刻意让「本会话刚犯过的错」置顶：同一轮里刚出现的失败，远比历史统计更值得立刻纠正。
   * 只注入达到重复阈值、未被解决、技术栈适用的记录，且受每会话条数上限约束 ——
   * 预警一旦变成噪音就会被忽略，反而不如不注入。
   *
   * 段末追加**已解决记录的提前提醒**（见 {@link renderLessons}）：预警管「你又犯了」，
   * 提醒管「这个场景以前踩过、已经解决，动手前先把结论拿走」。两者语气不同、阈值不同，
   * 因此共用一段但各自成行，模型一眼能分清哪个是当下正在犯的。
   *
   * @returns 注入文本；无可注入内容时为空串。
   */
  const renderFailureInjection = (): string => {
    if (!settings.failures) return ''
    const state = current
    if (state === undefined) return ''
    // DEF-14：这里必须用 `failureState()`（缺则建）而不是 `failuresBySession.get()`。
    // 用 `.get` 时，一个「本会话从未观测到失败、却撞见了历史失败」的会话拿到 undefined，
    // 于是**预警发出去了但没登记** → 该会话永远不可能计入 `prevented`，
    // 而这正是最常见的情形（预警本来就是给没犯过这个错的本会话看的）。
    const session = failureState(state.sessionId)
    const turn = currentTurnOf(state)
    // 相关性判据（与 `renderLessons` 同一套）：指纹的工具名或触发场景要对得上当前动作。
    const { contextTokens, sessionTools } = failureActionContext(state)
    const hitThisSession = (record: FailureRecord): boolean =>
      session?.lastSeenTurn.has(record.fingerprint.key) === true

    let skippedIrrelevant = 0
    // P2：本会话**预警之后又犯了同一个错**的指纹。它们不参与「每会话每指纹只讲一次」的去重 ——
    // 那条规矩是给「还没犯过」的会话省 token 的；本会话已经犯过之后，沉默只会让模型在同一个
    // 坑里连撞下去（实测头部两个指纹回合内复发 47 / 29 次，而它一个字都没再收到提醒）。
    const repeatedKeys = new Set<string>()
    const isRepeated = (record: FailureRecord): boolean => {
      if (!settings.failureRepeatEscalate) return false
      const key = record.fingerprint.key
      const advisedAt = session?.advisoriesSent.get(key)
      if (advisedAt === undefined) return false
      // 同一轮内重渲染：保持同形态（否则取后一次渲染结果的路径会把这条升级吞掉）。
      if (session?.repeatAt.get(key) === turn) return true
      // 否则只看「上次讲它之后，又真的犯了一次没有」—— 只重发不重犯不算复发。
      return (session?.lastSeenTurn.get(key) ?? -1) > advisedAt
    }
    const candidates = [...failureById.values()].filter(record => {
      if (!(shouldWarn(record, escalation))) return false
      if (session?.forgiven.has(record.fingerprint.key) ?? false) return false
      const repeated = isRepeated(record)
      // B7：同一条预警在本会话里只发一次。它是给「还没犯这个错」的会话看的；
      // 同一场景每轮重发同一段文字，模型已经读过，只是噪声与开销
      // （最多 3 条 × 1500 字符/请求）。场景真的再次发生时，机械失败会被重新观测到，
      // 那时走的是「你又犯了」的计数路径，而不是重发这条历史预警。
      // P2 起，那个「你又犯了」的路径真的会讲一句（`failureRepeatLine`），不再沉默。
      if (!repeated && (session?.advisoriesSent.has(record.fingerprint.key) ?? false)) return false
      if (!failureApplies(record, state.stack)) return false
      if (!(record.scope === 'project' || record.partition === settings.partition)) return false
      // 与本会话动作无关的预警不讲当下的事，只是在花 token —— 除非本会话**确实犯过**
      // 这个指纹（那是「你又犯了」，永远放行）。
      // `sessionTools.size === 0`：会话还没有任何工具调用时**一律放行** —— 那正是预警最该
      // 出现的时刻（用户刚说「接着写 report.json」，而历史失败就是写它时 ENOENT）。
      // 这里收紧过一次，被既有用例「闭环度量：预警后…计入 prevented」当场抓住：新会话没有
      // 动作上下文，闸门把所有预警都挡掉了。放行成本有界（逐指纹一次 + 每会话总量上限）。
      if (settings.failureInjectRelevantOnly && !hitThisSession(record)
        && sessionTools.size > 0
        && !lessonMatches(record, contextTokens, sessionTools)) {
        skippedIrrelevant += 1
        return false
      }
      if (repeated) repeatedKeys.add(record.fingerprint.key)
      return true
    })

    // 每会话总量上限：逐指纹去重挡不住「指纹一多，一轮 3 条连着十几轮」。
    const delivered = session?.advisoriesSent.size ?? 0
    const sessionBudget = settings.failureInjectPerSession <= 0
      ? Number.POSITIVE_INFINITY
      : Math.max(0, settings.failureInjectPerSession - delivered)
    const cap = Math.min(settings.failureInjectLimit, sessionBudget)
    failureGateTally.skippedIrrelevant += skippedIrrelevant
    failureGateTally.skippedBudget += Math.max(0, candidates.length - cap)

    const now = Date.now()
    const score = (record: FailureRecord): number =>
      (session?.lastSeenTurn.has(record.fingerprint.key) === true ? 1000 : 0)
      + record.occurrences * 10
      + Math.max(0, 9 - (now - record.lastSeen) / (24 * 60 * 60 * 1000))

    const ranked = candidates
      .sort((left, right) => score(right) - score(left))
      .slice(0, cap)
    const recentFiles = state.turns.at(-1)?.files ?? []
    const warnings = ranked.map(record => {
      const repeated = repeatedKeys.has(record.fingerprint.key)
      if (session !== undefined && !session.warned.has(record.fingerprint.key)) {
        session.warned.set(record.fingerprint.key, { turn, recordId: record.id })
      }
      // 预警之后又犯：升级成「刚刚又犯」，并**推进** `advisoriesSent` 的轮次戳 ——
      // 基线不推进的话，这条升级会在之后每一轮重发（模型只是没再犯，不该被反复训话）。
      if (repeated) session?.repeatAt.set(record.fingerprint.key, turn)
      session?.advisoriesSent.set(record.fingerprint.key, turn)
      // 只在本会话确实见过这个指纹时才给出现场文件：全局域记录不带项目路径。
      const files = hitThisSession(record) ? recentFiles : []
      if (repeated) {
        return sanitizeForInjection(failureRepeatLine(
          record,
          session?.observedCount.get(record.fingerprint.key) ?? 2,
          files,
        ))
      }
      return sanitizeForInjection(failureWarningLine(record, files))
    })
    const lessons = renderLessons(state, cap - warnings.length)
    if (warnings.length === 0 && lessons.length === 0) return ''
    // DEF-07：两类条目同处一段，编号必须**连续** —— 各自从 1 开始会让「已解决提醒」
    // 与「你又犯了」的编号撞车，削弱块头刻意强调的语气区分。
    const lines = [...warnings, ...lessons].map((line, index) => `${index + 1}. ${line}`)
    return renderBlock(FAILURE_BLOCK, [], lines, settings.failureInjectChars)
  }

  /**
   * 渲染**已解决**失败在当前场景下的提前提醒。
   *
   * 为什么需要它：`shouldWarn` 要求「未解决 + 达到重复阈值」，于是一条被标记解决的记录
   * 从此彻底沉默 —— 哪怕同一个坑明天再踩一次也不会有人提醒。这里按**场景**而不是按
   * 次数把它们端出来：只要当前上下文与记下的触发方式对得上（见 `lessonMatches`），
   * 就把「触发场景 + 当时的做法」先给模型，让它绕开。
   *
   * 只提醒有解决方案的记录：没有做法的提醒只是噪音。已 `failure_forgive` 的不再提醒。
   *
   * @param state - 当前会话状态。
   * @param budget - 还能用几条（与预警共享 `failureInjectLimit`）。
   * @returns 每行一条的提醒文本；无可提醒内容时为空数组。
   */
  const renderLessons = (state: LiveSession, budget: number): string[] => {
    if (budget <= 0) return []
    const session = failuresBySession.get(state.sessionId)
    const { contextTokens, sessionTools } = failureActionContext(state)
    if (contextTokens.size === 0) return []

    return [...failureById.values()]
      .filter(record =>
        record.status === 'deprecated'
        && record.remedy.length > 0
        && !(session?.forgiven.has(record.fingerprint.key) ?? false)
        // 提醒同样每会话只发一次：同一条「已解决提醒」在同一个场景里每轮重发，模型已经读过。
        && !(session?.advisoriesSent.has(record.fingerprint.key) ?? false)
        && failureApplies(record, state.stack)
        && (record.scope === 'project' || record.partition === settings.partition)
        && lessonMatches(record, contextTokens, sessionTools))
      .sort((left, right) => right.lastSeen - left.lastSeen)
      .slice(0, budget)
      .map(record => {
        session?.advisoriesSent.set(record.fingerprint.key, currentTurnOf(state))
        return sanitizeForInjection(failureLessonLine(record))
      })
  }

  /** 失败工具行为实现。 */
  const failureDeps = (): FailureToolDeps => ({
    async list(limit, includeResolved) {
      await refresh(current?.cwd)
      const records = [...failureById.values()]
        .filter(record => includeResolved || record.status !== 'deprecated')
        .sort((left, right) => right.occurrences - left.occurrences || right.lastSeen - left.lastSeen)
        .slice(0, limit)
      if (records.length === 0) return 'No recurring failure recorded.'
      return [
        `${records.length} recurring failure(s):`,
        ...records.map(record => failureDetail(record)),
      ].join('\n')
    },
    async resolve(id, remedy, trigger) {
      await refresh(current?.cwd)
      const record = failureById.get(id)
      if (record === undefined) return `No failure with id "${id}".`
      const clean = remedy === undefined ? record.remedy : sanitizeForStore(remedy.trim(), current, projectCwd())
      // 已解决记录要留下「触发方式」，它决定这条记录将来还能不能在相似场景被提前端出来。
      // 人工给的优先；没给就用机械推导的粗粒度描述兜底（`deriveTrigger`）。
      const cleanTrigger = trigger === undefined
        ? failureTrigger(record)
        : sanitizeForStore(trigger.trim(), current, projectCwd())
      const updated: FailureRecord = {
        ...record,
        remedy: clean,
        ...(cleanTrigger === undefined ? {} : { trigger: cleanTrigger }),
        status: 'deprecated',
        resolvedAt: Date.now(),
        occurrencesAtResolve: record.occurrences,
        updatedAt: Date.now(),
      }
      // 本次复发回合到此结束：下次复发会从零起算回合内次数（`relapses` 继续累加，不丢历史）。
      delete updated.occurrencesAtReopen
      const ok = await runFailureWrite(async () =>
        store.updateFailure(updated, updated.scope === 'project' ? projectCwd() : undefined))
      await refresh(current?.cwd)
      if (!ok) return `Could not update failure "${id}".`
      const scene = cleanTrigger === undefined ? '' : ` Trigger scene: "${cleanTrigger}".`
      const relapses = record.relapses ?? 0
      return `Marked resolved: "${record.symptom}"${clean.length > 0 ? ` with remedy "${clean}"` : ' (no remedy recorded)'}.${scene}`
        + ' It will stay silent unless a future session runs into the same trigger scene, where it resurfaces as a heads-up.'
        + (relapses === 0
          ? ''
          : ` Note: it had already relapsed ${relapses} time(s) after an earlier resolve — if it happens again the record is re-opened and warned about immediately.`)
    },
    async forgive(id) {
      await refresh(current?.cwd)
      const record = failureById.get(id)
      if (record === undefined) return `No failure with id "${id}".`
      const state = current
      if (state === undefined) return 'No active session to forgive in.'
      failureState(state.sessionId).forgiven.add(record.fingerprint.key)
      return `Forgiven for this session: "${record.symptom}". Warnings (and, later, interception) are suppressed until the session ends.`
    },
  })

  /**
   * 选出当前会话对该次调用应当采取的干预。
   *
   * 返回 `undefined` 表示放行。三条过滤（状态、逃生舱、技术栈/分区）先于匹配，
   * 因此「已解决」的记录与用户 `failure_forgive` 过的记录都不会再被干预。
   *
   * @param name - 即将执行的工具名。
   * @param args - 该次调用的参数。
   * @param enforcement - 只取该强度的记录（`ask` 或 `block`）。
   * @returns 命中的记录；无命中时 `undefined`。
   */
  const intercept = (
    name: string,
    args: unknown,
    enforcement: FailureRecord['enforcement'],
  ): FailureRecord | undefined => {
    if (!settings.failures) return undefined
    const state = current
    if (state === undefined) return undefined
    const session = failuresBySession.get(state.sessionId)
    for (const record of failureById.values()) {
      if (record.enforcement !== enforcement) continue
      if (record.status === 'deprecated') continue
      if (record.guard === undefined || record.guard.tool !== name) continue
      if (session?.forgiven.has(record.fingerprint.key) === true) continue
      if (!failureApplies(record, state.stack)) continue
      if (record.scope !== 'project' && record.partition !== settings.partition) continue
      if (guardMatches(record.guard, name, args)) return record
    }
    return undefined
  }

  /**
   * 派发前的**询问**：`enforcement === 'ask'` 的记录触发一次审批。
   *
   * 用 `ask` 而不是直接拒绝，是因为这一级别还有歧义 —— 让用户决定比替用户决定更安全。
   * `guard`（同步、单调）拿不到审批能力，所以它只负责 `block`。
   */
  ctx.on('tools/pre-execute', async (exec, next) => {
    const record = intercept(exec.name, exec.arguments, 'ask')
    if (record !== undefined) return { kind: 'ask', reason: failureDenialReason(record) }
    return next()
  })

  /** 挖掘用的模型路由：配置优先，其次复用会话最近一次请求的路由。 */
  const mineRoute = (): ModelRoute | undefined => {
    if (settings.provider !== undefined && settings.model !== undefined) {
      return { provider: settings.provider, model: settings.model }
    }
    return current?.route
  }

  /**
   * 库中已有的主题标签，按使用频次倒序取前 N 个 —— 喂给挖掘提示以收敛 `domain` 写法。
   *
   * 为什么必须这么做：`techniqueKey(name, when, domain)` 把 domain 算进合并键，实测同一主题
   * 在一个库里被写成 **28 种**不同标签（`minecraft-modding` / `Minecraft Forge modding / …`），
   * 于是本该合并的近重复条目全部新建。给词表是成本最低的收敛手段。
   *
   * @param limit - 最多给出多少个标签。
   * @returns 主题标签列表。
   */
  const knownDomainsForMining = (limit = 24): string[] => {
    const counts = new Map<string, number>()
    for (const record of techniqueById.values()) {
      // 归一化后再计数：迁移之前落盘的旧写法（`PlantUML`）也要与写入侧同口径，
      // 否则「同一领域两种写法」会继续被当成两个词喂给模型。
      const domain = normalizeDomain(record.domain)
      if (domain === undefined) continue
      counts.set(domain, (counts.get(domain) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([domain]) => domain)
  }

  /** 判断挖掘出的草稿是否允许写入目标作用域（confidential 默认不进全局域）。 */
  const storableDraft = (draft: TechniqueDraft, scope: MemoryScope): boolean =>
    scope === 'project' || settings.allowConfidentialGlobal || (draft.sensitivity ?? 'internal') !== 'confidential'

  /**
   * 记一次「被模型显式检索」（`technique_search` / `technique_get`）。
   *
   * 只记显式检索：**自动注入不计数** —— 它每请求都会发生，逐请求记账会变成写风暴；而我们要回答的
   * 问题恰恰是「模型有没有主动去查」。写失败只记 debug，绝不让记账把检索本身搞挂。
   *
   * @param ids - 本次返回给模型的技巧 id。
   */
  /**
   * L1：记下「这些技巧被推给过本会话」。
   *
   * 引用检测只在**推过**的卡里找 —— 「模型用了某条没给它的知识」不算这条知识的功劳。
   */
  const noteSurfaced = (ids: readonly string[]): void => {
    const sessionId = current?.sessionId
    if (sessionId === undefined || ids.length === 0) return
    const seen = surfacedBySession.get(sessionId) ?? new Set<string>()
    for (const id of ids) seen.add(id)
    surfacedBySession.set(sessionId, seen)
  }

  /**
   * 本次调用的参数里逐字出现了这张卡的**几个**引用针（③ 多符号的证据强度）。
   *
   * 与 `needleInArgs` 同源：泛化针一律不计，内置名在 `referenceNeedles` 里就已经被剔除。
   *
   * @param id - 技巧 id。
   * @param raw - 工具参数的原始文本。
   * @returns 命中的针数（0 = 没有精确命中）。
   */
  const needleHitCount = (id: string, raw: string): number => {
    const record = techniqueById.get(id)
    if (record === undefined) return 0
    let needles = needlesById.get(id)
    if (needles === undefined) {
      needles = referenceNeedles(record)
      needlesById.set(id, needles)
    }
    return needles.filter(needle => !genericNeedles.has(needle) && mentionsNeedle(raw, needle)).length
  }

  /**
   * ③ 记下「针 + 文件」的关联：这些卡在**这次调用触及的文件**上逐字命中过。
   *
   * @param ids - 本次调用里逐字命中针的技巧 id。
   * @param raw - 工具参数的原始文本（用于取文件路径）。
   */
  const noteNeedleFiles = (ids: readonly string[], raw: string): void => {
    const sessionId = current?.sessionId
    if (sessionId === undefined || ids.length === 0) return
    const files = filesFromArguments(raw)
    if (files.length === 0) return
    const byFile = needleFiles.get(sessionId) ?? new Map<string, Set<string>>()
    for (const file of files) {
      const existing = byFile.get(file)
      if (existing === undefined && byFile.size >= NEEDLE_FILES_PER_SESSION) continue
      const hit = existing ?? new Set<string>()
      for (const id of ids) hit.add(id)
      byFile.set(file, hit)
    }
    needleFiles.set(sessionId, byFile)
  }

  /**
   * ③ 文件级精确命中：这张卡是否**已经在本会话的这个文件上**逐字命中过。
   *
   * @param id - 技巧 id。
   * @param raw - 本次调用的参数（用于取当前文件）。
   * @returns 是则为 `true`。
   */
  const filePrecise = (id: string, raw: string): boolean => {
    const sessionId = current?.sessionId
    if (sessionId === undefined) return false
    const byFile = needleFiles.get(sessionId)
    if (byFile === undefined) return false
    return filesFromArguments(raw).some(file => byFile.get(file)?.has(id) === true)
  }

  /**
   * 这条卡的引用针是否**逐字**出现在本次调用的参数里（L1 与 L4 共用）。
   *
   * @param id - 技巧 id。
   * @param raw - 工具参数的原始文本。
   * @returns 命中时为 `true`。
   */
  const needleInArgs = (id: string, raw: string): boolean => needleHitCount(id, raw) > 0

  /**
   * L1：把「模型在工具调用参数里引用了这条卡」记到记录上。
   *
   * 落盘方式与 {@link noteTechniqueRetrieval} 完全一致（读-改-写 + 内存索引同步），
   * 但**不碰置信度**：`confidenceOf()` 仍然只认显式回报的成功/失败 —— 「被提及」不是「被验证」。
   *
   * @param ids - 本批被引用的技巧 id。
   */
  const noteTechniqueReference = async (ids: readonly string[]): Promise<void> => {
    const now = Date.now()
    const patched: TechniqueRecord[] = []
    for (const id of new Set(ids)) {
      const record = techniqueById.get(id)
      if (record === undefined) continue
      patched.push({
        ...record,
        referenced: (record.referenced ?? 0) + 1,
        lastReferencedAt: now,
        // ⑤ 口径版本随计数一起写：维护据此判断「这个数是哪一版针规则攒的」。
        referenceEpoch: REFERENCE_EPOCH,
      })
    }
    if (patched.length === 0) return
    try {
      const cwd = patched.some(record => record.scope === 'project') ? projectCwd() : undefined
      await store.updateTechniques(patched, cwd)
      for (const record of patched) techniqueById.set(record.id, record)
    } catch (error) {
      logger.debug(`memory: reference not recorded (${describe(error)})`)
    }
  }

  /**
   * L1：从一次工具调用里检测引用。
   *
   * 只看**模型写下的参数**（不看工具结果），且只在本会话**被推过**、**还没记过**的卡里比 ——
   * 每次调用最多比几张卡，成本可忽略。同一条卡每个会话只记一次：否则一个符号出现在每一处编辑里
   * 会把计数灌成噪声。
   *
   * 落盘是 **await 的**（不是 `track` 的 fire-and-forget）：引用是稀有事件（每条卡每会话至多一次），
   * 而丢了它等于这个信号不存在 —— 观测功能不值得为一次写盘延迟做取舍。
   *
   * @param exec - 工具调用（名字 + 原始参数）。
   */
  const detectReferences = async (
    exec: { name: string; arguments: unknown },
  ): Promise<{ id: string; needle: string }[]> => {
    const sessionId = current?.sessionId
    if (!settings.techniques || sessionId === undefined) return []
    const surfaced = surfacedBySession.get(sessionId)
    if (surfaced === undefined || surfaced.size === 0) return []
    const done = referencedBySession.get(sessionId) ?? new Set<string>()
    const raw = typeof exec.arguments === 'string' ? exec.arguments : JSON.stringify(exec.arguments ?? {})
    const hitIds: string[] = []
    const matched: { id: string; needle: string }[] = []
    for (const id of surfaced) {
      if (done.has(id)) continue
      const record = techniqueById.get(id)
      if (record === undefined) continue
      let needles = needlesById.get(id)
      if (needles === undefined) {
        needles = referenceNeedles(record)
        needlesById.set(id, needles)
      }
      const needle = needles.find(item => !genericNeedles.has(item) && mentionsNeedle(raw, item))
      if (needle === undefined) continue
      hitIds.push(id)
      matched.push({ id, needle })
    }
    if (hitIds.length === 0) return []
    // ③ 文件级：这次调用在**哪个文件**上逐字命中了这些卡 —— 后续对该文件的改动也算精确命中。
    // 放在 L1 这一层是为了覆盖非改文件的工具（`read` / `grep` 也会点到符号与文件）。
    noteNeedleFiles(hitIds, raw)
    for (const id of hitIds) done.add(id)
    referencedBySession.set(sessionId, done)
    logger.debug(`memory: technique referenced → ${hitIds.map(id => id.slice(0, 11)).join(', ')}`)
    await noteTechniqueReference(hitIds)
    return matched
  }

  const noteTechniqueRetrieval = async (ids: readonly string[]): Promise<void> => {
    // 「查过库」不等于「搜过库」：`technique_get`（按 id 直接读）与 `memory_search` 命中的技巧
    // 同样是主动咨询。实测子智能体会话只 get 不 search，提醒于是重复了 5–12 次/轮 —— 每轮
    // 白白多付约 300 字符。这里统一关闭提醒，比在四个调用点各写一遍可靠。
    if (current !== undefined) {
      consultedSessions.add(current.sessionId)
      // 记下「本会话读过哪些技巧」：落盘前用它拦掉「把刚读到的条目再写一遍」（见 C）。
      const seen = retrievedBySession.get(current.sessionId) ?? new Set<string>()
      for (const id of ids) seen.add(id)
      retrievedBySession.set(current.sessionId, seen)
    }
    const now = Date.now()
    const patched: TechniqueRecord[] = []
    for (const id of new Set(ids)) {
      const record = techniqueById.get(id)
      if (record === undefined) continue
      patched.push({ ...record, retrieveCount: (record.retrieveCount ?? 0) + 1, lastRetrievedAt: now })
    }
    if (patched.length === 0) return
    try {
      const cwd = patched.some(record => record.scope === 'project') ? projectCwd() : undefined
      await store.updateTechniques(patched, cwd)
      // 本地索引同步：同一轮里再记账时不能读到旧计数。
      for (const record of patched) techniqueById.set(record.id, record)
    } catch (error) {
      logger.debug(`memory: could not record technique retrieval: ${describe(error)}`)
    }
  }

  /**
   * 按 id 删除一条技巧，并返回人类可读的应答。
   *
   * `memory_forget`（拿到 `memory_search` 的 id）与 `technique_forget` 共用它，
   * 避免两处各写一遍删除逻辑与文案。
   *
   * @param id - 技巧 id。
   * @returns 删除结果说明。
   */
  const forgetTechniqueById = async (id: string): Promise<string> => {
    const targets: MemoryScope[] = settings.scopeTechnique === 'global' ? ['global'] : ['project', 'global']
    let removed = 0
    for (const target of targets) {
      removed += await store.forgetTechnique(
        target,
        target === 'project' ? projectCwd() : undefined,
        settings.partition,
        id,
      )
    }
    await refresh()
    return removed === 0 ? `No technique matched "${id}".` : `Removed ${removed} technique(s).`
  }

  /**
   * 校验 `memory_save(supersedes)` 的目标：必须是一条**当前可检索到**、且与本层同作用域的语义事实。
   *
   * 为什么先校验再写：写进去才发现目标不存在，会留下「新事实已生效、旧的仍在注入」的
   * 半吊子状态。宁可整条拒绝，也不做半件事。
   *
   * @param id - 目标事实 id。
   * @param scope - 本次写入的作用域。
   * @returns 拒绝说明；可以继续时返回 `undefined`。
   */
  const checkSupersedeTarget = async (id: string, scope: MemoryScope): Promise<string | undefined> => {
    if (!id.startsWith('sm_')) {
      return `Refused: "${id}" is not a semantic fact id — only facts and preferences can be superseded. Nothing was saved.`
    }
    await refresh(current?.cwd)
    const target = corpusFor(current?.cwd).find(doc => doc.layer === 'semantic' && doc.id === id)
    if (target === undefined) {
      return `No memory matched "${id}" — nothing was saved. Run memory_search first to get the id of the fact you want to replace.`
    }
    if (target.meta?.scope !== scope) {
      // 跨作用域「取代」会留下一条仍在注入的旧事实，因此直接拒绝并给出可行路径。
      return `Refused: "${id}" lives in scope ${target.meta?.scope ?? 'unknown'} while new facts are written to ${scope}. `
        + 'Delete it with memory_forget instead. Nothing was saved.'
    }
    return undefined
  }

  /**
   * 按 id 删除一条失败记录，并返回人类可读的应答。
   *
   * 失败层的写入是「指纹合并」，所以误记（把一次偶发当反复犯）只能整条删掉 ——
   * `failure_resolve` 只是标记解决，记录仍然参与「相似场景提前提醒」。
   *
   * @param id - 失败 id（`fa_` 前缀）。
   * @param targets - 要查找的作用域。
   * @returns 删除结果说明。
   */
  const forgetFailureById = async (id: string, targets: readonly MemoryScope[]): Promise<string> => {
    let removed = 0
    for (const target of targets) {
      removed += await store.forgetFailure(
        target,
        target === 'project' ? projectCwd() : undefined,
        settings.partition,
        id,
      )
    }
    await refresh()
    return removed === 0 ? `No failure matched "${id}".` : `Removed ${removed} failure record(s).`
  }

  /** 工具行为实现：与提示注入复用同一套存储与召回。 */
  const toolDeps = (): MemoryToolDeps => ({
    async search(query, limit, scope) {
      if (current !== undefined) consultedSessions.add(current.sessionId)
      const cwd = current?.cwd
      await refresh(cwd)
      // 与注入路径、技巧检索同一套 facet 机制。`scope` 是**真过滤**：
      // 语料是项目域 + 全局域合并的，这里按桶打好的标记筛一遍，
      // 否则「scope project」会连别的项目、乃至全局库的内容一起返回。
      const corpus = corpusFor(cwd)
      const scoped = scope === 'all' ? corpus : corpus.filter(doc => doc.meta?.scope === scope)
      const hits = recallDocsFacets(query, scoped, { limit, extra: searchExtrasFor(current?.turns ?? [], query) })
      // 技巧也会从这里返回（`memory_search` 不过滤草稿），所以同样计入检索遥测：
      // 遥测问的是「模型有没有主动查过它」，与经由哪个工具无关。
      await noteTechniqueRetrieval(hits.filter(hit => hit.layer === 'technique').map(hit => hit.id))
      if (hits.length === 0) return `No memory matched "${query}" (scope ${scope}).`
      return [
        `${hits.length} memory item(s) for "${query}" (scope ${scope}):`,
        ...hits.map(hit => formatHit(hit)),
      ].join('\n')
    },
    async save(text, kind, supersedes) {
      const scope = settings.scopeSemantic
      const cwd = scope === 'project' ? projectCwd() : undefined
      // 工具写入与自动提炼走同一条安全管线：只脱敏不去标识化的话，
      // 项目私有标识会经工具这条旁路进入（默认全局的）语义层。
      const clean = sanitizeForStore(text.trim(), current, cwd)
      // 改口（DEF-31）：语义层的合并键是**归一化文本**，所以「换成另一句话」写出来的是新记录，
      // 旧的那条会继续被注入 —— 而容量淘汰偏偏「先保命中多的」，过时的那条因为 hits 高更长寿。
      // 显式 `supersedes` 才标记，不做语义猜测：猜错会把两条互补的事实说成互相取代。
      if (supersedes !== undefined) {
        const refusal = await checkSupersedeTarget(supersedes, scope)
        if (refusal !== undefined) return refusal
      }
      const records = await store.upsertSemantic([{ kind, text: clean }], {
        scope,
        partition: settings.partition,
        ...(cwd === undefined ? {} : { cwd }),
        sessionId: current?.sessionId ?? 'manual',
        tags: ['manual'],
        ...(supersedes === undefined ? {} : { supersedes }),
      })
      await refresh(cwd)
      const stored = records.find(record => record.text === clean)
      const head = `Saved to long-term memory (${scope}): "${clean}"${stored === undefined ? '' : ` [id ${stored.id}]`}`
      if (supersedes === undefined) return head
      const target = records.find(record => record.id === supersedes)
      if (target?.supersededBy === undefined) {
        return `${head} — the text matched the memory it was meant to replace, so nothing was superseded.`
      }
      return `${head} — supersedes ${supersedes} (kept in the store, no longer injected).`
    },
    async forget(id, scope) {
      // DEF-05：`memory_search` 会返回技巧层的 `tq_` id，而本工具只遍历情景/语义层，
      // 于是「按 id 删除」对它必然答 `No memory matched` —— 契约说到的就得做到。
      if (id.startsWith('tq_')) return forgetTechniqueById(id)
      // DEF-27：失败层同样没有删除路径 —— `failure_list` 把 `fa_` id 交给模型，
      // 而 `memory_forget` 只遍历情景/语义层，误记的失败只能「标记已解决」，永远留在库里
      // 并继续在相似场景被端出来。`store.forgetFailure()` 一直存在（还有单测），只是没人调用。
      if (id.startsWith('fa_')) {
        return forgetFailureById(id, scope === 'all' ? ['project', 'global'] : [scope])
      }
      const targets: MemoryScope[] = scope === 'all' ? ['project', 'global'] : [scope]
      let removed = 0
      for (const target of targets) {
        removed += await store.forget(
          target,
          target === 'project' ? projectCwd() : undefined,
          id,
          settings.partition,
        )
      }
      await refresh()
      return removed === 0 ? `No memory matched "${id}".` : `Removed ${removed} memory record(s).`
    },
    async stats() {
      const cwd = current?.cwd
      await refresh(cwd)
      const docs = corpusFor(cwd)
      const episodic = docs.filter(doc => doc.layer === 'episodic').length
      // episodic 是 project 作用域，`corpusFor` 只覆盖当前工作目录。另给一个跨项目总数，
      // 否则别的项目那十几条整个不在报告里，读起来像库是空的。
      const episodicTotal = await store.countProjectEpisodic()
      const semantic = docs.filter(doc => doc.layer === 'semantic').length
      // 被取代的事实不注入、但仍在库里，单说条数会让人以为它们还在生效。
      const superseded = docs.filter(doc => doc.layer === 'semantic' && doc.meta?.superseded === true).length
      const techniques = docs
        .filter(doc => doc.layer === 'technique')
        .map(doc => techniqueById.get(doc.id))
        .filter((record): record is TechniqueRecord => record !== undefined)
      const verified = techniques.filter(injectable).length
      // 归档卡既不算 verified 也不算 draft：它们是第三类状态。以前那行算术
      // （`length - verified`）会把归档的**已验证**卡算成草稿，读起来像库在退化。
      const archived = techniques.filter(record => record.archivedAt !== undefined).length
      const drafts = techniques.filter(record => record.status === 'draft' && record.archivedAt === undefined).length
      return [
        `Memory root: ${settings.dir}`,
        `Layer scopes: episodic=${settings.scopeEpisodic}, semantic=${settings.scopeSemantic}, technique=${settings.scopeTechnique}, failure=${settings.scopeFailure} (partition ${settings.partition})`,
        // 宿主版本决定协议形状（消息来源），选错会让注入被格式校验拒绝 —— 必须自报，
        // 否则「换了 dsh 版本后注入静默消失」只能靠考古。
        `Session format: dsh-session ${SESSION_VERSION.length === 0 ? 'unknown（按 0.1 线）' : SESSION_VERSION}`
          + ` → plugin message source kind '${PLUGIN_MESSAGE_SOURCE.kind}'`,
        `Episodic summaries: ${episodic} (this project) · ${episodicTotal} (all projects)`,
        `Semantic facts: ${semantic}${superseded === 0 ? '' : ` (${superseded} superseded, not injected)`}`,
        `Techniques: ${verified} verified, ${drafts} draft`
          + (archived === 0 ? '' : `, ${archived} archived (excluded from injection, still searchable)`),
        // M2：采用率与「检索过但未采用」——冷启动问题必须能被看见，否则任何"让模型更主动"的
        // 改动都无法判断是否有效。没有 retrieveCount 的历史记录按「从未被显式检索」计。
        (() => {
          const total = techniques.length
          const adopted = techniques.filter(record => record.successes > 0).length
          const retrieved = techniques.filter(record => (record.retrieveCount ?? 0) > 0).length
          const coldDrafts = techniques.filter(record => record.status === 'draft' && (record.retrieveCount ?? 0) === 0).length
          const rate = total === 0 ? '0' : (100 * adopted / total).toFixed(1)
          return `Technique adoption: ${adopted}/${total} adopted (${rate}%), ${retrieved} retrieved at least once, `
            + `${coldDrafts} draft(s) never retrieved`
        })(),
        // L1：引用检测。这是**除显式回报之外**唯一能看出「推给模型的技巧有没有被用上」的数。
        // 它与上面那行要挨着看：采纳 0 + 引用不为 0 = 用了但没回报；两个都是 0 = 连碰都没碰。
        // 注意它**不进置信度**（`confidenceOf` 只认显式回报），所以两行不同源是刻意的。
        (() => {
          const total = techniques.length
          const referenced = techniques.filter(record => (record.referenced ?? 0) > 0).length
          const events = techniques.reduce((sum, record) => sum + (record.referenced ?? 0), 0)
          const rate = total === 0 ? '0' : (100 * referenced / total).toFixed(1)
          // ⑤ 口径版本必须可见：跨版本比较这个数没有意义（旧口径的计数已被维护清零）。
          return `Technique references: ${referenced}/${total} referenced at least once (${rate}%), ${events} event(s) [counter epoch ${REFERENCE_EPOCH}]`
        })(),
        // 评审 F4：首触是唯一没有计数的通道 —— 加了上限之后，「这个会话为什么没收到首触」
        // （是没命中、还是被每会话上限拦下）必须能从回执侧回答。
        `First-contact advisories: ${firstContactTally.pushed} pushed this process, `
          + `${firstContactTally.cappedSessions.size} session(s) hit the per-session cap `
          + `(firstContactAdvisoryMax=${settings.firstContactAdvisoryMax}, ${settings.firstContactAdvisory ? 'on' : 'off'})`,
        // 门槛拦下多少条是**看不见的**（不注入就没有痕迹），因此单独报一行：排查
        // 「不相关技巧仍被注入」时，先看这里是不是 0 —— 0 说明门槛根本没在干活。
        // P4：累计口径从 `metrics.json` 读（热重载不再清零），进程内口径单独标出 ——
        // 两个口径混在一行里冒充过（实测把「同一进程攒的 297 条首触」误读成突破每会话上限）。
        `Injection gate: ${metrics.gateDropped} dropped / ${metrics.gateKept} kept since install `
          + `(this process ${gateTally.dropped} dropped / ${gateTally.kept} kept; `
          + `last request ${gateTally.lastDropped} dropped / ${gateTally.lastKept} kept)`,
        `Telemetry (persisted): injections=${metrics.injections}, advisories=${metrics.advisories}, `
          + `this process +${metrics.injections - metricsBaseline.injections} injection(s) `
          + `/+${metrics.advisories - metricsBaseline.advisories} advisory message(s)`,
        `Recurring failures: ${[...failureById.values()].filter(record => record.status !== 'deprecated').length} active, `
          + `${[...failureById.values()].filter(record => record.status === 'deprecated').length} resolved, `
          + `${[...failureById.values()].reduce((sum, record) => sum + record.prevented, 0)} prevented`,
        // 失败段同样有看不见的拦截：没注入就没有痕迹，必须报出来。
        `Failure gate: ${failureGateTally.skippedIrrelevant} skipped as irrelevant, `
          + `${failureGateTally.skippedBudget} skipped by per-session budget`,
        ...(store.integrityBroken
          ? [`Store integrity: BROKEN — ${store.brokenFile ?? 'unknown file'} cannot be decoded; writes are refused until the key is restored`]
          : store.undecodableLines > 0
            ? [`Store integrity: ${store.undecodableLines} undecodable line(s) skipped`]
            : []),
        `Active session turns (transient): ${current?.turns.length ?? 0}`,

        `Experience compounding: reflections=${metrics.reflections}, skipped=${metrics.skipped}, new=${metrics.newTechniques}, duplicates=${metrics.duplicateTechniques}, backoff=${metrics.backoff}`,
        // 「为什么这次没学」：判定的理由不报出来，三条闸门拦下的东西完全不可见。
        `Reflection gate: ${reflectTally.decisions} decision(s) this process, last = ${reflectTally.last}`,
        // 复述过滤是在花完模型调用**之后**才起作用的，所以必须报出来：否则「反思跑了但没落盘」
        // 会被误读成「反思没学到东西」。
        `Restatement filter: ${restatementDrops.length} candidate(s) dropped this process`
          + (restatementDrops.length === 0 ? '' : ` — e.g. ${restatementDrops.slice(-3).join(' | ')}`),
        // 召回命中之间的近重复去重：与门槛同理，拦下的东西在上下文里没有痕迹，必须报出来。
        `Recall dedupe: ${recallDedupeDrops.length} near-duplicate hit(s) dropped this process`
          + (recallDedupeDrops.length === 0 ? '' : ` — e.g. ${recallDedupeDrops.slice(-3).join(' | ')}`),
      ].join('\n')
    },
  })

  /** 一次待落盘的采用回报（校验已过、证据已脱敏收敛）。 */
  interface PreparedAdoption {
    record: TechniqueRecord
    outcome: 'success' | 'failure'
    evidence: string
    /** 这次成功是作者会话自己报的自证（不计入 `successes`，见 {@link TechniqueVerification.selfReported}）。 */
    selfReported: boolean
  }

  /**
   * 采用回报的公共前置：解析 id → 校验证据 → 组装新记录（**不落盘**）。
   *
   * 单条与批量共用同一条路径，保证「证据必须可证伪」的口径只有一处实现。
   * 返回字符串表示拒绝（可直接回给模型），返回对象表示可以落盘。
   *
   * @param id - 技巧 id 或唯一前缀。
   * @param outcome - 采用结果。
   * @param evidence - 可证伪的验收证据。
   * @returns 待落盘结果，或拒绝说明。
   */
  const prepareAdoption = async (
    id: string,
    outcome: 'success' | 'failure',
    evidence: string,
  ): Promise<PreparedAdoption | string> => {
    await refresh(current?.cwd)
    const resolved = resolveTechniqueId(id, [...techniqueById.values()])
    if (!resolved.ok) return `No technique resolved for "${id}": ${resolved.reason}.`
    const record = resolved.record

    const check = checkVerificationEvidence(evidence)
    if (!check.ok) {
      // 拒绝时把「怎么才算合格」和这条技巧**自己的判据**一起回给模型：
      // 只说 "invalid" 会让它重试同样的空话，而判据正是它该照着的模板。
      const criteria = record.verify.length === 0
        ? ['(this technique records no explicit verification criteria — state what you checked and what you observed)']
        : record.verify.map(item => `  - ${item}`)
      return [
        `Refused: no verification recorded for "${record.name}" — ${check.reason}.`,
        'Evidence must be falsifiable: say what you checked and the concrete result you observed.',
        'Good: "re-ran `npm test`: 240/240 pass (was 238)". Bad: "works" / "已采用".',
        'Verify criteria recorded for this technique:',
        ...criteria,
      ].join('\n')
    }

    // 证据是**新增的落盘写入路径**，必须与其余四层同口径：先过安全管线（凭据脱敏 →
    // 私有标识占位 → 区外绝对路径占位），再收敛长度。两者都在校验之后：
    // 校验看全文，避免把写在末尾的具体锚点截掉后反被判为不合格（DEF-15/16）。
    const stored = clampVerificationEvidence(sanitizeForStore(check.value, current, current?.cwd))
    // P0.2 判据（两条都成立才算自证）：
    //  1. 这张卡是**本会话**写的 —— `evidence` 里带着本会话的来源会话记录（写入时必盖）；
    //  2. 本会话**没有显式检索过**它 —— 没走过 `technique_search` / `technique_get`。
    // 第 2 条是给「先写过、后来在别处的任务里真的查回它并验收」留的门：那是一次独立的检索动作，
    // 不是顺手给自己刚写的东西盖章。
    const selfReported = outcome === 'success'
      && current?.sessionId !== undefined
      && record.evidence.some(item => item.kind === 'session' && item.sessionId === current?.sessionId)
      && retrievedBySession.get(current.sessionId)?.has(record.id) !== true
    const updated = applyOutcome(record, {
      outcome,
      evidence: stored,
      at: Date.now(),
      ...(current?.sessionId === undefined ? {} : { sessionId: current.sessionId }),
      ...(current?.cwd === undefined ? {} : { cwd: current.cwd }),
      ...(selfReported ? { selfReported: true } : {}),
    })
    return { record: updated, outcome, evidence: stored, selfReported }
  }

  /**
   * 把一次采用回报渲染成回给模型的一行。
   * @param prepared - 待落盘结果。
   * @param withEvidence - 是否附上证据原文（单条回报时附，批量时省略以省字符）。
   * @returns 一行说明。
   */
  const adoptionLine = (prepared: PreparedAdoption, withEvidence: boolean): string => {
    const { record } = prepared
    const kept = record.verifications?.length ?? 0
    const head = `Recorded ${prepared.outcome} for "${record.name}" `
      + `(status ${record.status}, confidence ${confidenceOf(record).toFixed(2)}).`
      // 自证必须**当场说清为什么没加分**，否则模型会以为回报生效了、下次照样自报成功；
      // 同时给出可执行的那一步：换个会话、或先真的检索一次，再报同样的结果。
      + (prepared.selfReported
        ? ' Self-reported: this session wrote the technique and never retrieved it, so it is not counted'
          + ' toward validation or promotion; it counts once another session retrieves it and reports the same result.'
        : '')
    return withEvidence ? `${head}\nEvidence #${kept}: ${prepared.evidence}` : head
  }

  /**
   * 索引打分器：给 `recallFacets` 用。
   *
   * 返回 `undefined` 表示「这次用不了索引，请回退内存 BM25」——索引未启用、查询没有 token、
   * 或索引读取出错都走这条路。回退是**静默且自动**的，因为检索可用性不该依赖可选后端。
   *
   * @param includeDrafts - 是否包含草稿（工具显式检索时为 true）。
   * @param includeArchived - 是否包含已归档的技巧（默认 false：注入通道必须先排除死重）。
   * @returns 打分器函数。
   */
  const indexScorer = (includeDrafts: boolean, includeArchived = false): TechniqueScorer => (query, limit) => {
    if (techniqueIndex === undefined) return undefined
    try {
      return techniqueIndex.search(query, limit, {
        includeDrafts,
        includeArchived,
        partition: settings.partition,
        ...(current?.stack === undefined ? {} : { stack: current.stack }),
      })
    } catch {
      return undefined
    }
  }

  /** 技巧工具行为实现。 */
  const techniqueDeps = (): TechniqueToolDeps => ({
    async search(query, limit, includeDrafts, verbose, includeArchived = true) {
      if (current !== undefined) consultedSessions.add(current.sessionId)
      const cwd = current?.cwd
      await refresh(cwd)
      // 与注入路径同一份语料：`appliesTo` 判得出来且明确不适用时不给。
      // `memory_search`（显式检索）不做这道闸门 —— 那是「这条为什么没出现」的逃生口。
      const docs = gatedCorpus(cwd)
      const extras = searchExtrasFor(current?.turns ?? [], query)
      const facets = facetQueries(query, docs, extras)
      const recallOptions = {
        limit,
        ...(current?.stack === undefined ? {} : { stack: current.stack }),
        partition: settings.partition,
        symbols: symbolsInText(query),
        extra: extras,
        // 显式检索默认**看得见归档卡**（它们是「退出竞争」，不是「删掉」）——
        // 这正是归档相对删除的价值：错归档可逆，而且模型能靠 id 重新展开它。
        includeArchived,
      }
      // 0.2.8：默认只看已验证时，若**库里的最佳答案其实是草稿**，就在同一次响应里把它带回来。
      //
      // 判据是同一份排名内的分数比较，不是命中条数 —— 实测 BM25 总会把 limit 填满（三种真实
      // 查询都返回 5 条已验证），所以「已验证命中不足」这个条件永远不成立。而「草稿分更高」在
      // 那三条查询上分别以 14.7>13.6、8.9>6.5、22.0>8.8 成立，并且正好把三条对题的草稿卡
      // （会话级状态、`ctx.tools.restrict` opt-in、token 计量）送到第一屏；默认参数下第一屏
      // 是 `tq_05bee0d2`/`tq_a1626970`/`tq_5e2c895d`，与提问无关。
      //
      // 为什么必须当场给：旧行为是「报个数量，让模型再调一次 includeDrafts: true」——那个
      // 第二步决策与顾问的 `technique_get` 同类，实测 18 次提示 0 次执行，于是草稿永远等不到采用。
      const scanLimit = Math.max(limit, DRAFT_SCAN_LIMIT)
      const draftInclusive = recallFacets(query, docs, {
        ...recallOptions,
        limit: scanLimit,
        includeDrafts: true,
        scorer: indexScorer(true, includeArchived),
      })
      const verifiedOnly = includeDrafts
        ? []
        : recallFacets(query, docs, {
          ...recallOptions,
          includeDrafts: false,
          scorer: indexScorer(false, includeArchived),
        })
      const isDraftHit = (hit: { id: string }): boolean => techniqueById.get(hit.id)?.status === 'draft'
      const bestDraft = draftInclusive.find(isDraftHit)
      const bestVerified = draftInclusive.find(hit => !isDraftHit(hit))
      const fallbackToDrafts = !includeDrafts
        && bestDraft !== undefined
        && (bestVerified === undefined || bestDraft.score > bestVerified.score)
      const hits = (includeDrafts || fallbackToDrafts ? draftInclusive : verifiedOnly).slice(0, limit)
      const draftHits = hits.filter(isDraftHit)
      // 只有「没有回退」时才需要报告被隐藏的草稿数量（回退时它们已经在结果里了）。
      const hiddenDrafts = includeDrafts || fallbackToDrafts ? [] : draftInclusive.filter(isDraftHit)
      if (hits.length === 0) {
        return `No technique matched "${query}" for the current stack.`
      }
      await noteTechniqueRetrieval(hits.map(hit => hit.id))
      // 把 facet 写进表头：一次调用覆盖了哪几个主题是**可核对**的，而不是黑箱。
      const facetNote = facets.length > 1 ? ` (facets: ${facets.slice(1, 5).join(' | ')})` : ''
      // 候选分两档付钱：前几条给可执行要点，其余只给「还存在」的指针。
      // 依据是实测 —— 逐条都展开时模型无从判断该看哪条，结果全部展开（12 次 technique_get）。
      const render = (hit: (typeof hits)[number], index: number, detailed: boolean): string => {
        const record = techniqueById.get(hit.id)
        if (record === undefined) return `${index + 1}. ${sanitizeForPrompt(hit.text)}`
        if (verbose) return `${index + 1}. ${sanitizeForPrompt(techniqueIndexLine(record))} — score ${hit.score.toFixed(2)}`
        return sanitizeForPrompt(detailed
          ? techniqueSearchLine(record, index + 1)
          : techniqueTailLine(record, index + 1))
      }
      const detailed = hits.slice(0, DETAILED_HITS)
      const tail = hits.slice(DETAILED_HITS)
      const draftNote = hiddenDrafts.length === 0
        ? ''
        : ` (+${hiddenDrafts.length} draft(s) hidden — includeDrafts: true)`
      // 回退必须**说明白**：模型要知道这几条是未验证的草稿，才不会把猜测当结论用。
      const fallbackNote = fallbackToDrafts && draftHits.length > 0
        ? ` (best match is an unverified draft — ${draftHits.length} draft(s) included and marked [draft]; check before relying on them)`
        : ''
      // 采纳标记要有解释，否则 `✓3` 只是一串符号。只在真出现时印，不占常量预算。
      const hasAdoption = hits.some(hit => {
        const record = techniqueById.get(hit.id)
        return record !== undefined && (record.successes > 0 || record.failures > 0)
      })
      const adoptionNote = hasAdoption ? ' (✓N = N confirmed adoptions, ✗N = reported failures)' : ''
      const lines = [
        `${hits.length} technique(s) for "${query}"${includeDrafts ? ' (including drafts)' : ''}${fallbackNote}${facetNote}${draftNote}${adoptionNote}:`,
        ...detailed.map((hit, index) => render(hit, index, true)),
      ]
      if (tail.length > 0) {
        lines.push(
          'also matching (expand by id with technique_get):',
          ...tail.map((hit, index) => render(hit, DETAILED_HITS + index, false)),
        )
      }
      return lines.join('\n')
    },
    async get(ids) {
      await refresh(current?.cwd)
      const records = [...techniqueById.values()]
      const blocks: string[] = []
      const resolvedIds: string[] = []
      for (const needle of ids) {
        const resolved = resolveTechniqueId(needle, records)
        if (resolved.ok) resolvedIds.push(resolved.record.id)
        blocks.push(resolved.ok
          ? formatTechniqueDetail(resolved.record)
          : `No technique resolved for "${needle}": ${resolved.reason}.`)
      }
      await noteTechniqueRetrieval(resolvedIds)
      // U4：回报入口贴到**使用现场**。此前这句只在注入块里，而模型读完正文正是最可能真正采用、
      // 也最容易顺手回报的时刻 —— 回执里没有入口，采用率就靠模型自己想起来。
      const body = blocks.join('\n\n---\n\n')
      if (resolvedIds.length === 0) return body
      return `${body}\n\nIf you actually apply one of these, report it with `
        + '`technique_apply(id, outcome, evidence)` — anything you do not report counts as NOT adopted.'
    },
    async save(input) {
      const scope = settings.scopeTechnique
      const cwd = scope === 'project' ? projectCwd() : undefined
      // DEF-32：按 id 就地更新。此前只能新建（合并键是 name+when+domain），于是「改一句措辞」
      // 要么精确重贴三键、要么 forget 再 save —— 后者会把计数与验收记录一起丢掉。
      if (input.id !== undefined) {
        await refresh(current?.cwd)
        const resolved = resolveTechniqueId(input.id, [...techniqueById.values()])
        if (!resolved.ok) {
          return `No technique resolved for "${input.id}": ${resolved.reason}. Nothing was saved.`
        }
        const record = resolved.record
        const draft = manualDraft(input, record)
        if (draft.name.length === 0 || draft.when.length === 0) {
          return 'Refused: name and when must not be empty. Nothing was saved.'
        }
        if (!storable(draft, record.scope)) {
          return 'Refused: this technique is confidential and global storage is disabled (allowConfidentialGlobal).'
        }
        const updated = applyTechniqueContent(record, draft, Date.now())
        const written = await store.updateTechniques(
          [updated],
          record.scope === 'project' ? projectCwd() : undefined,
        )
        await refresh(current?.cwd)
        if (written === 0) return `Could not update technique "${input.id}".`
        const fields = UPDATABLE_TECHNIQUE_FIELDS.filter(field => input[field] !== undefined)
        return `Updated technique [id ${record.id}, status ${record.status}]: "${updated.name}" (fields: ${fields.join(', ')})`
      }
      const draft = manualDraft(input)
      if (!storable(draft, scope)) {
        return 'Refused: this technique is confidential and global storage is disabled (allowConfidentialGlobal).'
      }
      const stored = await store.upsertTechniques([draft], {
        scope,
        ...(cwd === undefined ? {} : { cwd }),
        partition: settings.partition,
        sessionId: current?.sessionId ?? 'manual',
        provenance: 'human',
      })
      await refresh(cwd)
      const saved = stored.records.find(record => record.name === draft.name && record.when === draft.when)
      return `Saved technique (scope ${scope})${saved === undefined ? '' : ` [id ${saved.id}, status ${saved.status}]`}: "${draft.name}"`
    },
    /**
     * 单条采用回报的公共实现：解析 → 校验证据 → 组装新记录。
     *
     * 返回记录而不是直接落盘，是为让批量路径能把多条合并成**一次**读-改-写。
     *
     * @param id - 技巧 id 或唯一前缀。
     * @param outcome - 采用结果。
     * @param evidence - 可证伪的验收证据。
     * @returns 命中时的新记录，或一句可直接回给模型的拒绝说明。
     */
    async apply(id, outcome, evidence) {
      if (current !== undefined) consultedSessions.add(current.sessionId)
      const prepared = await prepareAdoption(id, outcome, evidence)
      if (typeof prepared === 'string') return prepared
      const ok = await store.updateTechniques([prepared.record], prepared.record.scope === 'project' ? projectCwd() : undefined)
      await refresh(current?.cwd)
      if (ok === 0) return `Could not update technique "${id}".`
      return adoptionLine(prepared, true)
    },
    async applyBatch(updates) {
      if (updates.length === 0) return 'Nothing to record: updates[] is empty.'
      const prepared: PreparedAdoption[] = []
      const lines: string[] = []
      for (const [index, update] of updates.entries()) {
        const label = `#${index + 1} "${update.id}"`
        const result = await prepareAdoption(update.id, update.outcome, update.evidence)
        if (typeof result === 'string') {
          lines.push(`${label}: ${result.split('\n')[0]}`)
          continue
        }
        prepared.push(result)
        lines.push(`${label}: ${adoptionLine(result, false)}`)
      }
      if (prepared.length > 0) {
        const written = await store.updateTechniques(prepared.map(item => item.record), current?.cwd === undefined ? undefined : projectCwd())
        await refresh(current?.cwd)
        lines.push(`Recorded ${written}/${updates.length} in a single write.`)
      }
      return lines.join('\n')
    },
    async exportSkill(id) {
      await refresh(current?.cwd)
      const record = techniqueById.get(id)
      if (record === undefined) return `No technique with id "${id}".`
      if (!injectable(record)) {
        return `Refused: "${record.name}" is ${record.status}. Only verified techniques (validated or canonical) can be exported as a skill.`
      }
      if (record.sensitivity === 'confidential') {
        return 'Refused: confidential knowledge must not be exported — a shared skill cannot be un-shared.'
      }
      if (!record.deidentified) {
        return 'Refused: this technique has not passed the de-identification check.'
      }

      const rendered = renderSkill(record, settings.skillAllowedTools.length === 0
        ? {}
        : { allowedTools: settings.skillAllowedTools })
      const check = verifySkill(rendered.markdown)
      if (!check.ok) {
        return `Refused: generated SKILL.md is invalid (${check.problems.join('; ')}).`
      }

      const directory = join(settings.skillExportDir, rendered.name)
      const file = join(directory, 'SKILL.md')
      await mkdir(directory, { recursive: true })
      await writeFile(file, rendered.markdown, 'utf8')
      return [
        `Exported "${record.name}" as skill "${rendered.name}".`,
        `Path: ${file}`,
        'Load it with the skills mechanism of this harness (or `add_skill` when OpenViking is available).',
      ].join('\n')
    },
    async learn(path, useModel) {
      if (current !== undefined) consultedSessions.add(current.sessionId)
      const root = path === undefined || path.trim().length === 0 ? projectCwd() : resolve(path.trim())
      const route = mineRoute()
      const model = route === undefined ? '' : route.model
      const cache = await store.readJsonFile<MineCache>(MINE_CACHE_FILE, emptyMineCache())
      const callable = useModel && settings.mineUseModel && route !== undefined ? modelCaller(route) : undefined
      const outcome = await mineRepository({
        view: createRepoView(root),
        stack: current?.stack ?? { languages: [] },
        cache,
        options: {
          maxFiles: settings.mineMaxFiles,
          maxBytes: settings.mineMaxBytes,
          minOccurrences: settings.mineMinOccurrences,
          maxModelCalls: settings.mineMaxModelCalls,
          exampleMaxLines: settings.exampleMaxLines,
          exampleMaxChars: settings.exampleMaxChars,
          timeoutMs: settings.mineTimeoutMs,
          storeStructuralCards: settings.mineStoreStructuralCards,
          ...(settings.mineInclude.length === 0 ? {} : { include: settings.mineInclude }),
          ...(settings.mineExclude.length === 0 ? {} : { exclude: settings.mineExclude }),
        },
        knownDomains: knownDomainsForMining(),
        ...(callable === undefined ? {} : { call: callable }),
        model,
      })

      await store.writeJsonFile(MINE_CACHE_FILE, withCacheEntries(cache, outcome.processed, model))
      const scope = settings.scopeTechnique
      const cwd = scope === 'project' ? projectCwd() : undefined
      const storable = outcome.candidates.filter(candidate => storableDraft(candidate.draft, scope))
      // 来源按**候选**打标，而不是「这一轮跑过模型就算 model」—— 否则规则路径产出的结构卡
      // 会被标成模型知识（实测 116 张普查卡全部如此），来源标记本身就失真了。
      // U1c：记住落盘前已有的 id，落盘后就能说出**这一轮新建了哪几条**（带回执的 id，
      // 模型当场就能 technique_get / technique_apply —— 知识刚从手上的代码里提出，
      // 此刻可用性先验最高；只说「N new」等于把刚学到的东西锁进抽屉）。
      const knownBefore = new Set(techniqueById.keys())
      let created = 0
      let merged = 0
      for (const origin of ['model', 'rule'] as const) {
        const group = storable.filter(candidate => candidate.origin === origin)
        if (group.length === 0) continue
        const written = await store.upsertTechniques(group.map(candidate => candidate.draft), {
          scope,
          ...(cwd === undefined ? {} : { cwd }),
          partition: settings.partition,
          sessionId: current?.sessionId ?? 'mine',
          provenance: origin,
        })
        created += written.created
        merged += written.merged
      }
      await refresh(cwd)

      const { stats } = outcome
      const freshDrafts = [...techniqueById.values()]
        .filter(record => !knownBefore.has(record.id))
        .slice(0, 3)
      const freshLines = freshDrafts.length === 0
        ? []
        : [
          '- new drafts you can use right now (id — name):',
          ...freshDrafts.map(record => `  ${record.id.slice(0, 11)} — ${record.name.slice(0, 70)}`),
          '  expand with technique_get; if you apply one, report it via technique_apply(id, outcome, evidence)',
        ]
      // 结构观察进**报告**而不是进库：它是「这个仓库长什么样」，不是可复用的知识。
      const topObservations = [...outcome.observations]
        .sort((left, right) => right.occurrences - left.occurrences)
        .slice(0, 5)
        .map(item => `  ${item.symbol} ×${item.occurrences}（${item.files} 文件${item.roles.length === 0 ? '' : `，${item.roles.join('/')}`}）`)
      return [
        `Mined ${root} in ${stats.durationMs}ms:`,
        `- files: ${stats.scanned} scanned (${stats.skippedCached} cached, ${stats.skippedLarge} oversized), ${stats.visited} visited`,
        `- clusters: ${stats.clusters}, model calls: ${stats.modelCalls}${stats.timedOut ? ' (timed out, partial result kept)' : ''}`,
        `- candidates: ${outcome.candidates.length} passed, ${outcome.rejected.length} rejected by leak check`,
        `- stored as drafts: ${created} new, ${merged} merged`,
        ...freshLines,
        ...(outcome.observations.length === 0 || settings.mineStoreStructuralCards
          ? []
          : [
            `- structural observations (reported only, NOT stored — call-site census is not reusable knowledge):`,
            ...topObservations,
            `  set mineStoreStructuralCards=true to store these as cards anyway`,
          ]),
        ...outcome.rejected.slice(0, 5).map(item => `  rejected: ${item.name} — ${item.reason}`),
      ].join('\n')
    },
    async forget(id, _wipeAll) {
      return forgetTechniqueById(id)
    },
  })

  // ---- 瞬时层：捕获会话事件 -------------------------------------------------

  ctx.on('session/created', (session: Session) => {
    ensureLive(session)
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const state = ensureLive(session)
    // ① 的反例面（评审明确要求处理的那条）：宿主 compaction 之后，本会话「已经完整给过」的记账
    // 必须整份作废 —— 被裁掉的全文再也不会出现在上下文里，继续发指针就是让模型去找一段不存在的
    // 文本。`standingFullShown` 同理作废：常驻规则的全文也可能已经被裁掉，否则它会在接下来的
    // N 轮里只收到紧凑形态。
    if (event.type.startsWith('compaction/')) {
      repeatSent.delete(state.sessionId)
      standingFullShown.delete(state.sessionId)
      return
    }
    switch (event.type) {
      case 'turn/start':
        turnOf(state, event.data.turn)
        break
      case 'user/message': {
        // dsh 把运行时快照、本插件的召回块、失败预警也作为 user/message 事件发出。
        // 它们是框架输出，不是用户说的话，必须整条丢弃：旧实现把它们当用户输入、
        // 又按「保留尾部」截断，于是真正的请求被挤出 captureUserChars 窗口，
        // 提炼出的「请求」变成上一轮的召回流水，并随「召回 → 再捕获」逐会话放大。
        if (isInjectedUserMessage(event.data)) break
        const text = messageText(event.data)
        const turn = turnOf(state, state.turns.at(-1)?.turn ?? 0)
        turn.user = clipHeadTail(`${turn.user}${text}\n`, settings.captureUserChars)
        // 纠偏判定是**两段式**的：这里只做本地初筛（零成本、宁可误收），把命中的原文
        // 记成候选；「这到底是不是纠偏、正确做法是什么」交给模型在反思时定夺
        // （见 `persist` 的 `correctionsMode`）。之所以不在这里直接落一条失败记录：
        // 关键词撞车太容易 —— 一句平常的 "review again" 就曾在全局失败层留下垃圾记录。
        if (settings.failures && CORRECTION_MARKERS.some(marker => text.toLowerCase().includes(marker))) {
          const session = failureState(state.sessionId)
          const candidate = clipHead(text.trim().replace(/\s+/gu, ' '), 300)
          if (candidate.length > 0 && !session.correctionCandidates.includes(candidate)) {
            session.correctionCandidates = [...session.correctionCandidates, candidate].slice(-5)
          }
        }
        break
      }
      case 'assistant/message': {
        const turn = turnOf(state, event.data.turn)
        turn.assistant = clipHeadTail(`${turn.assistant}${messageText(event.data.message)}\n`, settings.captureAssistantChars)
        break
      }
      case 'tool/call': {
        const turn = turnOf(state, event.data.turn)
        if (!turn.tools.includes(event.data.name)) turn.tools.push(event.data.name)
        // 记下 callId → 工具名：`tool/result` 不带工具名，只靠它关联。
        if (settings.failures) {
          const session = failureState(state.sessionId)
          session.callNames.set(String(event.data.callId), event.data.name)
          session.callArgs.set(String(event.data.callId), event.data.arguments)
        }
        // 只保留工作区内的相对路径：工作区外的绝对路径属于敏感信息，不写入长期记忆。
        for (const file of keepInsideWorkspace(filesFromArguments(event.data.arguments), state.cwd)) {
          if (!turn.files.includes(file)) turn.files.push(file)
        }
        break
      }
      case 'tool/result': {
        if (!settings.failures) break
        const session = failureState(state.sessionId)
        const block = toolResultBlock(event.data.message)
        const errorName = event.data.error?.name
        const errorCode = event.data.error?.code
        const text = toolResultText(event.data.message)
        // 本插件自己的拒绝绝不能计入：否则「拒绝一次 → 计数 +1 → 更容易拒绝」会自我强化。
        // 必须连消息文本一起匹配 —— 管道拒绝只带 message，不带 error.name/code。
        if (isSelfDenial(errorCode, errorName, text)) break
        if (block?.isError !== true && errorName === undefined) break
        if (errorCode === ABORTED_BEFORE_DISPATCH) break
        const toolName = block?.toolCallId === undefined ? undefined : session.callNames.get(block.toolCallId)
        const rawArgs = block?.toolCallId === undefined ? undefined : session.callArgs.get(block.toolCallId)
        const observation = observeToolFailure(
          {
            ...(toolName === undefined ? {} : { tool: toolName }),
            ...(errorName === undefined ? {} : { errorName }),
            ...(errorCode === undefined ? {} : { errorCode }),
            message: text,
          },
          settings.fingerprintTemplateMaxChars,
        )
        if (observation !== undefined) {
          session.lastMachineKey = observation.fingerprint.key
          session.lastMachineTurn = currentTurnOf(state)
          recordFailure(state, observation, undefined, deriveGuard(toolName, parseArguments(rawArgs), settings.failureGuardTools))
        }
        break
      }
      case 'request/header': {
        const route = routeOf(event.data.header)
        if (route !== undefined) state.route = route
        break
      }
      case 'turn/end': {
        // 先结算「防住了」：预警发出后经过观察窗口仍未复现，才计入 prevented。
        if (settings.failures) settlePrevention(state, event.data.turn)
        // 每轮末先做一次规则提炼落盘：进程被强杀时也不会丢掉这次会话。
        if (settings.distillOnTurnEnd && state.turns.length > 0) {
          // 兜底摘要本身不认定纠偏；只有整个环境没有模型路由时，才让它顺手走本地降级，
          // 否则「有模型却让它按关键词认纠偏」正是这次要修掉的问题。
          track(persist(
            state,
            snapshotTranscript(state),
            undefined,
            routeFor(state) === undefined ? 'local' : 'skip',
          ).then(() => undefined))
        }
        // 摊销式反思：`session/disposed` 只在 agent 销毁时发出，而 agent 跨 prompt 复用，
        // 所以「会话内反思」在 web 这类不关会话的 profile 下原本等于死代码。
        // 这里只负责「到期就来问一次」；是否真的反思仍由同一套闸门决定。
        track(settleSession(state, { ruleFallback: false }))
        break
      }
      default:
        break
    }
  })

  ctx.on('session/disposed', (session: Session) => {
    const id = String(session.id)
    const state = live.get(id)
    live.delete(id)
    if (state === undefined) {
      failuresBySession.delete(id)
      return
    }
    if (current === state) current = undefined
    // 失败观测状态必须等收尾**跑完**再删：`settleSession` 的本地降级路径还要读
    // `lastMachineKey` 与纠偏候选，先删会让它新建一个空状态并直接 return（DEF-02）。
    track(
      settleSession(state)
        .then(() => flushMetrics(true))
        .catch(error => {
          logger.warn(`memory: session ${id} settle failed: ${describe(error)}`)
        })
        .finally(() => {
          failuresBySession.delete(id)
          advisorySeen.delete(id)
          advisoryLastTurn.delete(id)
          firstContactPushed.delete(id)
          standingFullShown.delete(id)
          repeatSent.delete(id)
          needleFiles.delete(id)
          retrievedBySession.delete(id)
          consultedSessions.delete(id)
          if (state.turns.length > 0) logger.debug(`memory: session ${id} distilled`)
        }),
    )
  })

  ctx.on('session/flush', async () => {
    await Promise.all([...pending])
  })

  // ---- 能力接线：system prompt 注入与工具注册（均为软依赖） -----------------
  //
  // 这两项能力必须用 `ctx.inject` **响应式**接线，不能在 apply 里一次性 `ctx.get`。
  //
  // `tools` 服务（`@deepseek-ai/dsh-tools` 的 `ToolRuntime`）自身声明
  // `inject: ['systemPrompt']`，因此它上线**晚于**本插件硬依赖的 `sessions`：
  // apply 时刻 `ctx.get('tools')` 拿到的是 undefined，而一次性探测不会重试，
  // 于是 14 个工具在真实 dsh 里全部安静地注册不上（记忆库、提炼、注入都正常，
  // 只有模型看得见的那一层消失）。单测因为预先 provide 好服务，永远复现不了这个时序。
  //
  // `ctx.inject` 挂一个子 fiber：服务就绪时执行、服务消失时随 fiber 回收。
  // 服务始终缺席时的可观测性交给框架——DSH 会把子 fiber 列为
  // `pending (waiting for service: tools)`，比过去那句会误导人的 warn 更准确。
  // 具名函数而不是箭头函数，是为了让那条 pending 诊断能报出可读的插件名。

  if (settings.injectPrompt) {
    ctx.inject(['systemPrompt'], function memoryPromptInjection(promptCtx) {
      const systemPrompt = promptCtx.get('systemPrompt') as PromptContextRegistry
      promptCtx.effect(() => systemPrompt.context({
        name: PROMPT_SECTION_NAME,
        order: settings.promptOrder,
        text: () => countInjection(() => renderInjection(current?.turns.at(-1)?.user ?? '')),
      }), 'memory-layer:prompt-injection')
      if (settings.techniques) {
        promptCtx.effect(() => systemPrompt.context({
          name: TECHNIQUE_SECTION_NAME,
          order: settings.techniquePromptOrder,
          text: () => countInjection(() => renderTechniqueInjection(current?.turns.at(-1)?.user ?? '')),
        }), 'memory-layer:technique-injection')
      }
      if (settings.failures) {
        promptCtx.effect(() => systemPrompt.context({
          name: FAILURE_SECTION_NAME,
          order: settings.failurePromptOrder,
          text: () => countInjection(() => renderFailureInjection()),
        }), 'memory-layer:failure-injection')
      }
      // 指引段排在最后：它是「该怎么做」的元指令，放在数据块之后离决策点更近。
      // 注册顺序与 `INJECTION_BLOCKS` 的顺序必须一致 —— 黑盒用例 F-07 拿这两者交叉验证。
      if (settings.guidance) {
        promptCtx.effect(() => systemPrompt.context({
          name: GUIDANCE_SECTION_NAME,
          order: settings.guidancePromptOrder,
          text: () => countInjection(() => renderGuidance()),
        }), 'memory-layer:guidance-injection')
      }
    })
  }

  if (settings.registerTools) {
    ctx.inject(['tools'], function memoryToolsRegistration(toolCtx) {
      const tools = toolCtx.get('tools') as ToolRuntime
      // 单调守卫只负责硬拦截：它同步、且无法被后续监听器翻回允许。
      if (settings.failures && typeof tools.guard === 'function') {
        toolCtx.effect(() => tools.guard(exec => {
          if (settings.failureBlockAfter <= 0) return undefined
          const record = intercept(exec.name, exec.arguments, 'block')
          return record === undefined ? undefined : failureDenialReason(record)
        }), 'memory-layer:failure-guard')
      } else if (settings.failures && settings.failureBlockAfter > 0) {
        logger.warn('memory: tools.guard is absent; hard blocking of repeated failures is disabled')
      }

      // L1：引用检测。**独立于顾问开关** —— 它是观测，不是提示：即使顾问关掉，
      // 也要能回答「推给模型的技巧到底有没有出现在它随后的动作里」。
      // 放在 post-execute（不是 pre-execute）是因为这里能确认这次调用真的发生了。
      toolCtx.effect(() => toolCtx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next()
        try {
          // 评审 F2：**失败调用整条跳过** —— 观测（`referenced`）与提示（L2）都不做。
          //
          // 宿主在 `result.isError === true` 时仍会派发本钩子，若照样记账，一次失败的
          // `edit`/`bash` 会给卡片记一次 `referenced`，并弹出「你刚用到了 X，若确实奏效就回报一下」
          // —— 后半句是在劝模型为一次没成功的调用背书，与我们「证据必须可证伪」的要求冲突；
          // 前半句则把「试过」混进「被用上」，而这个计数是要喂 L5 排序的。
          //
          // 还有一个只有跳过才躲得掉的副作用：同一会话对同一张卡**只检测一次**
          // （`referencedBySession` 的去重集合）。失败那次若已经把它标成「已检测」，
          // 随后真正成功的那次就再也拿不到回报提示了 —— 而那正是「用了但没回报」最该被补上的时刻。
          if (result.isError === true) return decision
          const referenced = await detectReferences(exec)
          // L2：刚被引用就顺手提示回报 —— 这是"用了但没回报"那个断层唯一的补救点。
          if (!settings.referenceNudge || referenced.length === 0) return decision
          return {
            ...decision,
            additionalContexts: [
              ...(decision.additionalContexts ?? []),
              advisoryMessage(referenceNudge(exec.name, referenced)),
            ],
          }
        } catch (error) {
          // 观测与提示都是增益功能，任何失败都不得影响工具调用本身。
          logger.debug(`memory: reference detection skipped (${describe(error)})`)
          return decision
        }
      }))

      // A：动作点顾问。走 `tools/post-execute` 的 `additionalContexts` —— **不阻断、不改写**
      // 工具结果（`content` 是替换语义，用它会覆盖工具回执），只给下一条请求附一段上下文。
      // 按会话去重 + 硬上限，因此成本有界；命中的是符号/领域这类强证据，不是模糊词。
      if (settings.techniqueAdvisory) {
        toolCtx.effect(() => toolCtx.on('tools/post-execute', async (exec, result, next) => {
          const decision = await next()
          try {
            if (decision.kind !== 'accept' || result.isError === true) return decision
            // 先试**动作点**命中（工具参数里的文件/调用名），没有再试**首触**（本轮请求最相关的一条）。
            // 两者共用同一份会话预算与轮节流，所以任一路都不会把成本打开。
            const note = advisoryFor(exec) ?? firstContactNote()
            if (note === undefined) return decision
            return {
              ...decision,
              additionalContexts: [
                ...(decision.additionalContexts ?? []),
                advisoryMessage(note),
              ],
            }
          } catch (error) {
            // 顾问是增益功能：任何失败都不得影响工具调用本身。
            logger.debug(`memory: advisory skipped (${describe(error)})`)
            return decision
          }
        }), 'memory-layer:technique-advisory')
      }

      const definitions = [
        ...createMemoryTools(toolDeps()),
        ...(settings.techniques ? createTechniqueTools(techniqueDeps()) : []),
        ...(settings.failures ? createFailureTools(failureDeps()) : []),
      ]
      for (const tool of definitions) {
        toolCtx.effect(() => tools.register(tool), `memory-layer:tool:${tool.name}`)
      }
    })
  }

  logger.debug(
    `memory: ready at ${settings.dir} `
    + `(episodic=${settings.scopeEpisodic}, semantic=${settings.scopeSemantic}, `
    + `technique=${settings.scopeTechnique}, failure=${settings.scopeFailure}, partition=${settings.partition})`,
  )
}

/**
 * 复制一份瞬时层快照，避免后台提炼与并发事件写入同一批对象。
 * @param state - 运行中的会话状态。
 * @returns 深拷贝到数组层的转录。
 */
function snapshotTranscript(state: LiveSession): Transcript {
  return {
    ...(state.cwd === undefined ? {} : { cwd: state.cwd }),
    ...(state.stack === undefined ? {} : { stack: state.stack }),
    turns: state.turns.map(turn => ({ ...turn, tools: [...turn.tools], files: [...turn.files] })),
  }
}

/**
 * 把配置里的 YAML 空值收敛为 `undefined`。
 *
 * YAML 里 `key:` 形式的空值经解析是 `null`，而 schemastery 对**没有 `default`** 的字段
 * 会原样透传 `null`（只有带默认值的字段才把空值换成默认值）。本插件的可选语义是
 * 「缺省 = `undefined`」，于是 `config.dir ?? 默认` 之后的 `.trim()` 会在 `null`
 * 上抛 `TypeError`，宿主加载该插件时整个 dsh 都起不来。
 *
 * 这里在进入 {@link resolveSettings} 之前一次性抹平顶层与 `layerScopes` 的 `null`，
 * 让后续代码只需处理 `undefined` 一种缺省形态。
 *
 * @param config - 宿主传入、可能含 `null` 的配置。
 * @returns 去掉空值的配置副本。
 */
function normalizeConfig(config: Config): Config {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value === null || value === undefined) continue
    out[key] = key === 'layerScopes' && typeof value === 'object'
      ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== null && item !== undefined),
      )
      : value
  }
  return out as Config
}

/**
 * 把可选配置收敛成确定值。
 * @param config - 已校验配置。
 * @returns 运行时设置。
 */
function resolveSettings(config: Config): Settings {
  // 作用域只有一个入口：`layerScopes` 逐层覆盖，缺省落到 LAYER_SCOPE_DEFAULTS。
  // （旧的全局 `scope` 已删除 —— 它能表达的 layerScopes 都能表达，留着只会让
  //   「到底哪个生效」变成需要查优先级的问题。）
  const layerScope = (
    layer: 'episodic' | 'semantic' | 'technique' | 'failure',
  ): MemoryScope => config.layerScopes?.[layer] ?? LAYER_SCOPE_DEFAULTS[layer]
  return {
    dir: resolveDir(config.dir),
    scopeEpisodic: layerScope('episodic'),
    scopeSemantic: layerScope('semantic'),
    scopeTechnique: layerScope('technique'),
    scopeFailure: layerScope('failure'),
    partition: nonEmpty(config.partition) ?? 'default',
    recallLimit: config.recallLimit ?? 5,
    recallChars: config.recallChars ?? 4000,
    recallRepeatCompact: config.recallRepeatCompact ?? true,
    injectPrompt: config.injectPrompt ?? true,
    promptOrder: config.promptOrder ?? 250,
    registerTools: config.registerTools ?? true,
    indexBackend: config.indexBackend ?? 'memory',
    captureUserChars: config.captureUserChars ?? 2000,
    captureAssistantChars: config.captureAssistantChars ?? 1200,
    maxTurnsPerSession: config.maxTurnsPerSession ?? 60,
    distillOnTurnEnd: config.distillOnTurnEnd ?? true,
    distillTimeoutMs: config.distillTimeoutMs ?? 30_000,
    provider: nonEmpty(config.provider),
    model: nonEmpty(config.model),
    encrypt: config.encrypt ?? true,
    keyFile: nonEmpty(config.keyFile),
    techniques: config.techniques ?? true,
    techniqueLimit: config.techniqueLimit ?? 3,
    techniqueChars: config.techniqueChars ?? 3000,
    techniquePromptOrder: config.techniquePromptOrder ?? 260,
    injectMinMatched: config.injectMinMatched ?? 2,
    injectStandingRules: config.injectStandingRules ?? 4,
    standingRuleFullEveryTurns: config.standingRuleFullEveryTurns ?? 10,
    injectMinScore: config.injectMinScore ?? 0,
    injectionGate: {
      minMatched: config.injectMinMatched ?? 2,
      minScore: config.injectMinScore ?? 0,
      stopwords: config.injectStopwords ?? [],
      // 注入永远不按「最近/最自信」注入：空查询没有可核对的意图。实测这正是「重启后
      // 第一轮又冒出三条 UML 技巧」的机制（那时插件还没捕获到本轮用户文本）。
      emptyQuery: 'deny',
    },
    guidancePromptOrder: config.guidancePromptOrder ?? 265,
    guidance: config.guidance ?? true,
    techniqueAdvisory: config.techniqueAdvisory ?? true,
    referenceNudge: config.referenceNudge ?? true,
    techniqueAdvisoryDrafts: config.techniqueAdvisoryDrafts ?? true,
    techniqueAdvisoryMax: config.techniqueAdvisoryMax ?? 12,
    firstContactAdvisory: config.firstContactAdvisory ?? true,
    firstContactAdvisoryMax: config.firstContactAdvisoryMax ?? 1,
    techniqueMaintenance: config.techniqueMaintenance ?? true,
    archiveAfterDays: config.archiveAfterDays ?? 14,
    archiveKeepDomains: config.archiveKeepDomains ?? ['dsh-', 'sdo'],
    maxActiveDraftsPerDomain: config.maxActiveDraftsPerDomain ?? 150,
    exampleMaxLines: config.exampleMaxLines ?? 8,
    exampleMaxChars: config.exampleMaxChars ?? 480,
    allowConfidentialGlobal: config.allowConfidentialGlobal ?? false,
    reflectOnSessionEnd: config.reflectOnSessionEnd ?? true,
    reflectMinTurns: config.reflectMinTurns ?? 3,
    reflectNoveltyThreshold: config.reflectNoveltyThreshold ?? 0.15,
    reflectBackoffAfterEmpty: config.reflectBackoffAfterEmpty ?? 5,
    reflectMaxTranscriptChars: config.reflectMaxTranscriptChars ?? 24_000,
    failures: config.failures ?? true,
    failureMaintenance: config.failureMaintenance ?? true,
    failureWarnAfter: config.failureWarnAfter ?? 2,
    failureAskAfter: config.failureAskAfter ?? 3,
    failureBlockAfter: config.failureBlockAfter ?? 0,
    failureInjectLimit: config.failureInjectLimit ?? 3,
    failureInjectChars: config.failureInjectChars ?? 1500,
    failureInjectRelevantOnly: config.failureInjectRelevantOnly ?? true,
    failureInjectPerSession: config.failureInjectPerSession ?? 5,
    failureRepeatEscalate: config.failureRepeatEscalate ?? true,
    failurePromptOrder: config.failurePromptOrder ?? 255,
    failurePreventWindowTurns: config.failurePreventWindowTurns ?? 3,
    fingerprintTemplateMaxChars: config.fingerprintTemplateMaxChars ?? 200,
    failureGuardTools: config.failureGuardTools ?? [...DEFAULT_GUARD_TOOLS],
    mineUseModel: config.mineUseModel ?? true,
    mineMaxFiles: config.mineMaxFiles ?? 200,
    mineMaxBytes: config.mineMaxBytes ?? 524_288,
    mineMaxModelCalls: config.mineMaxModelCalls ?? 8,
    mineMinOccurrences: config.mineMinOccurrences ?? 2,
    mineTimeoutMs: config.mineTimeoutMs ?? 120_000,
    mineInclude: config.mineInclude ?? [],
    mineExclude: config.mineExclude ?? [],
    mineStoreStructuralCards: config.mineStoreStructuralCards ?? false,
    skillExportDir: resolveSkillDir(config.skillExportDir),
    skillAllowedTools: config.skillAllowedTools ?? [],
  }
}

/**
 * 解析记忆库根目录：显式配置 > `$DSH_HOME` > `~/.dsh`，再拼上 {@link MEMORY_DIR_NAME}。
 * @param configured - 配置里的目录，可为相对路径；YAML 空值 `null` 视同未设置。
 * @returns 绝对路径。
 */
export function resolveDir(configured: string | null | undefined): string {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return isAbsolute(configured) ? configured : resolve(configured)
  }
  const home = process.env[DSH_HOME_ENV]
  const base = home !== undefined && home.trim().length > 0
    ? resolve(expandHome(home))
    : join(homedir(), '.dsh')
  return join(base, MEMORY_DIR_NAME)
}

/**
 * 解析 skill 导出目录：显式配置 > `$DSH_HOME/skills` > `~/.dsh/skills`。
 * @param configured - 配置里的目录，可为相对路径。
 * @returns 绝对路径。
 */
export function resolveSkillDir(configured: string | null | undefined): string {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return isAbsolute(configured) ? configured : resolve(configured)
  }
  const home = process.env[DSH_HOME_ENV]
  const base = home !== undefined && home.trim().length > 0
    ? resolve(expandHome(home))
    : join(homedir(), '.dsh')
  return join(base, 'skills')
}

/**
 * 解析加密密钥并构造存储编解码器。
 *
 * 密钥优先级（见 `crypto.ts`）：环境变量 `DSH_MEMORY_LAYER_KEY` > 密钥文件 > 新建密钥文件。
 * 密钥默认落在**记忆库目录内**（`<dir>/.dsh-memory-layer.key`，权限 0600），使记忆库自包含、
 * 备份后可恢复；需要与密文真正隔离时，改用环境变量或把 `keyFile` 指向库外路径。
 *
 * @param settings - 运行时设置。
 * @param logger - 诊断日志。
 * @returns 行级编解码器；`encrypt: false` 时返回 `undefined`（明文存储）。
 */
function resolveCodec(settings: Settings, logger: LoggerLike): StoreCodec | undefined {
  if (!settings.encrypt) return undefined
  const file = settings.keyFile ?? join(settings.dir, KEY_FILE_NAME)
  const key = resolveKey(file)
  const source = process.env[KEY_ENV] === undefined ? `key file ${file}` : `environment ${KEY_ENV}`
  logger.debug(`memory: encrypted store enabled (${source})`)
  return createCodec(key)
}

/**
 * 展开 `~` 与 `~/` 前缀。
 * @param path - 可能带 tilde 前缀的路径。
 * @returns 展开后的路径。
 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 仅保留非空字符串。
 * @param value - 原始配置值。
 * @returns 去掉首尾空白后仍非空的字符串，否则 `undefined`。
 */
function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * 取出会话的工作目录。
 * @param session - 会话对象。
 * @returns 绝对工作目录，缺失时 `undefined`。
 */
function cwdOf(session: Session): string | undefined {
  const header = (session as { header?: { cwd?: unknown } }).header
  return typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
}

/**
 * 从 `request/header` 事件里读出一条可用的模型路由。
 * @param header - 事件载荷（结构防御式读取，避免绑死内部字段）。
 * @returns 可用的 provider/model 组合，缺失时 `undefined`。
 */
function routeOf(header: unknown): ModelRoute | undefined {
  const config = (header as { config?: { provider?: unknown; model?: unknown } } | undefined)?.config
  const provider = config?.provider
  const model = config?.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * 把一条消息的内容块压成纯文本。
 * @param message - 任意带 `content` 的消息（用户或助手消息）。
 * @returns 拼接后的文本，非文本块被忽略。
 */
function messageText(message: { content?: unknown }): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

/**
 * 判断一条 `user/message` 是宿主注入的上下文块，还是用户自己说的话。
 *
 * 主判据是**结构性**的：用户输入由前端以 `source.kind === 'user'` 发出，而运行时快照 /
 * 召回块 / 失败预警由宿主以 `source.kind === 'plugin'`（0.1 线）或 `'plugin:<名>'`（0.2 线）
 * 注入。按结构判定不依赖宿主的具体措辞，宿主改写或本地化那句提示也不会让过滤失效。
 *
 * 结构信息缺失（或换了一个宿主实现）时退回按块首标记判定；两条都判不出时**保留**这条
 * 消息 —— 宁可多记一点噪声，也不能丢掉真正的用户请求。
 *
 * @param data - `user/message` 事件的数据。
 * @returns 该消息由宿主注入时为 true。
 */
export function isInjectedUserMessage(data: { source?: { kind?: unknown }; content?: unknown }): boolean {
  const kind = data.source?.kind
  // v3 写 `plugin`（另带 `plugin: <名>` 字段），v4 要求产生者自有 kind、插件写成 `plugin:<名>`。
  // 两条都要认：只认旧的会让 0.2 线上的注入块被当成用户原话记进记忆（自我放大）。
  if (kind === 'plugin' || (typeof kind === 'string' && kind.startsWith('plugin:'))) return true
  return isInjectedContext(messageText(data))
}

/**
 * 已安装 `@deepseek-ai/dsh-session` 的次版本号；探测不到时按 `1`（0.1 线）。
 *
 * 为什么必须按版本选形状：**两条线的消息来源是互斥的**。
 * - 0.1.x（会话格式 v3）：校验要求 `{ kind: 'plugin', plugin: <非空名> }`；
 * - 0.2.x（格式 v4）：`source()` 校验**直接拒绝** `kind === 'plugin'`，要求「产生者自有 kind」，
 *   插件来源统一提升为 `kind: 'plugin:<名>'`（见 `dsh-session-format-v3-to-v4` 的
 *   `producerKind` 兜底分支 `return \`plugin:${plugin}\``）。
 *
 * 写死任何一边都会在另一边报错，或者更糟 —— 在 0.2 上被格式校验拒绝而**静默丢掉注入**。
 *
 * @returns 次版本号（`0.2.0-rc.1` → `2`；主版本非 0 时返回 `99`）。
 */
function installedSessionVersion(): string {
  try {
    // 优先用 ESM 解析（`import.meta.resolve`）：它**走加载器钩子**，因此在换了包来源的
    // 测试环境里也能探到真正被加载的那一份；`createRequire` 是 CJS 解析、不经过钩子，
    // 只能在真实安装里用（作为兜底）。
    let resolved: string
    try {
      resolved = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-session'))
    } catch {
      resolved = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-session')
    }
    let dir = dirname(resolved)
    for (let depth = 0; depth < 6; depth += 1) {
      const file = join(dir, 'package.json')
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string }
        if (parsed.name === '@deepseek-ai/dsh-session') return String(parsed.version ?? '')
        
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // 探测失败返回空串，由 `sessionFormatMinor` 按 0.1 线处理。
  }
  return ''
}

/**
 * 纯函数：把 `@deepseek-ai/dsh-session` 的版本号换算成会话格式次版本号。
 *
 * @param version - 版本字符串（探测不到时为空串）。
 * @returns 次版本号；探测不到按 `1`（0.1 线 —— 旧写法在那条线上必然可用，也是当前主流安装）。
 */
export function sessionFormatMinor(version: string): number {
  const [major = '0', minor = '1'] = version.split('.')
  if (version.length === 0) return 1
  return Number(major) === 0 ? Number(minor) : 99
}

/** 探测到的 `@deepseek-ai/dsh-session` 版本（空串=探测失败）。 */
const SESSION_VERSION = installedSessionVersion()

/** 本次运行据以选择消息来源形状的会话格式次版本号。 */
const SESSION_FORMAT_MINOR = sessionFormatMinor(SESSION_VERSION)

/**
 * 纯函数：按会话格式次版本号给出插件消息的来源形状（便于两条分支各自单测）。
 *
 * @param sessionMinor - `@deepseek-ai/dsh-session` 的次版本号。
 * @param plugin - 插件名。
 * @returns v4 起为 `{ kind: 'plugin:<名>' }`，v3 为 `{ kind: 'plugin', plugin: <名> }`。
 */
export function messageSourceFor(sessionMinor: number, plugin: string): { kind: string; plugin?: string } {
  return sessionMinor >= 2 ? { kind: `plugin:${plugin}` } : { kind: 'plugin', plugin }
}

/** 本次运行该用的插件消息来源（按实际安装的 dsh 版本选定）。 */
const PLUGIN_MESSAGE_SOURCE = messageSourceFor(SESSION_FORMAT_MINOR, name)

/**
 * 把标识符切成小写词：`GTItemDataComponents` → `gt item data components`。
 *
 * 顾问要拿它和技巧正文对词，所以必须切：整串 `GTItemDataComponents` 永远不会出现在正文里，
 * 但 `components` / `data` 会。切完再由 `ADVISORY_NOISE` 剔掉泛化词（`java`/`src`/`data`…）。
 *
 * @param text - 原始文本（文件名或标识符）。
 * @returns 小写词列表（长度 ≥4 的词，或任意中文词）。
 */
function camelWords(text: string): string[] {
  return text
    // 先切「连续大写 + 首字母大写的词」：`GTEnchantment` → `GT Enchantment`。
    // 缺这刀时整个标识符会粘成一个词元（`gtenchantment`），正文里的 `enchantment` 永远命不中，
    // 于是只能靠路径里的目录名去命中 —— 这正是一条错误证据的来源（见 0.2.8 的输入侧清洗）。
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9\u4e00-\u9fa5]+/u)
    .map(word => word.toLowerCase())
    // 纯数字不是知识证据：`2026` 这种路径里的年份曾把一条 PlantUML 技巧推给 TS 项目。
    .filter(word => (word.length >= 4 || /[\u4e00-\u9fa5]/u.test(word)) && !/^\d+$/u.test(word))
}

/**
 * 从**散文**（`description` / `reason` / `query` 这类字段）里只取**命名实体**：中文词与
 * 标识符（含点号 / 小驼峰 / ≥2 个大写的 PascalCase / 全大写缩写）。
 *
 * 为什么不取普通英文词：实测 `description: "Make the advisory budget configurable…"` 里的
 * `configurable` / `budget` 直接推出了两条毫不相干的技巧 —— 散文里的英文小写词在双语库里
 * 太泛化，不构成「这条知识讲的就是你现在改的东西」。中文词与 `DataComponents` 这种标识符
 * 才有指向性。**句首大写的普通词也不算**：实测 `"Fresh per-turn analysis"` 里的 `Fresh`
 * 曾被当成标识符，推出了一条讲 ETag 下载的技巧。
 *
 * @param text - 散文文本。
 * @returns 小写词列表。
 */
function proseTerms(text: string): string[] {
  const out: string[] = []
  const pattern = /[\u4e00-\u9fa5]{2,}|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+|[a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*|[A-Z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*|[A-Z][A-Z0-9_]{2,}/gu
  for (const match of text.matchAll(pattern)) out.push(...camelWords(match[0]))
  return out
}

/** 代码正文：整段代码/脚本，不能当顾问证据（否则文件里每个词都算相关）。 */
const ADVISORY_BODY_KEYS: ReadonlySet<string> = new Set(['content', 'command', 'old_string', 'new_string', 'patch', 'text', 'body'])

/**
 * 路径键：只取**文件名**（见 {@link advisoryTerms} 的 basename 分支），
 * 因此不参与通用 walk —— 目录名不是知识证据。
 *
 * 实测（0.2.8）：`file_path: "docs/design/2026-09-29-…设计初稿.md"` 会被走两遍，
 * 通用 walk 那遍把目录名 `design` 变成了证据，推出两条 PlantUML 技巧。
 */
const ADVISORY_PATH_KEYS: ReadonlySet<string> = new Set(['file_path', 'filePath', 'path', 'notebook_path', 'target_file'])

/**
 * L4：**改文件**的工具把动作点顾问收紧到「符号逐字命中」。
 *
 * 依据是实测：动作点顾问原先按"证据词交集"选卡，命中的常是 `design` / `progress` 这类泛化词，
 * 推来的卡与模型正在写的东西无关（窗口内 18 行里 11 行如此）。而 `edit` / `write` 的参数里
 * **带着它真正要写的标识符** —— 用它当判据既精确又几乎免费。其它工具保持原有规则：读文件、
 * 跑命令的参数并不包含"它正在实现什么"，逐字匹配在那里只会把顾问关掉。
 */
const ADVISORY_PRECISE_TOOLS: ReadonlySet<string> = new Set([
  'edit', 'write', 'multi_edit', 'apply_patch', 'str_replace_editor', 'notebook_edit',
])

/**
 * L2：引用之后的**回报提示**文案。
 *
 * 与顾问同一条通道（`additionalContexts`），但用途不同：顾问是"你可能需要这条知识"，
 * 这条是"你刚用了一条知识，顺手记一下"。依据是实测 —— 显式回报为 0，而引用检测能在同一批
 * 会话里抓到 3/7 被碰过的卡，说明"用了但没回报"是真实存在的断层，缺的正是这一步提醒。
 *
 * @param tool - 触发引用的工具名。
 * @param hits - 本次新检测到的引用（id 与命中的针）。
 * @returns 一行提示文本。
 */
export function referenceNudge(tool: string, hits: readonly { id: string; needle: string }[]): string {
  const list = hits.map(hit => `${hit.id.slice(0, 11)}（${hit.needle}）`).join('、')
  return `· 你刚用到了 ${list} —— 它的符号出现在这次 ${tool} 里。`
    + "若确实奏效，用 technique_apply(id, 'success', '<一句话验收：带数字或路径>') 记一下："
    + '不回报的采用不计入，这条卡也就不会因为「真有用」而在以后排得更前。'
}

/**
 * 汇总一次工具调用的**顾问证据词**。
 *
 * 规则（0.2.8 起收紧，动机见 {@link ADVISORY_PATH_KEYS}）：
 *   1. **文件名**走 `camelWords`（含驼峰与连续大写的切分），只取 basename；
 *   2. **路径键**不再参与通用 walk —— 目录名（`design`）不是「你正在动的东西」；
 *   3. 其余字符串值一律按**命名实体**取词（`proseTerms`）：枚举/状态值（`status: "in_progress"`
 *      里的 `in`/`progress`）与散文里的小写英文词都太泛化，不构成证据；
 *   4. 代码正文（`command`/`old_string`/`content`…）整段跳过。
 *
 * @param raw - 工具参数的原始 JSON。
 * @returns 小写证据词列表。
 */
function advisoryTerms(raw: string): string[] {
  const terms = new Set<string>(camelWords(
    filesFromArguments(raw).map(path => path.split(/[\\/]/u).at(-1) ?? path).join(' '),
  ))
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [...terms]
  }
  const walk = (value: unknown, key: string | undefined): void => {
    if (typeof value === 'string') {
      if (key === undefined || ADVISORY_BODY_KEYS.has(key) || ADVISORY_PATH_KEYS.has(key)) return
      for (const word of proseTerms(value)) terms.add(word)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey)
    }
  }
  walk(parsed, undefined)
  return [...terms]
}

/**
 * 从工具调用参数里抽取可能被触及的文件路径。
 * @param raw - 模型给出的原始 JSON 字符串。
 * @returns 命中的路径列表。
 */
function filesFromArguments(raw: string): string[] {
  if (raw.trim().length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
  const paths: string[] = []
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path', 'target_file']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0 && value.length <= 300) paths.push(value)
  }
  return paths
}

/**
 * 只保留工作区内的相对文件路径。
 *
 * 工作区外的绝对路径（如 `/home/victim/.ssh/id_rsa`）属于本机敏感信息，
 * 不该进入长期记忆、更不该随记忆注入模型上下文。
 *
 * @param files - 原始路径列表。
 * @param cwd - 当前会话工作目录。
 * @returns 归一化后的相对路径列表（去重、保持顺序）。
 */
function keepInsideWorkspace(files: readonly string[], cwd: string | undefined): string[] {
  const out: string[] = []
  for (const file of files) {
    const trimmed = file.trim()
    if (trimmed.length === 0 || trimmed.length > 300) continue
    let candidate: string
    if (isAbsolute(trimmed)) {
      if (cwd === undefined) continue
      candidate = relative(cwd, trimmed)
    } else {
      candidate = trimmed
    }
    if (candidate.length === 0 || isAbsolute(candidate) || candidate.startsWith('..')) continue
    const normalized = candidate.replace(/^\.\//u, '')
    if (normalized.length === 0 || out.includes(normalized)) continue
    out.push(normalized)
  }
  return out
}

/**
 * 渲染一条召回结果（含 id，便于随后 `memory_forget`）。
 * @param row - 召回结果。
 * @returns 多行文本。
 */
function formatHit(row: RecalledMemory): string {
  const kind = recallLabel(row.layer, row.meta?.kind, {
    ...(row.meta?.superseded === undefined ? {} : { superseded: row.meta.superseded }),
    ...(row.meta?.status === undefined ? {} : { status: row.meta.status }),
  })
  return `${row.id} (${kind}, score ${row.score.toFixed(2)}, ${new Date(row.ts).toISOString()})\n  ${sanitizeForPrompt(row.text)}`
}

/**
 * 渲染一条技巧的完整正文。
 *
 * 用 {@link sanitizeForText} 而非 `sanitizeForPrompt`：后者会压平换行，
 * 而这里需要保留示例代码与分节排版。
 *
 * @param record - 技巧记录。
 * @returns 多行文本。
 */
function formatTechniqueDetail(record: TechniqueRecord): string {
  const lines = [
    `${record.name} [${record.id}]`,
    `Kind: ${record.kind} | Status: ${record.status} | Confidence: ${confidenceOf(record).toFixed(2)}`,
    `When: ${record.when}`,
    `Gist: ${gistOf(record)}`,
    `Summary: ${record.summary}`,
  ]
  const stack = stackSummary(record.stack)
  if (stack.length > 0) lines.push(`Stack: ${stack}`)
  if (record.domain !== undefined) lines.push(`Domain: ${record.domain}`)
  // 逻辑卡的结构化锚点：模型要能据此回查代码、判断可否复用。
  if (record.subject !== undefined) lines.push(`Subject: ${record.subject}`)
  if (record.location !== undefined) lines.push(`Location: ${record.location}`)
  if (record.appliesTo !== undefined) lines.push(`Applies to: ${record.appliesTo}`)
  if (record.reuse !== undefined) lines.push(`Reuse: ${record.reuse}`)
  if (record.api !== undefined && record.api.length > 0) {
    lines.push('API:', ...record.api.map(surface => [
      '  - ',
      surface.symbol,
      surface.signature === undefined ? '' : `: ${surface.signature}`,
      surface.notes === undefined ? '' : ` — ${surface.notes}`,
    ].join('')))
  }
  if (record.invariants !== undefined && record.invariants.length > 0) {
    lines.push('Invariants:', ...record.invariants.map(item => `  - ${item}`))
  }
  if (record.steps !== undefined && record.steps.length > 0) {
    lines.push('Steps:', ...record.steps.map((step, index) => `  ${index + 1}. ${step}`))
  }
  if (record.example !== undefined) {
    lines.push(
      `Example (${record.example.language}, ${record.example.kind}) — illustrative only, never execute:`,
      '```',
      record.example.code,
      '```',
    )
  }
  if (record.pitfalls.length > 0) lines.push('Pitfalls:', ...record.pitfalls.map(item => `  - ${item}`))
  if (record.verify.length > 0) lines.push('Verify:', ...record.verify.map(item => `  - ${item}`))
  if (record.tags.length > 0) lines.push(`Tags: ${record.tags.join(', ')}`)
  if (record.conflictsWith !== undefined && record.conflictsWith.length > 0) {
    lines.push(`Same trigger, different approach: ${record.conflictsWith.join(', ')}`)
  }
  if (record.evidence.length > 0) {
    lines.push(`Evidence: ${record.evidence.map(item => [item.kind, item.repo, item.role, item.hint].filter(Boolean).join('/')).join(', ')}`)
  }
  for (const verification of record.verifications ?? []) {
    // 自证的验收要**在正文里就能看出来**：否则读卡的人会把「作者自己报的成功」当成独立验收。
    lines.push(`Verification (${verification.outcome}${verification.selfReported === true ? ', self-reported by the authoring session, not counted toward validation' : ''}, ${new Date(verification.at).toISOString()}): ${verification.evidence}`)
  }
  return sanitizeForText(lines.join('\n'))
}

/** 保序按 id 去重。 */
function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/** 把会话要点压成一段用于新颖度比较的文本。 */
function transcriptText(transcript: Transcript): string {
  return transcript.turns
    .map(turn => [turn.user, turn.assistant, turn.files.join(' '), turn.tools.join(' ')].join('\n'))
    .join('\n')
}

/**
 * 裁剪转录到字符上限：从**最旧的轮次**开始丢，保留最近发生的内容。
 * @param transcript - 会话要点。
 * @param maxChars - 字符上限。
 * @returns 裁剪后的转录。
 */
function capTranscript(transcript: Transcript, maxChars: number): Transcript {
  let total = transcriptText(transcript).length
  const turns = [...transcript.turns]
  while (turns.length > 1 && total > maxChars) {
    const removed = turns.shift()
    if (removed === undefined) break
    total -= [removed.user, removed.assistant, removed.files.join(' '), removed.tools.join(' ')].join('\n').length + 1
  }
  return { ...transcript, turns }
}

/**
 * 计算会话内容相对既有技巧的**新颖度**：新 token 占本次 token 的比例。
 *
 * 这是「没有新东西就不花钱」的判据：重复做同类任务时，词汇几乎都被既有技巧覆盖，
 * 新颖度趋近 0，反思闸门即跳过模型调用。
 *
 * @param transcript - 会话文本。
 * @param existing - 既有技巧的可检索文本。
 * @returns 0–1 的新颖度。
 */
function noveltyRatio(transcript: string, existing: readonly string[]): number {
  const tokens = new Set(tokenize(transcript))
  if (tokens.size === 0) return 0
  const known = new Set<string>()
  for (const text of existing) {
    for (const token of tokenize(text)) known.add(token)
  }
  let novel = 0
  for (const token of tokens) {
    if (!known.has(token)) novel += 1
  }
  return novel / tokens.size
}

/** 工具被中止（非业务失败）时的错误码；这类结果不该计入失败经验。 */
const ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'

/** 从一个 `tool/result` 消息里取出工具结果块的关键字段。 */
function toolResultBlock(message: unknown): { toolCallId?: string; isError?: boolean } | undefined {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; toolCallId?: unknown; isError?: unknown }
    if (record.type !== 'tool-result') continue
    return {
      ...(typeof record.toolCallId === 'string' ? { toolCallId: record.toolCallId } : {}),
      ...(record.isError === true ? { isError: true } : {}),
    }
  }
  return undefined
}

/** 把一个 `tool/result` 消息压成纯文本（兼容文本块与嵌套的工具结果块）。 */
function toolResultText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown; content?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    if (record.type === 'tool-result' && Array.isArray(record.content)) {
      for (const inner of record.content) {
        if (typeof inner !== 'object' || inner === null) continue
        const innerRecord = inner as { type?: unknown; text?: unknown }
        if (innerRecord.type === 'text' && typeof innerRecord.text === 'string') parts.push(innerRecord.text)
      }
    }
  }
  return parts.join('\n')
}

/** 解析工具参数原文；非法或缺失时返回 `undefined`。 */
function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim().length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * 本地降级路径认纠偏的轮次窗口：失败必须发生在最近这么多轮之内。
 *
 * 取 1（同轮或上一轮）：用户几乎总是**紧接着**失败给出正确做法，而窗口一放宽，
 * 跨话题的「不要再用 X 了」就会挂到几十轮前的无关失败上（DEF-04）。
 */
const CORRECTION_WINDOW_TURNS = 1

/** 用户纠偏的触发词：命中即视为高价值学习信号。 */
const CORRECTION_MARKERS = [
  '不对', '错了', '我说过', '别再', '不要用', '不要再', '不是这样',
  'wrong', 'not what i', 'i said', 'stop doing', 'again',
]

/**
 * 判断一段轮次里是否出现**用户纠偏** —— 最高价值的学习信号。
 *
 * 它比「用了工具」「碰了新文件」稀有得多，所以只有它能绕过退避与新颖度闸门：
 * 用户明确说「不是这样」时，代价再高也值得重新沉淀一次。
 *
 * @param turns - 待判定的轮次。
 * @returns 出现纠偏时为 `true`。
 */
function hasCorrectionSignal(turns: readonly LiveTurn[]): boolean {
  return turns.some(turn =>
    CORRECTION_MARKERS.some(marker => turn.user.toLowerCase().includes(marker)))
}

/**
 * 判断一段轮次里是否存在「值得沉淀」的信号。
 *
 * 纯闲聊、纯问答的会话不该触发反思 —— 这是反思成本曲线能递减的第一道保障。
 * 摊销口径下传入的是**自上次反思以来新增**的轮次，因此旧的信号不会反复开门。
 *
 * @param turns - 待判定的轮次。
 * @returns 存在学习信号时为 `true`。
 */
function hasLearningSignal(turns: readonly LiveTurn[]): boolean {
  return turns.some(turn => turn.files.length > 0 || turn.tools.length > 0)
    || hasCorrectionSignal(turns)
}

/**
 * 当前轮的结构化检索线索：**本轮**触达的文件名与工具名，加上**话题仍在延续**时前几轮的。
 *
 * 为什么要把文件/工具塞进检索：用户问「为什么这个测试挂了」时，正文里往往**没有**任何符号名，
 * 但本轮或上一轮读过 `Foo.java`、跑过 `npm test` —— 这些是比措辞更可靠的键。
 *
 * 为什么**不能**无脑带上最近 3 轮（实测）：第 1 轮画图并 `write` 了 `docs/order-service.puml`，
 * 之后 4 轮问完全无关的问题（重命名函数 / 修测试 / 加配置默认值 / 写正则），注入合计
 * **6902 字符**；而同样的 4 个问题在一个「没碰过 .puml」的会话里只要 **4823 字符**（+43%），
 * 多出来的正是 PlantUML 与 MC 技巧。原因是文件路径与工具名近乎**精确命中的强键**，
 * 一旦进入查询就主导排序，并在之后几轮持续生效 —— 话题换了，注入还停在上一轮。
 *
 * 因此按话题延续判定：本轮线索总是算（同轮没有歧义）；更早轮次的线索只在该轮**用户文本**
 * 与当前请求有共同 token 时才算。这样「跑过测试 → 为什么这个测试挂了」这类靠文件路径救回来的
 * 场景仍然成立（两轮用户文本共享「测试」），而换话题后立刻停止沿用旧键。
 *
 * @param turns - 会话轮次（按时间顺序，最后一个是当前轮）。
 * @param query - 本轮查询文本（用于抽调用名与话题判定）。
 * @returns 去重后的补充查询词。
 */
function searchExtrasFor(
  turns: readonly { user?: string; tools: readonly string[]; files: readonly string[] }[],
  query: string,
): string[] {
  const out: string[] = []
  const queryTokens = new Set(tokenize(query))
  const recent = turns.slice(-3)
  for (const [index, turn] of recent.entries()) {
    const isCurrent = index === recent.length - 1
    if (!isCurrent && !tokenize(turn.user ?? '').some(token => queryTokens.has(token))) continue
    for (const file of turn.files) out.push(file)
    for (const tool of turn.tools) out.push(tool)
  }
  for (const symbol of symbolsInText(query)) out.push(symbol)
  return [...new Set(out)]
}

/** 从文本里抽取可能的调用名（供 `symbol` 精确加权）。 */
const SYMBOL_RE = /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\b/gu

/**
 * 抽取查询文本里出现的调用名。
 * @param text - 用户输入或查询词。
 * @returns 去重后的候选调用名。
 */
function symbolsInText(text: string): string[] {
  const out = new Set<string>()
  for (const match of text.matchAll(SYMBOL_RE)) {
    const value = match[0]
    if (value.length >= 4) out.add(value)
  }
  return [...out]
}

/**
 * 保留文本头部，超出即截断。
 * @param text - 原始文本。
 * @param limit - 字符上限。
 * @returns 截断后的文本。
 */
function clipHead(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * 保留文本尾部（用于累积式捕获，总是留住最新内容）。
 * @param text - 原始文本。
 * @param limit - 字符上限。
 * @returns 截断后的文本。
 */
/**
 * 超过上限时**保留首尾、省略中段**。
 *
 * 为什么不是纯 `clipTail`：助手文本开头常是打算做什么、结尾才是结论与结果，
 * 只留一头必然丢掉另一半；用户文本同理（首轮请求的开头 + 最新的补充）。
 * 同样的字符预算下，首尾都留的信息量更高 —— 这是**等成本**的质量改进。
 *
 * @param text - 原始文本。
 * @param limit - 上限字符数。
 * @returns 不超过 `limit` 的文本。
 */
function clipHeadTail(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.max(1, Math.floor(limit * 0.6))
  const tail = Math.max(1, limit - head - 1)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/**
 * 把未知错误渲染成一行可读信息。
 * @param error - 捕获到的错误。
 * @returns 错误信息。
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
