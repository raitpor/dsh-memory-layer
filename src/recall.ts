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
  /**
   * 判定相关性用哪段文本的 token（缺省 = 被检索的那段 query）。
   *
   * 为什么需要它：注入路径会把一句话拆成多个 facet 子查询去排序，而子查询里还混着
   * **当轮文件路径与工具名**（见 `searchExtrasFor`）。若拿子查询判定相关性，等于让
   * `architecture.puml` 里的 `puml` 替用户表达意图 —— 实测一个路径片段就能放行整套
   * PlantUML 技巧。因此排序用子查询，**判定只认用户原话**。
   */
  gateTerms?: readonly string[]
  /** 判定时忽略的通用词表（缺省用 GATE_STOPWORDS）。 */
  stopwords?: ReadonlySet<string>
}

/**
 * 这条记忆是不是**常驻规则**（长期偏好 / 约束）。
 *
 * 偏好与约束描述的是「用户/项目一贯要怎样」，它们对**任何**任务都成立，因此相关性判据
 * 在这里没有意义：一条「不要自动提交」的约束不会因为本轮聊的是正则表达式就失效。
 * `fact` / `decision` 不同 —— 它们是关于某件事的陈述，只在相关时才值得占用上下文。
 */
export function isStandingRule(doc: RecallDoc): boolean {
  if (doc.layer !== 'semantic') return false
  const kind = doc.meta?.kind
  return kind === 'preference' || kind === 'constraint'
}

/**
 * 门槛用的**通用词表**：命中这些词不构成「相关」的证据。
 *
 * 为什么必须有它：BM25 只要共享一个 token 就给分，而门槛数的是「命中几个 token」——
 * 于是「输出文档应是中文文档」靠 `输出`+`中文` 就能把「PlantUML CJK 渲染」技巧拉进上下文；
 * 「…发现仍有 uml 技巧注入…」靠 `发现`+`技巧` 就能把三条 UML 技巧拉进来（均为真库实测）。
 *
 * 三条纪律：
 * 1. **只作用于门槛，不进分词器**。若把它们从索引里删掉，纯通用词查询会退化成「最近记忆」
 *    语义（空查询回退），反而注入更多。
 * 2. **不放本领域词**。曾把「插件/模组/注入」列进来，那会把这个库自己的领域压制掉 ——
 *    「移植模组」恰恰是 MC 技巧的正确触发词；领域词该走 RelevanceGate 的一般判据。
 * 3. 表是语言/领域相关的，可用 `injectStopwords` 追加；加一个词等于放弃靠它触发注入。
 */
export const GATE_STOPWORDS: readonly string[] = [
  // 对话与流程套话
  '继续', '开始', '可以', '一下', '参考', '发现', '给出', '名字', '什么', '怎么', '问题', '方案',
  '需要', '使用', '支持', '这个', '一个', '我们', '你们', '已经', '现在', '就是', '不是', '一样',
  '因为', '所以', '但是', '然后', '还是', '如果', '在一', '帮我', '请你', '同时',
  // 交付与元话题（本库自身高频，但不是任何技巧的领域）
  '技巧', '知识', '库里', '文档', '输出', '中文', '经验', '内容', '信息', '说明', '要求',
  // 通用工程词（几乎所有技术文档都出现）
  '配置', '函数', '文件', '路径', '命令', '代码', '项目', '版本', '构建', '编译', '测试', '运行',
  // 英文填充词（分词器已去掉一部分，这里补齐门槛口径）
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'add', 'fix', 'update', 'change', 'make',
  'use', 'using', 'need', 'want', 'help', 'please', 'thing', 'stuff', 'issue', 'problem', 'check',
  // 英文侧的通用工程词，与上面的中文一一对应（两侧口径必须对称，否则换个语言就漏）
  'config', 'flag', 'function', 'value', 'name', 'code', 'file', 'path', 'line', 'test', 'build',
]

/**
 * 相关性门槛：**命中查询词数**与**绝对分数**两条下限（记忆层与技巧层共用）。
 *
 * 为什么要「命中词数」而不是只看分数：BM25 的分数取决于 IDF，而 IDF 取决于**库的规模** ——
 * 同一条命中在 354 条的库里是 2.7、在 2 条的库里只有 0.5，在 5000 条的库里是 12。
 * 绝对分数门槛因此天然不可移植：定得动真库就会把新装的小库整段杀掉。
 * 「命中几个不同的词」没有这个毛病 —— 不相关轮次的特征是「只见一个常见词」。
 *
 * 判据由 judge 组合：**非通用词**命中数、文档强字段（domain/tags/symbols）命中、可选分数。
 */
export interface RelevanceGate {
  /**
   * 命中**非通用词**的不同查询词数下限；查询里非通用词不超过 2 个时自动降为 1。
   *
   * 为什么对短查询放宽：`PlantUML 中文` 这种两词查询只命中一个词可能正是正确答案，
   * 按 2 硬卡会误杀；而真库实测的不相关轮次都是「四五个词里只中一个」。
   */
  minMatched?: number
  /** 绝对 BM25 分数下限（`0`/省略表示关闭）。只适合库规模稳定的大库，作为补充旋钮。 */
  minScore?: number
  /** 追加到 GATE_STOPWORDS 的通用词。 */
  stopwords?: readonly string[]
  /**
   * 空查询（没有任何可判定的词）时怎么办。
   *
   * - `allow`（默认）：沿用**检索**语义 —— 按时间/置信度取「最近/最自信」的几条。
   *   这是 `recall()` 的老行为，显式检索（`memory_search` 空查询）依赖它。
   * - `deny`：什么都不注入。**注入路径必须用它**：空查询没有可核对的意图，按置信度取
   *   前 N 条等于把「库里最自信的几条」每轮塞进上下文 —— 实测这就是「重启后第一轮
   *   又冒出三条 UML 技巧」的机制（真库上按置信度排前 3 的正是那三条）。
   */
  emptyQuery?: 'allow' | 'deny'
}

/** 一条候选的判定依据；同时用于把「为什么拦下」上报给调用方（可观测性）。 */
export interface GateDecision {
  /** 文档 id。 */
  id: string
  /** BM25（或名次）分数。 */
  score: number
  /** 命中的**非通用词**个数。 */
  matched: number
  /** 其中命中文档强字段（domain/tags/symbols）的个数。 */
  strong: number
  /** 命中的非通用词（诊断用）。 */
  shared: readonly string[]
  /** 只命中通用词的个数（诊断用：这些不构成相关性证据）。 */
  generic: number
  /** 是否放行。 */
  kept: boolean
}

/**
 * 「标识符样式」的查询词：ASCII 字母开头、长度 ≥4、只含字母数字与 `_ . -`。
 *
 * 为什么它们算强证据：调用名 / 类名 / 版本键（`authorize`、`componentStyle`、`utf-8`）
 * 近乎唯一，命中一个就足以说明文档说的是同一件事；而中文常见词是二字 bigram（「输出」
 * 「中文」），命中一个什么也证明不了。不加这条，合法的「只命中一个 API 名」会被误杀 ——
 * 实测 7 条既有用例正因此失败。
 */
const IDENTIFIER_RE = /^[a-z][a-z0-9_.-]{3,}$/u

/** 门槛判定要用的量化结果。 */
interface GateMetrics {
  matched: number
  strong: number
  shared: string[]
  generic: number
}

/**
 * 量一条文档对判定词的命中情况。
 *
 * @param doc - 待判定的文档。
 * @param terms - 判定词（**去重后的用户原话 token**）。
 * @param stopwords - 通用词表。
 * @returns 非通用命中数、强字段命中数、命中词与仅通用命中数。
 */
function measure(doc: RecallDoc, terms: readonly string[], stopwords: ReadonlySet<string>): GateMetrics {
  const tokens = new Set(tokenize(doc.text))
  const meta = doc.meta
  const strongTokens = new Set(tokenize([
    ...(meta?.domain === undefined ? [] : [meta.domain]),
    ...(meta?.tags ?? []),
    ...(meta?.symbols ?? []),
  ].join(' ')))
  const shared: string[] = []
  let matched = 0
  let strong = 0
  let generic = 0
  for (const term of terms) {
    if (!tokens.has(term)) continue
    if (stopwords.has(term)) { generic += 1; continue }
    shared.push(term)
    matched += 1
    if (strongTokens.has(term) || IDENTIFIER_RE.test(term)) strong += 1
  }
  return { matched, strong, shared, generic }
}

/**
 * 相关性判定：记忆层与技巧层、内存后端与索引后端**共用这一处**。
 *
 * 放行条件（或关系）：
 * - 查询**全由通用词组成**（如「继续」「输出文档」）→ 拦下：没有可核对的意图；
 * - 非通用词命中数达到 `minMatched`（非通用词 ≤2 个时降为 1）→ 放行；
 * - 命中至少一个**强字段**词（domain/tags/symbols）**且**至少命中一个非通用词 → 放行：
 *   领域词命中比碎词命中可信得多；
 * - 设了 `minScore` 时还要过分数下限（名次分不参与：跨后端不可比）。
 */
function judge(
  metrics: GateMetrics,
  score: number,
  gate: RelevanceGate | undefined,
  terms: { total: number; informative: number },
  rankScored = false,
): boolean {
  if (gate === undefined) return true
  // 空查询无从判定相关性：注入路径必须**不注入**（`emptyQuery: 'deny'`），否则会退化成
  // 「按置信度取前 N 条」——与相关性无关，而且每次请求都会发生。检索路径保留旧语义。
  if (terms.total === 0) return gate.emptyQuery !== 'deny'
  const minScore = gate.minScore ?? 0
  if (minScore > 0 && !rankScored && score < minScore) return false
  const minMatched = gate.minMatched ?? 0
  if (minMatched <= 0) return true
  // 非空但一个非通用词都没命中：用户没给出任何可核对的意图，注入只能是噪声。
  if (metrics.matched === 0) return false
  // 放宽看**非通用词**的个数：查询里只有一两个有信息量的词时（`PlantUML 中文`），
  // 「只中一个」不构成不相关的证据 —— 通用词已经不算数了，能中的那个就是全部线索。
  const required = terms.informative <= 2 ? 1 : Math.min(minMatched, terms.informative)
  return metrics.matched >= required || metrics.strong >= 1
}

/** 把判定词拆成「总数」与「非通用词数」——放宽判据只看后者。 */
function judgeTerms(terms: readonly string[], stopwords: ReadonlySet<string>): { total: number; informative: number } {
  return { total: terms.length, informative: terms.filter(term => !stopwords.has(term)).length }
}

/**
 * 顾问的**噪声词**：这些东西在文件路径、调用名与技巧标签里到处都是，命中它们不构成
 * 「这条知识讲的就是你现在改的东西」。
 *
 * 为什么必须显式排除：实测「改任意 `src/main/java/...java`」会让 `src`/`main`/`java`/`api`
 * 同时命中好几条无关技巧；`bash gradle build` 也能靠 tag `command` 推两条。顾问出现在
 * 模型正要动手的那一刻，错一条就是打断它 —— 宁可漏，不可噪。
 */
const ADVISORY_NOISE: ReadonlySet<string> = new Set([
  'java', 'gradle', 'jar', 'src', 'main', 'test', 'tests', 'command', 'content', 'file', 'files',
  'path', 'api', 'doc', 'docs', 'json', 'xml', 'yaml', 'mod', 'build', 'class', 'code', 'data',
  // 扩展名同样不是知识证据。实测：`src/newmodule.ts` 仅因库里某条技巧出现过词元 `ts`
  // 就被判成「库已覆盖」，于是 0.2.6 的「新领域」放行判据对最常见的源码文件整体失效。
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'kt', 'kts', 'cs', 'php',
  'cpp', 'cc', 'hpp', 'sh', 'ps1', 'bat', 'cmd', 'sql', 'css', 'scss', 'html', 'htm', 'vue',
  'toml', 'ini', 'cfg', 'conf', 'lock', 'txt', 'md', 'yml', 'map', 'png', 'svg', 'jpg',
])

/** 门槛同款通用词（这里再用于顾问：`make`/`turn`/`per` 这类英文填充词不是实体名）。 */
const GATE_STOPWORDS_SET: ReadonlySet<string> = new Set(GATE_STOPWORDS)

/** 一条「动作点顾问」命中：只给把手与理由，正文交给 `technique_get`。 */
export interface AdvisoryHit {
  /** 技巧 id。 */
  id: string
  /** 可读标签（技巧名/首行）。 */
  label: string
  /** 命中的**强证据**词（符号 / 领域 / 标签）。 */
  strong: readonly string[]
  /** 这条还是草稿（未经验证）——顾问要如实标注，让模型知道该怎么用。 */
  draft: boolean
}

/**
 * 为一次**工具调用**找「可能相关、且本会话还没看过」的技巧（动作点顾问）。
 *
 * 与注入的区别是**判据更严**：只认强证据（调用名 / 领域 / 标签命中文档），不做自由文本
 * 模糊匹配 —— 顾问出现在模型正要动手的那一刻，漏一条只是少点帮助，错一条就是打断。
 * 也正因如此它用不着通用词表：命中的是 `DataComponents` 这类符号，不是「文件」「路径」。
 *
 * @param docs - 候选文档（注入语料：只含已验证技巧）。
 * @param actionTerms - 本次动作的检索词（文件路径分段 + 调用名，已 tokenize）。
 * @param options - 条数上限与「本会话已看过/已推过」的 id 集合。
 * @returns 按强证据数、更新时间排序的命中。
 */
export function advisoryMatches(
  docs: readonly RecallDoc[],
  actionTerms: readonly string[],
  options: { limit?: number; seen?: ReadonlySet<string> } = {},
): AdvisoryHit[] {
  const limit = options.limit ?? 2
  if (limit <= 0 || actionTerms.length === 0) return []
  const hits: (AdvisoryHit & { ts: number })[] = []
  for (const doc of docs) {
    if (doc.layer !== 'technique') continue
    if (options.seen?.has(doc.id) === true) continue
    // 证据只取**正文与符号**，不取 tags/domain：标签天生是泛化的（`java`、`command`、
    // `content`），拿它当证据会让「改任何 Java 文件」都推出 Java 类技巧、「跑条命令」
    // 推出所有 tag 含 command 的技巧 —— 实测正是如此（顾问变成噪声）。
    const evidence = new Set([
      ...tokenize(doc.text),
      ...(doc.meta?.symbols ?? []).flatMap(symbol => tokenize(symbol)),
    ])
    const shared = actionTerms.filter(term =>
      evidence.has(term) && !ADVISORY_NOISE.has(term) && !GATE_STOPWORDS_SET.has(term))
    if (shared.length === 0) continue
    hits.push({
      id: doc.id,
      label: doc.text.split('\n')[0] ?? doc.id,
      strong: shared,
      draft: doc.meta?.status === 'draft',
      ts: doc.ts,
    })
  }
  // 排序：命中词多者优先 → 命中词更长者（更具体）优先 → 更新时间新者优先。
  // 最后一条是刻意的：同样相关时，把最近学到/改过的知识推在前面。
  return hits
    .sort((left, right) => right.strong.length - left.strong.length
      || right.strong.join('').length - left.strong.join('').length
      || right.ts - left.ts)
    .slice(0, limit)
    .map(({ ts: _ts, ...hit }) => hit)
}

/** 把门槛设置收敛成判定要用的形态（内置表与追加表合并）。 */
function gateStopwords(gate: RelevanceGate | undefined): ReadonlySet<string> {
  return new Set([...GATE_STOPWORDS, ...(gate?.stopwords ?? [])])
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
): { doc: RecallDoc; score: number; metrics: GateMetrics }[] {
  const queryTokens = tokenize(query)
  const stopwords = options.stopwords ?? new Set<string>()
  const gateUnique = [...new Set(options.gateTerms ?? queryTokens)]
  if (queryTokens.length === 0) {
    return [...docs]
      .sort((left, right) => right.ts - left.ts)
      .map(doc => ({ doc, score: 0, metrics: measure(doc, gateUnique, stopwords) }))
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
  const scored: { doc: RecallDoc; score: number; metrics: GateMetrics }[] = []
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
    // 度量按**判定词**（用户原话）算，与打分用的 query 分开：排序可以用子查询，判定不行。
    scored.push({ doc, score, metrics: measure(doc, gateUnique, stopwords) })
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
  options: {
    limit?: number
    now?: number
    recencyWeight?: number
    gate?: RelevanceGate
    /** 判定词（用户原话 token）；缺省用 query 自己的 token。 */
    gateTerms?: readonly string[]
    /** 上报每个候选的门槛判定（可观测性）。 */
    onDecision?: (decision: GateDecision) => void
  } = {},
): RecalledMemory[] {
  const limit = options.limit ?? 5
  if (limit <= 0 || docs.length === 0) return []
  const gate = options.gate
  const terms = [...new Set(options.gateTerms ?? tokenize(query))]
  const scored = scoreDocs(query, docs, {
    now: options.now ?? Date.now(),
    recencyWeight: options.recencyWeight ?? 0.15,
    gateTerms: terms,
    stopwords: gateStopwords(gate),
  })
  const kept: RecalledMemory[] = []
  for (const entry of scored) {
    const score = entry.doc.layer === 'episodic' ? entry.score * EPISODIC_WEIGHT : entry.score * TECHNIQUE_WEIGHT
    const ok = judge(entry.metrics, score, gate, judgeTerms(terms, gateStopwords(gate)))
    options.onDecision?.({
      id: entry.doc.id,
      score,
      matched: entry.metrics.matched,
      strong: entry.metrics.strong,
      shared: entry.metrics.shared,
      generic: entry.metrics.generic,
      kept: ok,
    })
    if (!ok) continue
    kept.push({
      layer: entry.doc.layer,
      id: entry.doc.id,
      score,
      text: entry.doc.text,
      ts: entry.doc.ts,
      ...(entry.doc.meta === undefined ? {} : { meta: entry.doc.meta }),
    })
  }
  // 门槛对各层一视同仁：记忆与技巧都只该在**相关**时占用注入预算。不相关的那一层不是
  // 「稍微有用」，而是纯噪声；常驻规则（偏好/约束）不靠检索进入上下文，而是由注入路径
  // 单独直取 —— 两处都放行会让 `injectStandingRules` 的条数上限与关闭开关失效。
  return kept.sort((left, right) => right.score - left.score || right.ts - left.ts).slice(0, limit)
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
  /** 相关性门槛（非通用词命中数 + 强字段命中 + 可选分数）。记忆层与技巧层共用同一口径。 */
  gate?: RelevanceGate
  /** 判定词（用户原话 token）；缺省用被检索的 query 自己的 token。 */
  gateTerms?: readonly string[]
  /** 上报每个候选的门槛判定（可观测性）。 */
  onDecision?: (decision: GateDecision) => void
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
  const gate = options.gate
  const terms = [...new Set(options.gateTerms ?? tokenize(query))]

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
    gateTerms: terms,
    stopwords: gateStopwords(gate),
  })
  const emptyQuery = tokenize(query).length === 0
  const lowerQuery = query.toLowerCase()

  const kept: RecalledMemory[] = []
  for (const entry of scored) {
    const meta = entry.doc.meta
    const successes = meta?.successes ?? 0
    const failures = meta?.failures ?? 0
    const confidence = (successes + 1) / (successes + failures + 2)
    const evidenceBonus = (meta?.evidenceCount ?? 0) > 0 ? 1.1 : 0.6
    const symbolHit = (meta?.symbols ?? []).some(symbol => symbols.has(symbol))
    const symbolBonus = symbolHit ? 1.6 : 1
    const domainBonus = meta?.domain !== undefined && lowerQuery.includes(meta.domain.toLowerCase()) ? 1.2 : 1
    const base = entry.score > 0 || emptyQuery ? (entry.score > 0 ? entry.score : 1) : 0
    const score = base * TECHNIQUE_WEIGHT * confidence * evidenceBonus * symbolBonus * domainBonus
    if (score <= 0) continue
    // 判定在加权**之后**做，但判定用的 `matched` 来自原始词命中（measure），不被加成放大。
    const ok = judge(entry.metrics, score, gate, judgeTerms(terms, gateStopwords(gate)))
    options.onDecision?.({
      id: entry.doc.id,
      score,
      matched: entry.metrics.matched,
      strong: entry.metrics.strong,
      shared: entry.metrics.shared,
      generic: entry.metrics.generic,
      kept: ok,
    })
    if (!ok) continue
    kept.push({
      layer: entry.doc.layer,
      id: entry.doc.id,
      score,
      text: entry.doc.text,
      ts: entry.doc.ts,
      ...(meta === undefined ? {} : { meta }),
    })
  }
  return kept.sort((left, right) => right.score - left.score || right.ts - left.ts).slice(0, limit)
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
  const gate = options.gate
  const stopwords = gateStopwords(gate)
  // **判定词取用户原话**：子查询里混着当轮文件路径与工具名（`facetQueries` 会把它们按
  // `/` 切开后当成独立子查询），拿子查询判定等于让 `architecture.puml` 里的 `puml`
  // 替用户表达意图 —— 实测一个路径片段就能放行整套 PlantUML 技巧。排序仍用子查询。
  const terms = [...new Set(options.gateTerms ?? tokenize(query))]
  const keep = (doc: RecallDoc, score: number, rankScored: boolean): boolean => {
    const metrics = measure(doc, terms, stopwords)
    const ok = judge(metrics, score, gate, judgeTerms(terms, stopwords), rankScored)
    options.onDecision?.({
      id: doc.id,
      score,
      matched: metrics.matched,
      strong: metrics.strong,
      shared: metrics.shared,
      generic: metrics.generic,
      kept: ok,
    })
    return ok
  }
  const perQuery = queries.map(sub => {
    const ids = options.scorer?.(sub, depth)
    // 打分器给了结果就用它；没给（不可用/无 token/出错）就地回退内存 BM25。
    if (ids === undefined) return recallTechniques(sub, docs, { ...options, limit: depth, gateTerms: terms })
    return ids
      .map((id, index) => {
        const doc = byId.get(id)
        if (doc === undefined) return undefined
        // 名次分：跨后端/跨子查询的原始分不可比，顺序才是要保住的信息。
        const score = 1 / (index + 1)
        // 名次分支同样要过门槛：索引后端的分数不可比，但**相关性判据与后端无关**，
        // 否则一开 sqlite 就等于把门槛整段关掉。
        return keep(doc, score, true) ? {
          layer: doc.layer,
          id,
          score,
          text: doc.text,
          ts: doc.ts,
          ...(doc.meta === undefined ? {} : { meta: doc.meta }),
        } satisfies RecalledMemory : undefined
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
 * @param options - 通用召回选项，外加结构化补充词 `extra` 与技巧层门槛 `gate`。
 * @returns 合并后的召回结果。
 */
export function recallDocsFacets(
  query: string,
  docs: readonly RecallDoc[],
  options: {
    limit?: number
    now?: number
    recencyWeight?: number
    extra?: readonly string[]
    gate?: RelevanceGate
    /** 判定词（用户原话 token）；缺省用 query 自己的 token。 */
    gateTerms?: readonly string[]
    /** 上报每个候选的门槛判定（可观测性）。 */
    onDecision?: (decision: GateDecision) => void
  } = {},
): RecalledMemory[] {
  const limit = options.limit ?? 5
  if (limit <= 0 || docs.length === 0) return []
  const queries = facetQueries(query, docs, options.extra ?? [])
  // 每个子查询多取一些：交错合并要按轮次取到较深的位次。
  // **判定词只认用户原话**：子查询里混着当轮文件路径与工具名，排序可以用它们，
  // 但「这算不算相关」必须按用户说过的话判。
  const terms = [...new Set(options.gateTerms ?? tokenize(query))]
  const perQuery = queries.map(sub => recall(sub, docs, {
    ...options,
    limit: Math.max(limit, 10),
    gateTerms: terms,
  }))
  return mergeInterleaved(perQuery, limit)
}
