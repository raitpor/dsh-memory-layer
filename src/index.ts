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
import { isAbsolute, join, relative, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { KEY_ENV, KEY_FILE_NAME, createCodec, resolveKey } from './crypto.js'
import type { StoreCodec } from './crypto.js'
import { MemoryStore, MAX_SUMMARY_CHARS, MINE_CACHE_FILE, emptyMetrics, techniqueText } from './store.js'
import { recall, recallTechniques, toDocs, toTechniqueDocs, tokenize } from './recall.js'
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
import { createFileView, detectStack, stackSummary } from './stack/index.js'
import {
  DETAILED_HITS,
  applyOutcome,
  checkVerificationEvidence,
  clampVerificationEvidence,
  confidenceOf,
  gistOf,
  injectable,
  resolveTechniqueId,
  techniqueIndexLine,
  techniqueSearchLine,
  techniqueTailLine,
} from './technique.js'
import {
  DEFAULT_GUARD_TOOLS,
  deriveGuard,
  enforcementFor,
  deriveTrigger,
  failureApplies,
  failureDenialReason,
  failureDetail,
  failureLessonLine,
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
import { FAILURE_BLOCK, RECALL_BLOCK, TECHNIQUE_BLOCK } from './injection.js'
import type { InjectionBlock } from './injection.js'
import { renderSkill, verifySkill } from './skill.js'
import { createFailureTools, createMemoryTools, createTechniqueTools } from './tools.js'
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
  /** 是否把召回结果注入 system prompt。 */
  injectPrompt?: boolean
  /** 注入 section 的排序值，越小越靠前。 */
  promptOrder?: number
  /** 是否注册 memory_search / memory_save / memory_forget / memory_stats 工具。 */
  registerTools?: boolean
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
 * @param layer - 记录所属层。
 * @param kind - 语义记录的类别；其余层忽略。按不可信输入对待。
 * @returns 供模型阅读的标签。
 */
export function recallLabel(
  layer: 'episodic' | 'semantic' | 'technique' | 'failure',
  kind?: unknown,
): string {
  if (layer !== 'semantic') return LAYER_LABELS[layer]
  const safe = typeof kind === 'string' && SEMANTIC_KINDS.includes(kind) ? kind : 'fact'
  return `${SEMANTIC_LABEL_PREFIX} ${safe}`
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
  'If you actually APPLIED one of these techniques, report it with the `technique_apply` tool:',
  'its id, plus outcome "success" (use "failure" if the technique turned out to be wrong).',
  'Do not report techniques you merely read, quoted or considered — anything you do not report',
  'counts as NOT adopted.',
]

/** 失败预警注入 section 名。 */
export const FAILURE_SECTION_NAME = FAILURE_BLOCK.section

/** 失败注入块头部；块首同时是 `isInjectedContext` 的识别标记。 */
export const FAILURE_INJECTION_HEADER: readonly string[] = FAILURE_BLOCK.header

/** 失败预警注入块尾部。 */
export const FAILURE_INJECTION_FOOTER = FAILURE_BLOCK.footer

/** 配置 schema：所有字段都有默认值，因此 `apply` 里拿到的配置始终完整。 */
export const Config: z<Config> = z.object({
  dir: z.string(),
  recallLimit: z.natural().min(1).max(20).default(5),
  recallChars: z.natural().min(200).max(20_000).default(4000),
  injectPrompt: z.boolean().default(true),
  promptOrder: z.number().default(250),
  registerTools: z.boolean().default(true),
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
  techniqueLimit: z.natural().min(1).max(10).default(3),
  techniqueChars: z.natural().min(200).max(20_000).default(3000),
  techniquePromptOrder: z.number().default(260),
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
  failureWarnAfter: z.natural().min(1).max(50).default(2),
  failureAskAfter: z.natural().min(1).max(50).default(3),
  // 0 表示从不硬拦截：拦截会阻断正常工作，必须显式开启。
  failureBlockAfter: z.natural().min(0).max(50).default(0),
  failureInjectLimit: z.natural().min(1).max(10).default(3),
  failureInjectChars: z.natural().min(200).max(20_000).default(1500),
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
  injectPrompt: boolean
  promptOrder: number
  registerTools: boolean
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
  exampleMaxLines: number
  exampleMaxChars: number
  allowConfidentialGlobal: boolean
  reflectOnSessionEnd: boolean
  reflectMinTurns: number
  reflectNoveltyThreshold: number
  reflectBackoffAfterEmpty: number
  reflectMaxTranscriptChars: number
  failures: boolean
  failureWarnAfter: number
  failureAskAfter: number
  failureBlockAfter: number
  failureInjectLimit: number
  failureInjectChars: number
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
    forgiven: Set<string>
    /** 本地初筛命中的纠偏候选原文，等模型在反思里定夺（见 `applyCorrections`）。 */
    correctionCandidates: string[]
  }>()
  /** 反思（会话内提炼）的累计指标，用于自适应退避与「经验复利」展示。 */
  let metrics: ReflectionMetrics = emptyMetrics()
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
  /** 「整库解不开」与「个别坏行」各自只吼一次，避免每轮刷屏。 */
  let integrityWarned = false
  let undecodableWarned = false

  const refresh = async (cwd?: string): Promise<void> => {
    const directory = resolveCwd(cwd)
    const key = bucketKey(directory)
    const [
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
    for (const record of dedupeById([...projectFail, ...globalFail])) {
      failureById.set(record.id, record)
      failureByKey.set(record.fingerprint.key, record)
    }
    const techniques = dedupeById([...projectTech, ...globalTech])
    for (const record of techniques) techniqueById.set(record.id, record)
    corpora.set(key, [
      ...toDocs([...episodic, ...globalEpisodic], [...semantic, ...globalSemantic]),
      ...toTechniqueDocs(techniques),
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
  }

  /**
   * 取某个会话目录的召回桶内容。
   * @param cwd - 会话工作目录。
   * @returns 已加载的文档；桶未加载时为空数组。
   */
  const corpusFor = (cwd?: string): RecallDoc[] => corpora.get(bucketKey(resolveCwd(cwd))) ?? []

  track(store.readMetrics().then(loaded => { metrics = loaded }))
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
          source: { kind: 'plugin', plugin: name },
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
          enforcement: occurrences => enforcementFor(occurrences, escalation),
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
    const drafts = settings.techniques
      ? memory.techniques.filter(draft => storable(draft, settings.scopeTechnique))
      : []
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
    if (metrics.backoff) return { reflect: false, reason: 'backoff after empty reflections' }
    // 比较必须「同口径」：既有技巧是**去标识化后**存储的，转录也要先过同一道占位符化，
    // 否则项目私有标识符每次都算「新词」，闸门永远关不上。
    const identifiers = identifiersFromPaths(fresh.flatMap(turn => turn.files))
    const query = abstractText(transcriptText({ ...transcript, turns: fresh }), { identifiers }).text
    const novelty = noveltyRatio(
      query,
      [...techniqueById.values()].map(record => techniqueText(record)),
    )
    if (novelty < settings.reflectNoveltyThreshold) return { reflect: false, reason: `novelty ${novelty.toFixed(2)}` }
    return { reflect: true, reason: `${fresh.length} new turn(s), novelty ${novelty.toFixed(2)}` }
  }

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
    logger.debug(
      `memory: reflected on ${state.sessionId} (${decision.reason}): +${outcome.created} new, ${outcome.merged} merged`,
    )
    // 计数器当场落盘。只在 `session/disposed` 写的话，长驻会话 —— 正是摊销反思要服务的
    // 那类 —— 重启后会把「前期投入」的账目丢掉，`memory_stats` 的复利指标永远是 0。
    await store.saveMetrics(metrics)
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
    const selfSession = current?.sessionId
    const docs = corpusFor(current?.cwd).filter(doc => {
      if (doc.layer === 'episodic' && selfSession !== undefined && doc.meta?.sessionId === selfSession) return false
      if (doc.layer !== 'technique') return true
      const record = techniqueById.get(doc.id)
      return record !== undefined && injectable(record)
    })
    if (docs.length === 0) return ''
    const hits = recall(query, docs, { limit: settings.recallLimit })
    if (hits.length === 0) return ''
    const lines = hits.map((hit, index) => {
      const kind = recallLabel(hit.layer, hit.meta?.kind)
      return `${index + 1}. (${kind}) ${sanitizeForInjection(hit.text)}`
    })
    return renderBlock(RECALL_BLOCK, [], lines, settings.recallChars)
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
   * @param query - 召回查询词（通常是当前会话最近的用户输入）。
   * @returns 注入文本；无可注入内容时为空串。
   */
  const renderTechniqueInjection = (query: string): string => {
    if (!settings.techniques) return ''
    const docs = corpusFor(current?.cwd)
    if (docs.length === 0) return ''
    const hits = recallTechniques(query, docs, {
      limit: settings.techniqueLimit,
      ...(current?.stack === undefined ? {} : { stack: current.stack }),
      partition: settings.partition,
      symbols: symbolsInText(query),
    })
    if (hits.length === 0) return ''
    const lines = hits.map((hit, index) => {
      const record = techniqueById.get(hit.id)
      const body = record === undefined ? hit.text : techniqueIndexLine(record)
      return `${index + 1}. ${sanitizeForInjection(body)}`
    })
    // 没注册工具时别提工具名：指向一个不存在的工具只会让模型白试一轮。
    const extraHeader = settings.registerTools ? TECHNIQUE_ADOPTION_NOTICE : []
    return renderBlock(TECHNIQUE_BLOCK, extraHeader, lines, settings.techniqueChars)
  }

  /** 手工写入时构造草稿：与自动提炼走同一条脱敏 + 去标识化管线。 */
  const manualDraft = (input: TechniqueSaveInput): TechniqueDraft => {
    const base: TechniqueDraft = {
      kind: input.kind,
      name: input.name.trim(),
      ...(input.gist === undefined ? {} : { gist: input.gist.trim() }),
      when: input.when.trim(),
      summary: input.summary.trim(),
      ...(input.steps === undefined ? {} : { steps: [...input.steps] }),
      ...(input.apiSymbols === undefined ? {} : { api: input.apiSymbols.map(symbol => ({ symbol })) }),
      ...(input.example === undefined
        ? {}
        : { example: { language: input.exampleLanguage ?? 'text', kind: 'usage', code: input.example } }),
      pitfalls: [...(input.pitfalls ?? [])],
      verify: [...(input.verify ?? [])],
      stack: current?.stack ?? { languages: [] },
      ...(input.domain === undefined ? {} : { domain: input.domain }),
      tags: (input.tags ?? []).map(tag => tag.toLowerCase()),
      evidence: [],
      sensitivity: 'internal',
      status: 'draft',
    }
    return abstractDraft(base, current)
  }

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

    const candidates = [...failureById.values()].filter(record =>
      shouldWarn(record, escalation)
      && !(session?.forgiven.has(record.fingerprint.key) ?? false)
      && failureApplies(record, state.stack)
      && (record.scope === 'project' || record.partition === settings.partition))

    const now = Date.now()
    const score = (record: FailureRecord): number =>
      (session?.lastSeenTurn.has(record.fingerprint.key) === true ? 1000 : 0)
      + record.occurrences * 10
      + Math.max(0, 9 - (now - record.lastSeen) / (24 * 60 * 60 * 1000))

    const ranked = candidates
      .sort((left, right) => score(right) - score(left))
      .slice(0, settings.failureInjectLimit)
    const recentFiles = state.turns.at(-1)?.files ?? []
    const warnings = ranked.map(record => {
      if (session !== undefined && !session.warned.has(record.fingerprint.key)) {
        session.warned.set(record.fingerprint.key, { turn, recordId: record.id })
      }
      // 只在本会话确实见过这个指纹时才给出现场文件：全局域记录不带项目路径。
      const files = session?.lastSeenTurn.has(record.fingerprint.key) === true ? recentFiles : []
      return sanitizeForInjection(failureWarningLine(record, files))
    })
    const lessons = renderLessons(state, settings.failureInjectLimit - warnings.length)
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
    const query = [
      ...state.turns.slice(-3).map(turn => turn.user),
      ...state.turns.slice(-3).flatMap(turn => turn.tools),
      ...state.turns.slice(-3).flatMap(turn => turn.files),
    ].join('\n')
    if (query.trim().length === 0) return []
    const contextTokens = new Set(tokenize(query))
    const sessionTools = new Set(state.turns.flatMap(turn => turn.tools))

    return [...failureById.values()]
      .filter(record =>
        record.status === 'deprecated'
        && record.remedy.length > 0
        && !(session?.forgiven.has(record.fingerprint.key) ?? false)
        && failureApplies(record, state.stack)
        && (record.scope === 'project' || record.partition === settings.partition)
        && lessonMatches(record, contextTokens, sessionTools))
      .sort((left, right) => right.lastSeen - left.lastSeen)
      .slice(0, budget)
      .map(record => sanitizeForInjection(failureLessonLine(record)))
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
      const ok = await runFailureWrite(async () =>
        store.updateFailure(updated, updated.scope === 'project' ? projectCwd() : undefined))
      await refresh(current?.cwd)
      if (!ok) return `Could not update failure "${id}".`
      const scene = cleanTrigger === undefined ? '' : ` Trigger scene: "${cleanTrigger}".`
      return `Marked resolved: "${record.symptom}"${clean.length > 0 ? ` with remedy "${clean}"` : ' (no remedy recorded)'}.${scene}`
        + ' It will stay silent unless a future session runs into the same trigger scene, where it resurfaces as a heads-up.'
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

  /** 挖掘产出的来源标记：走过模型就算 `model`，否则 `rule`。 */
  const outcomOrigin = (outcome: { stats: { modelCalls: number } }): TechniqueRecord['provenance'] =>
    outcome.stats.modelCalls > 0 ? 'model' : 'rule'

  /** 判断挖掘出的草稿是否允许写入目标作用域（confidential 默认不进全局域）。 */
  const storableDraft = (draft: TechniqueDraft, scope: MemoryScope): boolean =>
    scope === 'project' || settings.allowConfidentialGlobal || (draft.sensitivity ?? 'internal') !== 'confidential'

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

  /** 工具行为实现：与提示注入复用同一套存储与召回。 */
  const toolDeps = (): MemoryToolDeps => ({
    async search(query, limit, scope) {
      const cwd = current?.cwd
      await refresh(cwd)
      const hits = recall(query, corpusFor(cwd), { limit })
      if (hits.length === 0) return `No memory matched "${query}" (scope ${scope}).`
      return [
        `${hits.length} memory item(s) for "${query}" (scope ${scope}):`,
        ...hits.map(hit => formatHit(hit)),
      ].join('\n')
    },
    async save(text, kind) {
      const scope = settings.scopeSemantic
      const cwd = scope === 'project' ? projectCwd() : undefined
      // 工具写入与自动提炼走同一条安全管线：只脱敏不去标识化的话，
      // 项目私有标识会经工具这条旁路进入（默认全局的）语义层。
      const clean = sanitizeForStore(text.trim(), current, cwd)
      const records = await store.upsertSemantic([{ kind, text: clean }], {
        scope,
        partition: settings.partition,
        ...(cwd === undefined ? {} : { cwd }),
        sessionId: current?.sessionId ?? 'manual',
        tags: ['manual'],
      })
      await refresh(cwd)
      const stored = records.find(record => record.text === clean)
      return `Saved to long-term memory (${scope}): "${clean}"${stored === undefined ? '' : ` [id ${stored.id}]`}`
    },
    async forget(id, scope) {
      // DEF-05：`memory_search` 会返回技巧层的 `tq_` id，而本工具只遍历情景/语义层，
      // 于是「按 id 删除」对它必然答 `No memory matched` —— 契约说到的就得做到。
      if (id.startsWith('tq_')) return forgetTechniqueById(id)
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
      const techniques = docs
        .filter(doc => doc.layer === 'technique')
        .map(doc => techniqueById.get(doc.id))
        .filter((record): record is TechniqueRecord => record !== undefined)
      const verified = techniques.filter(injectable).length
      return [
        `Memory root: ${settings.dir}`,
        `Layer scopes: episodic=${settings.scopeEpisodic}, semantic=${settings.scopeSemantic}, technique=${settings.scopeTechnique}, failure=${settings.scopeFailure} (partition ${settings.partition})`,
        `Episodic summaries: ${episodic} (this project) · ${episodicTotal} (all projects)`,
        `Semantic facts: ${semantic}`,
        `Techniques: ${verified} verified, ${techniques.length - verified} draft`,
        `Recurring failures: ${[...failureById.values()].filter(record => record.status !== 'deprecated').length} active, `
          + `${[...failureById.values()].filter(record => record.status === 'deprecated').length} resolved, `
          + `${[...failureById.values()].reduce((sum, record) => sum + record.prevented, 0)} prevented`,
        ...(store.integrityBroken
          ? [`Store integrity: BROKEN — ${store.brokenFile ?? 'unknown file'} cannot be decoded; writes are refused until the key is restored`]
          : store.undecodableLines > 0
            ? [`Store integrity: ${store.undecodableLines} undecodable line(s) skipped`]
            : []),
        `Active session turns (transient): ${current?.turns.length ?? 0}`,

        `Experience compounding: reflections=${metrics.reflections}, skipped=${metrics.skipped}, new=${metrics.newTechniques}, duplicates=${metrics.duplicateTechniques}, backoff=${metrics.backoff}`,
      ].join('\n')
    },
  })

  /** 技巧工具行为实现。 */
  const techniqueDeps = (): TechniqueToolDeps => ({
    async search(query, limit, includeDrafts, verbose) {
      const cwd = current?.cwd
      await refresh(cwd)
      const hits = recallTechniques(query, corpusFor(cwd), {
        limit,
        ...(current?.stack === undefined ? {} : { stack: current.stack }),
        partition: settings.partition,
        includeDrafts,
        symbols: symbolsInText(query),
      })
      if (hits.length === 0) {
        return `No technique matched "${query}" for the current stack.`
      }
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
      const lines = [
        `${hits.length} technique(s) for "${query}"${includeDrafts ? ' (including drafts)' : ''}:`,
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
      for (const needle of ids) {
        const resolved = resolveTechniqueId(needle, records)
        blocks.push(resolved.ok
          ? formatTechniqueDetail(resolved.record)
          : `No technique resolved for "${needle}": ${resolved.reason}.`)
      }
      // 一次展开多条时用分隔线划清边界：正文之间没有围栏会让下一条的字段看起来属于上一条。
      return blocks.join('\n\n---\n\n')
    },
    async save(input) {
      const scope = settings.scopeTechnique
      const cwd = scope === 'project' ? projectCwd() : undefined
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
    async apply(id, outcome, evidence) {
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
      const stored = clampVerificationEvidence(
        sanitizeForStore(check.value, current, current?.cwd),
      )

      const updated = applyOutcome(record, {
        outcome,
        evidence: stored,
        at: Date.now(),
        ...(current?.sessionId === undefined ? {} : { sessionId: current.sessionId }),
        ...(current?.cwd === undefined ? {} : { cwd: current.cwd }),
      })
      const ok = await store.updateTechnique(updated, record.scope === 'project' ? projectCwd() : undefined)
      await refresh(current?.cwd)
      if (!ok) return `Could not update technique "${id}".`
      const kept = updated.verifications?.length ?? 0
      return [
        `Recorded ${outcome} for "${record.name}" (status ${updated.status}, confidence ${confidenceOf(updated).toFixed(2)}).`,
        `Evidence #${kept}: ${stored}`,
      ].join('\n')
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
          ...(settings.mineInclude.length === 0 ? {} : { include: settings.mineInclude }),
          ...(settings.mineExclude.length === 0 ? {} : { exclude: settings.mineExclude }),
        },
        ...(callable === undefined ? {} : { call: callable }),
        model,
      })

      await store.writeJsonFile(MINE_CACHE_FILE, withCacheEntries(cache, outcome.processed, model))
      const scope = settings.scopeTechnique
      const cwd = scope === 'project' ? projectCwd() : undefined
      const storable = outcome.candidates.filter(candidate => storableDraft(candidate.draft, scope))
      const stored = storable.length === 0
        ? { created: 0, merged: 0 }
        : await store.upsertTechniques(storable.map(candidate => candidate.draft), {
          scope,
          ...(cwd === undefined ? {} : { cwd }),
          partition: settings.partition,
          sessionId: current?.sessionId ?? 'mine',
          provenance: outcomOrigin(outcome),
        })
      await refresh(cwd)

      const { stats } = outcome
      return [
        `Mined ${root} in ${stats.durationMs}ms:`,
        `- files: ${stats.scanned} scanned (${stats.skippedCached} cached, ${stats.skippedLarge} oversized), ${stats.visited} visited`,
        `- clusters: ${stats.clusters}, model calls: ${stats.modelCalls}${stats.timedOut ? ' (timed out, partial result kept)' : ''}`,
        `- candidates: ${outcome.candidates.length} passed, ${outcome.rejected.length} rejected by leak check`,
        `- stored as drafts: ${stored.created} new, ${stored.merged} merged`,
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
        turn.user = clipTail(`${turn.user}${text}\n`, settings.captureUserChars)
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
        turn.assistant = clipTail(`${turn.assistant}${messageText(event.data.message)}\n`, settings.captureAssistantChars)
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
        .then(() => store.saveMetrics(metrics))
        .catch(error => {
          logger.warn(`memory: session ${id} settle failed: ${describe(error)}`)
        })
        .finally(() => {
          failuresBySession.delete(id)
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
        text: () => renderInjection(current?.turns.at(-1)?.user ?? ''),
      }), 'memory-layer:prompt-injection')
      if (settings.techniques) {
        promptCtx.effect(() => systemPrompt.context({
          name: TECHNIQUE_SECTION_NAME,
          order: settings.techniquePromptOrder,
          text: () => renderTechniqueInjection(current?.turns.at(-1)?.user ?? ''),
        }), 'memory-layer:technique-injection')
      }
      if (settings.failures) {
        promptCtx.effect(() => systemPrompt.context({
          name: FAILURE_SECTION_NAME,
          order: settings.failurePromptOrder,
          text: () => renderFailureInjection(),
        }), 'memory-layer:failure-injection')
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
    injectPrompt: config.injectPrompt ?? true,
    promptOrder: config.promptOrder ?? 250,
    registerTools: config.registerTools ?? true,
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
    exampleMaxLines: config.exampleMaxLines ?? 8,
    exampleMaxChars: config.exampleMaxChars ?? 480,
    allowConfidentialGlobal: config.allowConfidentialGlobal ?? false,
    reflectOnSessionEnd: config.reflectOnSessionEnd ?? true,
    reflectMinTurns: config.reflectMinTurns ?? 3,
    reflectNoveltyThreshold: config.reflectNoveltyThreshold ?? 0.15,
    reflectBackoffAfterEmpty: config.reflectBackoffAfterEmpty ?? 5,
    reflectMaxTranscriptChars: config.reflectMaxTranscriptChars ?? 24_000,
    failures: config.failures ?? true,
    failureWarnAfter: config.failureWarnAfter ?? 2,
    failureAskAfter: config.failureAskAfter ?? 3,
    failureBlockAfter: config.failureBlockAfter ?? 0,
    failureInjectLimit: config.failureInjectLimit ?? 3,
    failureInjectChars: config.failureInjectChars ?? 1500,
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
 * 召回块 / 失败预警由 `@deepseek-ai/dsh-system-prompt` 以 `source.kind === 'plugin'`
 * 注入。按结构判定不依赖宿主的具体措辞，宿主改写或本地化那句提示也不会让过滤失效。
 *
 * 结构信息缺失（或换了一个宿主实现）时退回按块首标记判定；两条都判不出时**保留**这条
 * 消息 —— 宁可多记一点噪声，也不能丢掉真正的用户请求。
 *
 * @param data - `user/message` 事件的数据。
 * @returns 该消息由宿主注入时为 true。
 */
function isInjectedUserMessage(data: { source?: { kind?: unknown }; content?: unknown }): boolean {
  if (data.source?.kind === 'plugin') return true
  return isInjectedContext(messageText(data))
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
  const kind = recallLabel(row.layer, row.meta?.kind)
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
    lines.push(`Verification (${verification.outcome}, ${new Date(verification.at).toISOString()}): ${verification.evidence}`)
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
function clipTail(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit + 1)}`
}

/**
 * 把未知错误渲染成一行可读信息。
 * @param error - 捕获到的错误。
 * @returns 错误信息。
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
