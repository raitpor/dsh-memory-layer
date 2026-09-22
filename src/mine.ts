/**
 * 代码库挖掘：从**已经写过的代码**里提炼可复用的知识。
 *
 * 流水线（对应设计 §6.2）：
 *
 * ```
 * 扫描分类 → 结构分析 → 候选聚类 → 抽象归纳 → 去标识化 + 泄漏校验 → 合并落盘
 * ```
 *
 * 两条产出路径，形状完全一致：
 *
 * 1. **规则路径**（零 token）：纯结构统计 —— 「这个符号在哪些角色里被怎么调」。
 *    它浅但绝不臆造，且在没有模型时保证功能不失效。
 * 2. **模型路径**：把证据包交给模型归纳出「什么时候用 / 怎么做 / 哪里会错」，
 *    再经同一套校验、去标识化与**泄漏校验**才允许入库。
 *
 * 关键约束：产出是**总结性知识**，不是代码。示例有行数与字符数硬上限，
 * 且必须通过泄漏校验（不得与来源逐字重合）。
 *
 * @module dsh-memory-layer/mine
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { abstractTechniqueDraft, identifiersFromPaths, isClean, leakCheck, wordSequence } from './abstract.js'
import { normalizeTechniqueDrafts } from './distill.js'
import { redact } from './redact.js'
import { slugify } from './store.js'
import type { LlmTextCaller } from './distill.js'
import type { ApiSurface, StackProfile, TechniqueDraft, TechniqueEvidence } from './types.js'

/** 代码在项目里承担的角色，决定候选归属与优先级。 */
export type CodeRole =
  | 'api-client'
  | 'service-layer'
  | 'domain-model'
  | 'build-config'
  | 'config'
  | 'test'
  | 'other'

/** 扫描时按扩展名认识的源码类型。 */
const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'java', 'kt', 'kts', 'groovy',
  'py', 'go', 'rs', 'rb', 'php', 'cs', 'cpp', 'cc', 'c', 'h', 'swift', 'scala',
  'gradle', 'json', 'toml', 'properties', 'xml', 'yml', 'yaml',
])

/** 无论如何都不扫描的目录（版本库、构建产物、依赖）。 */
const ALWAYS_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target',
  '.gradle', '.idea', '.vscode', '.venv', 'venv', '__pycache__', 'coverage', '.next',
  '.cache', 'run', 'tmp',
])

/** 工作区视图：只暴露挖掘真正需要的两个操作。 */
export interface RepoView {
  /** 仓库根目录。 */
  readonly root: string
  /**
   * 列出一个相对目录下的条目。
   * @param relativeDir - 相对目录，根目录用 `''`。
   * @returns 条目名与是否目录。
   */
  list(relativeDir: string): Promise<{ name: string; dir: boolean }[]>
  /**
   * 读取一个相对路径的文本。
   * @param relativePath - 相对路径。
   * @returns 文本；不存在时 `undefined`。
   */
  read(relativePath: string): Promise<string | undefined>
}

/** 基于真实文件系统构造工作区视图。 */
export function createRepoView(root: string): RepoView {
  return {
    root,
    async list(relativeDir) {
      const entries = await readdir(join(root, relativeDir), { withFileTypes: true })
      return entries.map(entry => ({ name: entry.name, dir: entry.isDirectory() }))
    },
    async read(relativePath) {
      try {
        return await readFile(join(root, relativePath), 'utf8')
      } catch {
        return undefined
      }
    },
  }
}

// ---- 忽略规则 ---------------------------------------------------------------

/** 一条忽略规则。 */
export interface IgnoreRule {
  /** 匹配相对路径的正则。 */
  pattern: RegExp
  /** `!` 开头的反向规则。 */
  negated: boolean
  /** 以 `/` 结尾，只匹配目录。 */
  dirOnly: boolean
}

/**
 * 把 `.gitignore` 风格的行编译成规则。
 *
 * 只支持最常用的子集：注释、空行、`!` 反选、结尾 `/` 目录限定、`*` 与 `**`。
 * 复杂语法（字符类、转义）按字面处理 —— 挖掘是「尽力而为」，漏掉一条忽略规则
 * 只影响扫描范围，不影响正确性。
 *
 * @param lines - 文件行。
 * @returns 编译后的规则。
 */
export function parseIgnoreLines(lines: readonly string[]): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    const body = negated ? line.slice(1) : line
    const dirOnly = body.endsWith('/')
    const cleaned = body.replace(/\/+$/u, '').replace(/^\.\//u, '')
    if (cleaned.length === 0) continue
    rules.push({ pattern: globToRegExp(cleaned), negated, dirOnly })
  }
  return rules
}

/** 把一个简化的 glob 编译成正则（`**` 跨目录，`*` 不跨目录）。 */
function globToRegExp(glob: string): RegExp {
  const anchored = glob.startsWith('/')
  const body = anchored ? glob.slice(1) : glob
  let source = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string
    if (char === '*') {
      if (body[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  }
  // 未锚定的模式匹配任意层级；锚定的从根开始。
  const prefix = anchored ? '^' : '(?:^|.*/)'
  return new RegExp(`${prefix}${source}(?:/.*)?$`, 'u')
}

/**
 * 判断一个相对路径是否被忽略。
 * @param relativePath - 相对路径。
 * @param isDir - 是否目录。
 * @param rules - 规则（后者覆盖前者）。
 * @returns 被忽略时为 `true`。
 */
export function isIgnored(relativePath: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (rule.pattern.test(relativePath)) ignored = !rule.negated
  }
  return ignored
}

// ---- 分类 -------------------------------------------------------------------

/** 判断路径是否像源码/配置，值得分析。 */
export function isAnalyzable(relativePath: string): boolean {
  const name = relativePath.split('/').pop() ?? ''
  const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  return SOURCE_EXTENSIONS.has(extension)
}

/**
 * 按路径推断代码角色。
 *
 * 这是「业务逻辑」与「专有 API 用法」两类知识的主要信号来源：
 * 角色决定了一条候选是「怎么调这个客户端」还是「这个领域有什么约束」。
 *
 * @param relativePath - 相对路径。
 * @returns 代码角色。
 */
export function classifyRole(relativePath: string): CodeRole {
  const lower = relativePath.toLowerCase()
  const name = lower.split('/').pop() ?? ''
  if (/(^|\/)(test|tests|spec|__tests__|e2e)(\/|$)/u.test(lower)
    || /\.(test|spec)\.[a-z]+$/u.test(name)
    || /(^|[_.-])(test|spec)s?\./u.test(name)
    || /test\.(java|kt|py|go|rs)$/u.test(name)) {
    return 'test'
  }
  if (/\.(json|toml|properties|xml|yml|yaml|gradle|kts)$/u.test(name)
    || /^(package|pom|build|settings|gradle|go|cargo|pyproject|tsconfig)/u.test(name)
    || /mods\.toml$/u.test(name)) {
    return 'build-config'
  }
  // 角色信号既可能在目录名里（JS 项目），也可能在类名里（Java 项目），两处都要看。
  if (/(^|\/)(api|client|clients|sdk|gateway|remote|integration)(\/|$)/u.test(lower)
    || /(client|gateway|adapter|sdk)/u.test(name)) {
    return 'api-client'
  }
  if (/(^|\/)(service|services|usecase|usecases|handler|handlers|controller|controllers|app)(\/|$)/u.test(lower)
    || /(service|handler|controller|usecase)/u.test(name)) {
    return 'service-layer'
  }
  if (/(^|\/)(domain|model|models|entity|entities|policy|policies|rule|rules|validator|validators)(\/|$)/u.test(lower)
    || /(policy|validator|entity|model|rule)/u.test(name)) {
    return 'domain-model'
  }
  if (/(^|\/)(config|configs|settings)(\/|$)/u.test(lower)) return 'config'
  return 'other'
}

/** 由扩展名推断语言。 */
export function languageOf(relativePath: string): string {
  const name = relativePath.split('/').pop() ?? ''
  const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  const table: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mjs: 'javascript', cjs: 'javascript', js: 'javascript', jsx: 'javascript',
    java: 'java', kt: 'kotlin', kts: 'kotlin', groovy: 'groovy', gradle: 'groovy',
    py: 'python', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', cs: 'csharp',
    cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', swift: 'swift', scala: 'scala',
    json: 'json', toml: 'toml', properties: 'properties', xml: 'xml', yml: 'yaml', yaml: 'yaml',
  }
  return table[extension] ?? 'text'
}

// ---- 扫描 -------------------------------------------------------------------

/** 扫描选项。 */
export interface ScanOptions {
  /** 最多读取的文件数。 */
  maxFiles: number
  /** 单文件最大字节数。 */
  maxBytes: number
  /** 额外包含的 glob（给出时只有命中的文件才被分析）。 */
  include?: readonly string[]
  /** 额外排除的 glob。 */
  exclude?: readonly string[]
}

/** 一个被扫描到的文件。 */
export interface ScannedFile {
  /** 工作区相对路径。 */
  path: string
  /** 代码角色。 */
  role: CodeRole
  /** 语言。 */
  language: string
  /** 文本内容（已按上限截断由调用方保证）。 */
  content: string
}

/**
 * 扫描仓库，返回可分析的文件。
 *
 * 三重边界保证成本可控：目录黑名单 + `.gitignore` + 文件数/字节数上限。
 * 遍历顺序固定（按名称排序），因此同样的仓库产出同样的候选顺序，便于测试与增量。
 *
 * @param view - 工作区视图。
 * @param options - 扫描选项。
 * @returns 文件列表与统计。
 */
export async function scanRepository(
  view: RepoView,
  options: ScanOptions,
): Promise<{ files: ScannedFile[]; visited: number; skippedLarge: number }> {
  const ignoreLines = (await view.read('.gitignore'))?.split(/\r?\n/u) ?? []
  const rules = parseIgnoreLines(ignoreLines)
  for (const pattern of options.exclude ?? []) {
    rules.push({ pattern: globToRegExp(pattern), negated: false, dirOnly: false })
  }
  const includes = (options.include ?? []).map(globToRegExp)

  const files: ScannedFile[] = []
  let visited = 0
  let skippedLarge = 0
  const queue: string[] = ['']

  while (queue.length > 0 && files.length < options.maxFiles) {
    const dir = queue.shift() as string
    let entries: { name: string; dir: boolean }[]
    try {
      entries = await view.list(dir)
    } catch {
      continue
    }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const relative = dir.length === 0 ? entry.name : `${dir}/${entry.name}`
      if (entry.dir) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue
        if (isIgnored(relative, true, rules)) continue
        queue.push(relative)
        continue
      }
      visited += 1
      if (isIgnored(relative, false, rules)) continue
      if (!isAnalyzable(relative)) continue
      if (includes.length > 0 && !includes.some(pattern => pattern.test(relative))) continue
      if (files.length >= options.maxFiles) break
      const content = await view.read(relative)
      if (content === undefined) continue
      if (Buffer.byteLength(content, 'utf8') > options.maxBytes) {
        skippedLarge += 1
        continue
      }
      files.push({
        path: relative,
        role: classifyRole(relative),
        language: languageOf(relative),
        content,
      })
    }
  }
  return { files, visited, skippedLarge }
}

// ---- 结构分析 ---------------------------------------------------------------

/** 一处调用点。 */
export interface CallSite {
  /** 规范化调用名，如 `Registry.register`。 */
  symbol: string
  /** 观察到的参数个数。 */
  arity: number
}

/** 一个文件的结构事实。 */
export interface FileFacts {
  /** 来源文件。 */
  file: ScannedFile
  /** import 语句里的模块名（已去标识化前原文，仅用于聚类与提示）。 */
  imports: string[]
  /** 调用点。 */
  calls: CallSite[]
  /** 守卫式校验所在的源码行。 */
  guards: string[]
  /** 注解（`@Mixin` 等）。 */
  annotations: string[]
}

/** 取调用名的正则：`A.b.c(` 或 `a.b(`，至少带一个点，避免把普通函数调用全收进来。 */
const CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*\(/gu

/** 守卫语句：条件后紧跟抛出/提前返回。 */
const GUARD_RE = /\b(?:if|unless|when|guard)\b[^\n]{0,160}?\b(?:throw|raise|reject|return\s+(?:null|false|undefined|new\s+Error|-1))\b/u

/** 注解/装饰器。 */
const ANNOTATION_RE = /@[A-Z][A-Za-z0-9_]*/gu

/**
 * 抽取一个文件的结构事实。
 *
 * 刻意只做**能在多语言间通用**的浅层分析：调用名与参数个数、守卫语句、注解。
 * 不做语法树解析 —— 那需要为每种语言引入解析器，与「零第三方运行时依赖」冲突。
 *
 * @param file - 已扫描的文件。
 * @returns 结构事实。
 */
export function analyzeSource(file: ScannedFile): FileFacts {
  const imports: string[] = []
  for (const match of file.content.matchAll(/^\s*(?:import|from|using|#include|require)\s*\(?\s*['"]?([^\s'";)]+)/gmu)) {
    const value = match[1]
    if (value !== undefined && value.length > 0) imports.push(value)
  }

  const calls: CallSite[] = []
  for (const match of file.content.matchAll(CALL_RE)) {
    const symbol = match[0].slice(0, -1).trim()
    const open = (match.index ?? 0) + match[0].length - 1
    calls.push({ symbol, arity: countArguments(file.content, open) })
  }

  const guards: string[] = []
  for (const line of file.content.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.length > 200) continue
    if (GUARD_RE.test(trimmed)) guards.push(trimmed)
  }

  const annotations = [...new Set([...file.content.matchAll(ANNOTATION_RE)].map(match => match[0]))]

  return { file, imports, calls, guards, annotations }
}

/** 从 `(` 位置起粗略统计顶层参数个数。 */
function countArguments(text: string, openIndex: number): number {
  let depth = 0
  let commas = 0
  let sawContent = false
  for (let index = openIndex; index < text.length && index < openIndex + 600; index += 1) {
    const char = text[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return sawContent ? commas + 1 : 0
    } else if (char === ',' && depth === 1) commas += 1
    else if (depth === 1 && char !== undefined && !/\s/u.test(char)) sawContent = true
  }
  return sawContent ? commas + 1 : 0
}

// ---- 候选聚类 ---------------------------------------------------------------

/** 一簇候选：同一调用名在仓库里的全部调用点。 */
export interface SymbolCluster {
  /** 规范化调用名。 */
  symbol: string
  /** 调用点所在文件（去重）。 */
  files: ScannedFile[]
  /** 观察到的参数个数（去重）。 */
  arities: number[]
  /** 涉及的角色（去重）。 */
  roles: CodeRole[]
  /** 调用点总数。 */
  occurrences: number
  /** 证据摘录：调用点附近的源码行（供模型归纳，不落盘）。 */
  excerpt: string
}

/**
 * 按调用名聚类。
 * @param facts - 各文件的结构事实。
 * @param minOccurrences - 成为候选所需的最小出现次数。
 * @param maxClusters - 候选簇上限。
 * @returns 按出现次数倒序的簇。
 */
export function clusterSymbols(
  facts: readonly FileFacts[],
  minOccurrences: number,
  maxClusters = 20,
): SymbolCluster[] {
  const bySymbol = new Map<string, SymbolCluster>()
  for (const entry of facts) {
    for (const call of entry.calls) {
      let cluster = bySymbol.get(call.symbol)
      if (cluster === undefined) {
        cluster = { symbol: call.symbol, files: [], arities: [], roles: [], occurrences: 0, excerpt: '' }
        bySymbol.set(call.symbol, cluster)
      }
      cluster.occurrences += 1
      if (!cluster.files.some(file => file.path === entry.file.path)) cluster.files.push(entry.file)
      if (!cluster.arities.includes(call.arity)) cluster.arities.push(call.arity)
      if (!cluster.roles.includes(entry.file.role)) cluster.roles.push(entry.file.role)
    }
  }

  const clusters = [...bySymbol.values()].filter(cluster => cluster.occurrences >= minOccurrences)
  clusters.sort((left, right) => right.occurrences - left.occurrences || left.symbol.localeCompare(right.symbol))
  return clusters.slice(0, maxClusters).map(cluster => ({
    ...cluster,
    excerpt: buildExcerpt(cluster, facts),
  }))
}

/** 为簇构造一段有界摘录：调用点所在行及其邻域，供模型归纳。 */
function buildExcerpt(cluster: SymbolCluster, facts: readonly FileFacts[]): string {
  const lines: string[] = []
  let budget = 40
  for (const file of cluster.files) {
    if (budget <= 0) break
    const source = facts.find(entry => entry.file.path === file.path)?.file.content ?? ''
    for (const [index, line] of source.split(/\r?\n/u).entries()) {
      if (budget <= 0) break
      if (!line.includes(`${cluster.symbol}(`)) continue
      const start = Math.max(0, index - 2)
      const window = source.split(/\r?\n/u).slice(start, index + 3)
      lines.push(`// ${file.role}`, ...window)
      budget -= window.length + 1
    }
  }
  return lines.join('\n').slice(0, 4000)
}

// ---- 候选生成 ---------------------------------------------------------------

/** 挖掘产出的候选：草稿 + 判定它是否泄漏所需的来源文本。 */
export interface MineCandidate {
  /** 技巧草稿（已去标识化）。 */
  draft: TechniqueDraft
  /** 该候选对应的来源文本，用于泄漏校验。 */
  source: string
  /** 产出路径。 */
  origin: 'rule' | 'model'
}

/** 把仓库名压成不含私有信息的别名。 */
function repoAlias(root: string): string {
  return slugify(basename(root)) || 'repo'
}

/** 由一簇调用点生成规则候选：只陈述**结构事实**，不做语义臆测。 */
export function ruleCandidate(cluster: SymbolCluster, stack: StackProfile, root: string): MineCandidate {
  const roles = cluster.roles.filter(role => role !== 'test')
  const roleText = roles.length > 0 ? roles.join('/') : 'other'
  const arities = [...cluster.arities].sort((left, right) => left - right)
  const surface: ApiSurface = {
    symbol: cluster.symbol,
    signature: `${cluster.symbol}(…)`,
    notes: `${cluster.occurrences} 处调用，出现过的参数个数：${arities.join('/')}`,
  }
  const evidence: TechniqueEvidence = {
    kind: 'code',
    repo: repoAlias(root),
    role: roleText,
    hint: `${cluster.occurrences} 处调用，分布于 ${cluster.files.length} 个文件`,
  }
  return {
    origin: 'rule',
    source: cluster.excerpt,
    draft: {
      kind: 'api-usage',
      name: `${cluster.symbol} 在仓库内的调用形态`,
      when: `需要调用 ${cluster.symbol} 时`,
      summary: [
        `在 ${roleText} 中共观察到 ${cluster.occurrences} 处对 ${cluster.symbol} 的调用，`,
        `分布于 ${cluster.files.length} 个文件，出现过的参数个数为 ${arities.join('/')}。`,
        '这是结构化观察，具体前置条件与顺序需要结合实现确认。',
      ].join(''),
      api: [surface],
      pitfalls: [],
      verify: [],
      stack,
      tags: [cluster.symbol.split('.')[0]?.toLowerCase() ?? 'api', ...roles].slice(0, 6),
      evidence: [evidence],
      sensitivity: 'internal',
      status: 'draft',
    },
  }
}

/** 挖掘用的模型提示：只产出**总结性知识**，禁止抄录实现。 */
export const MINE_SYSTEM_PROMPT = [
  'You mine reusable engineering knowledge from a code base excerpt.',
  'Return ONE JSON object and nothing else, in this shape:',
  '{"techniques":[{"kind":"api-usage"|"business-rule"|"procedure"|"pitfall"|"env-recipe","name":string,"when":string,"summary":string,"steps":string[],"invariants":string[],"api":[{"symbol":string,"signature":string,"notes":string}],"example":{"language":string,"kind":"usage"|"signature"|"config","code":string},"pitfalls":string[],"verify":string[],"domain":string,"tags":string[],"sensitivity":"public"|"internal"|"confidential"}]}',
  'Rules:',
  '- Emit at most 2 techniques for the given excerpt; prefer one high-quality entry over several vague ones.',
  '- The payload is `summary` (2-4 sentences of the actual method) plus `when` (the trigger).',
  '- NEVER copy implementation code. The example is at most 8 lines and must be REWRITTEN as an illustration.',
  '- Replace project-specific identifiers with <Placeholder> names; keep library and SDK symbols.',
  '- Only claim what the excerpt supports. If it is too thin to teach anything, return {"techniques":[]}.',
  '- Never include credentials, tokens, internal hostnames or customer data.',
].join('\n')

// ---- 增量缓存 ---------------------------------------------------------------

/** 缓存条目：文件内容哈希 + 当时的提示版本与模型。 */
export interface MineCacheEntry {
  /** 内容 sha1。 */
  hash: string
  /** 处理时的提示版本。 */
  promptVersion: string
  /** 处理时使用的模型（无模型时为空串）。 */
  model: string
}

/** 挖掘缓存文件的内容。 */
export interface MineCache {
  /** 缓存格式版本。 */
  version: number
  /** 相对路径 → 条目。 */
  entries: Record<string, MineCacheEntry>
}

/** 缓存格式版本：提示或流水线语义变化时应递增。 */
export const MINE_CACHE_VERSION = 1

/** 提示版本：模型提示词变化时必须递增，否则会跳过需要重挖的文件。 */
export const MINE_PROMPT_VERSION = 'p1'

/** 计算文件内容的哈希。 */
export function contentHash(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16)
}

/**
 * 判断一个文件是否可以用缓存跳过。
 * @param cache - 已有缓存。
 * @param path - 相对路径。
 * @param content - 当前内容。
 * @param model - 当前模型（无模型时 `''`）。
 * @returns 可跳过时为 `true`。
 */
export function cacheHit(cache: MineCache, path: string, content: string, model: string): boolean {
  const entry = cache.entries[path]
  if (entry === undefined) return false
  return entry.hash === contentHash(content)
    && entry.promptVersion === MINE_PROMPT_VERSION
    && entry.model === model
}

/**
 * 用本次扫描结果更新缓存。
 * @param cache - 原缓存。
 * @param files - 本次处理的文件与模型。
 * @returns 新缓存。
 */
export function withCacheEntries(
  cache: MineCache,
  files: readonly { path: string; content: string }[],
  model: string,
): MineCache {
  const entries: Record<string, MineCacheEntry> = { ...cache.entries }
  for (const file of files) {
    entries[file.path] = { hash: contentHash(file.content), promptVersion: MINE_PROMPT_VERSION, model }
  }
  return { version: MINE_CACHE_VERSION, entries }
}

// ---- 泄漏校验的执行点 -------------------------------------------------------

/** 把候选草稿拼成一段用于泄漏校验的文本。 */
export function candidateText(draft: TechniqueDraft): string {
  return [
    draft.name,
    draft.when,
    draft.summary,
    ...(draft.steps ?? []),
    ...(draft.invariants ?? []),
    ...(draft.api ?? []).map(surface => [surface.symbol, surface.signature ?? '', surface.notes ?? ''].join(' ')),
    ...(draft.invariants ?? []),
    ...draft.pitfalls,
    ...draft.verify,
    ...(draft.example === undefined ? [] : [draft.example.code]),
  ].join('\n')
}

/**
 * 对候选执行去标识化 + 泄漏校验。
 *
 * 顺序很重要：**先补齐技术栈 → 去标识化 → 再校验**。占位符化本身会消掉一部分重合，
 * 若先校验再抽象，会把本来合规的候选误判为泄漏（占位符替换后的文本才是真正要入库的文本）。
 *
 * @param candidate - 原始候选。
 * @param options - 技术栈、标识符与示例上限。
 * @returns 通过则为处理后的候选；泄漏时 `undefined` 并给出原因。
 */
export function finalizeCandidate(
  candidate: MineCandidate,
  options: {
    identifiers: readonly string[]
    exampleMaxLines: number
    exampleMaxChars: number
  },
): { candidate: MineCandidate } | { rejected: string } {
  const draft = abstractTechniqueDraft(
    { ...candidate.draft, stack: candidate.draft.stack },
    {
      identifiers: options.identifiers,
      exampleMaxLines: options.exampleMaxLines,
      exampleMaxChars: options.exampleMaxChars,
    },
  )
  const report = leakCheck(
    sanitizeForMining(candidateText(draft)),
    candidate.source,
    options.identifiers,
  )
  if (!isClean(report)) {
    const reasons: string[] = []
    if (report.verbatimRuns.length > 0) reasons.push(`逐字重合 ${report.verbatimRuns.length} 处`)
    if (report.identifierHits.length > 0) reasons.push(`残留私有标识 ${report.identifierHits.join(',')}`)
    return { rejected: reasons.join('；') }
  }
  return { candidate: { ...candidate, draft } }
}

/** 挖掘文本的统一净化：剥离凭据与控制字符后再做泄漏判定。 */
function sanitizeForMining(text: string): string {
  return redact(text)
}

/**
 * 由模型归纳一簇候选。
 * @param cluster - 调用簇。
 * @param stack - 当前技术栈。
 * @param call - 模型调用函数。
 * @returns 候选数组（已过形状校验，未过去标识化）。
 */
export async function modelCandidates(
  cluster: SymbolCluster,
  stack: StackProfile,
  call: LlmTextCaller,
): Promise<MineCandidate[]> {
  const packet = {
    symbol: cluster.symbol,
    roles: cluster.roles,
    occurrences: cluster.occurrences,
    arities: cluster.arities,
    excerpt: cluster.excerpt,
  }
  const output = await call(MINE_SYSTEM_PROMPT, `Mine reusable techniques from this excerpt (JSON):\n${JSON.stringify(packet)}`)
  const drafts = normalizeTechniqueDrafts(parseJsonObject(output)?.techniques, stack)
  return drafts.map(draft => ({ draft, source: cluster.excerpt, origin: 'model' as const }))
}

/** 从模型输出里截出第一个 JSON 对象；解析失败返回 `undefined`。 */
function parseJsonObject(output: string): Record<string, unknown> | undefined {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(output.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * 判断一段文本是否值得交给模型（太短或全是配置噪声时跳过，省 token）。
 * @param cluster - 调用簇。
 * @returns 值得时为 `true`。
 */
export function worthModeling(cluster: SymbolCluster): boolean {
  return cluster.occurrences >= 2 && wordSequence(cluster.excerpt).length >= 25
}

// ---- 编排 -------------------------------------------------------------------

/** 挖掘请求。 */
export interface MineRequest {
  /** 工作区视图。 */
  view: RepoView
  /** 当前技术栈。 */
  stack: StackProfile
  /** 缓存（用于跳过未变文件）。 */
  cache: MineCache
  /** 成本与门槛。 */
  options: {
    maxFiles: number
    maxBytes: number
    minOccurrences: number
    maxModelCalls: number
    exampleMaxLines: number
    exampleMaxChars: number
    timeoutMs: number
    include?: readonly string[]
    exclude?: readonly string[]
  }
  /** 模型调用函数；缺省时只走规则路径。 */
  call?: LlmTextCaller
  /** 缓存用的模型标识（无模型时为空串）。 */
  model: string
  /** 当前时间。 */
  now?: number
}

/** 一次挖掘的结果。 */
export interface MineOutcome {
  /** 通过全部闸门、可落盘的候选。 */
  candidates: MineCandidate[]
  /** 被拒候选与原因（主要是泄漏校验）。 */
  rejected: { name: string; reason: string }[]
  /** 本次真正处理的文件（用于更新缓存）。 */
  processed: { path: string; content: string }[]
  /** 统计。 */
  stats: {
    visited: number
    scanned: number
    skippedCached: number
    skippedLarge: number
    clusters: number
    modelCalls: number
    durationMs: number
    timedOut: boolean
  }
}

/** 空缓存。 */
export function emptyMineCache(): MineCache {
  return { version: MINE_CACHE_VERSION, entries: {} }
}

/**
 * 执行一次代码库挖掘。
 *
 * 编排顺序刻意让**规则路径先行**：即使模型不可用、超时或全部产出被泄漏校验拒绝，
 * 也一定能拿到结构候选 —— 没有模型时功能不失效，这是本插件的既有降级哲学。
 *
 * @param request - 挖掘请求。
 * @returns 候选、被拒项与统计。
 */
export async function mineRepository(request: MineRequest): Promise<MineOutcome> {
  const started = request.now ?? Date.now()
  const { options } = request
  const deadline = started + options.timeoutMs

  const scan = await scanRepository(request.view, {
    maxFiles: options.maxFiles,
    maxBytes: options.maxBytes,
    ...(options.include === undefined ? {} : { include: options.include }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
  })

  const processed: { path: string; content: string }[] = []
  let skippedCached = 0
  const facts: FileFacts[] = []
  for (const file of scan.files) {
    if (cacheHit(request.cache, file.path, file.content, request.model)) {
      skippedCached += 1
      continue
    }
    processed.push({ path: file.path, content: file.content })
    facts.push(analyzeSource(file))
  }

  const identifiers = identifiersFromScannedFiles(facts)
  const clusters = clusterSymbols(facts, options.minOccurrences)
  const candidates: MineCandidate[] = []
  const rejected: { name: string; reason: string }[] = []
  let modelCalls = 0
  let timedOut = false

  // 规则路径：零 token，永远先跑。
  for (const cluster of clusters) {
    keepOrReject(ruleCandidate(cluster, request.stack, request.view.root))
  }

  // 模型路径：受调用次数与总时长双重约束。
  if (request.call !== undefined) {
    for (const cluster of clusters) {
      if (modelCalls >= options.maxModelCalls) break
      if (Date.now() > deadline) {
        timedOut = true
        break
      }
      if (!worthModeling(cluster)) continue
      try {
        modelCalls += 1
        for (const candidate of await modelCandidates(cluster, request.stack, request.call)) {
          keepOrReject(candidate)
        }
      } catch {
        // 单簇模型调用失败不影响整体：规则候选已经在手上了。
      }
    }
  }

  return {
    candidates,
    rejected,
    processed,
    stats: {
      visited: scan.visited,
      scanned: scan.files.length,
      skippedCached,
      skippedLarge: scan.skippedLarge,
      clusters: clusters.length,
      modelCalls,
      durationMs: Date.now() - started,
      timedOut,
    },
  }

  /** 去标识化 + 泄漏校验：不通过就记原因丢弃。 */
  function keepOrReject(candidate: MineCandidate): void {
    const finalized = finalizeCandidate(candidate, {
      identifiers,
      exampleMaxLines: options.exampleMaxLines,
      exampleMaxChars: options.exampleMaxChars,
    })
    if ('rejected' in finalized) {
      rejected.push({ name: candidate.draft.name, reason: finalized.rejected })
      return
    }
    candidates.push(finalized.candidate)
  }
}

/** 从被扫描文件的路径推导项目私有标识（比正则扫描可靠）。 */
function identifiersFromScannedFiles(facts: readonly FileFacts[]): string[] {
  return identifiersFromPaths(facts.map(entry => entry.file.path))
}

