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
 * 从**项目自己的文件路径**推导私有标识候选。
 *
 * 这是比正则扫描可靠得多的信号：出现在工作区路径里的类型名基本可以确定是项目私有代码，
 * 而不是第三方库。取文件名去掉扩展名，并过滤过短与通用词。
 *
 * @param paths - 工作区相对路径列表。
 * @returns 去重后的标识符候选。
 */
export function identifiersFromPaths(paths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const path of paths) {
    const base = path.split(/[/\\]/u).pop() ?? ''
    const name = base.replace(/\.[A-Za-z0-9]+$/u, '')
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
