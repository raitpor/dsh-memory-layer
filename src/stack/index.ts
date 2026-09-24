/**
 * 技术栈画像的对外入口：探测器注册表 + 适用性判定 + 展示摘要。
 *
 * 适用性判定是「默认全局」下最重要的一道精度闸门：
 * 语言不符、生态不符、版本约束不满足时**不注入** —— 宁可不给，也不给错的。
 *
 * @module dsh-memory-layer/stack
 */

import type { StackProfile } from '../types.js'
import { satisfiesVersion } from './version.js'

export { createFileView, detectStack, DEFAULT_DETECTORS, mergeStack } from './detectors.js'
export type { FileView, StackDetector } from './detectors.js'
export { compareVersions, parseVersion, satisfiesVersion } from './version.js'

/**
 * 判断一条记录的技术栈是否适用于当前项目。
 *
 * 规则（对应设计 §7）：
 *
 * 1. 任一方画像缺失 → 无法判定，**放行**（不阻断）；
 * 2. `ecosystem` 双方都声明时必须相等；
 * 3. `languages` 双方都非空时必须**有交集** —— 这是全局域下最关键的闸门；
 * 4. `frameworks` 双方都非空时必须有交集；
 * 5. `versionConstraints` 逐项用当前精确版本判定，缺少精确版本时放行。
 *
 * @param record - 记录声明的适用栈。
 * @param current - 当前项目的观测栈。
 * @returns 适用时为 `true`。
 */
export function stacksCompatible(
  record: StackProfile | undefined,
  current: StackProfile | undefined,
): boolean {
  if (record === undefined || current === undefined) return true

  if (
    record.ecosystem !== undefined
    && current.ecosystem !== undefined
    && record.ecosystem !== current.ecosystem
  ) {
    return false
  }

  const recordLanguages = record.languages.filter(language => language.length > 0)
  const currentLanguages = current.languages.filter(language => language.length > 0)
  if (recordLanguages.length > 0 && currentLanguages.length > 0) {
    if (!recordLanguages.some(language => currentLanguages.includes(language))) return false
  }

  const recordFrameworks = record.frameworks ?? []
  const currentFrameworks = current.frameworks ?? []
  if (recordFrameworks.length > 0 && currentFrameworks.length > 0) {
    if (!recordFrameworks.some(framework => currentFrameworks.includes(framework))) return false
  }

  for (const [key, constraint] of Object.entries(record.versionConstraints ?? {})) {
    const exact = current.versions?.[key]
    if (exact === undefined) continue
    if (!satisfiesVersion(exact, constraint)) return false
  }

  return true
}

/** `appliesTo` 里表示「代码模块 / 路径」的键。 */
const MODULE_KEYS = new Set(['module', 'modules', 'path', 'paths', 'package'])

/** 版本键的别名：写 `mc=1.21.1` 时按 `minecraft` 去画像里找精确版本。 */
const VERSION_KEY_ALIASES: Record<string, string> = {
  mc: 'minecraft',
  minecraft: 'minecraft',
}

/** `key=value` / `key: value` 形式的一条约束；整串是散文时解析不出任何项。 */
const APPLIES_TO_ITEM_RE = /^([A-Za-z][\w.-]*)\s*[=:]\s*(.+)$/u

/** `appliesTo` 闸门需要的上下文。 */
export interface AppliesToContext {
  /** 当前轮触达的工作区文件（相对或绝对路径）。 */
  files?: readonly string[]
  /** 当前项目画像：把 `mc=1.21.1` 这类约束与**观测到的精确版本**对比。 */
  stack?: StackProfile
}

/**
 * 从当前画像里取出某个版本键的**精确**版本。
 *
 * 只认精确版本（`versions` / `frameworkVersions`）：`versionConstraints` 存的是 `~1.20`
 * 这类区间，拿区间当「当前版本」再去做比较是错的。
 *
 * @param key - `appliesTo` 里的键（已小写）。
 * @param stack - 当前画像。
 * @returns 精确版本；不知道时为 `undefined`（调用方据此放行）。
 */
function exactVersionFor(key: string, stack: StackProfile | undefined): string | undefined {
  if (stack === undefined) return undefined
  const alias = VERSION_KEY_ALIASES[key] ?? key
  return stack.versions?.[key] ?? stack.versions?.[alias]
    ?? stack.frameworkVersions?.[key] ?? stack.frameworkVersions?.[alias]
}

/**
 * 判定一条技巧的 `appliesTo` 是否适用于当前上下文。
 *
 * 这条闸门存在的理由：`appliesTo` 此前只写不读 —— 它进了检索语料、也被 `technique_get`
 * 渲染，但没有任何过滤读它，于是一条标着 `module=settlement` 的逻辑卡会在改别的模块时
 * 照样注入，「版本 / 模块范围」只是文档承诺。
 *
 * 判定原则与 {@link stacksCompatible} 一致：**只拦「判得出来且明确不符」的，判不出来一律放行**。
 *
 * 1. 空串 / 整串不是 `key=value` 形式（散文）→ 放行；
 * 2. `module=` / `path=` 等：当前轮**没有任何文件证据**时放行；有证据时要求某个路径包含该值，
 *    否则判为不适用；
 * 3. 能对上画像里**精确版本**的键：用 `satisfiesVersion` 比较，不满足即判为不适用；
 * 4. 认不出的键（如 `branch=main`）→ 放行 —— 写错一个键不该让知识静默消失。
 *
 * 值里不要带空格（按空白切分会把它拆成两项）；多值用逗号分隔。
 *
 * @param appliesTo - 记录里的范围约束原文。
 * @param context - 当前轮的文件证据与项目画像。
 * @returns 适用时为 `true`。
 */
export function appliesToAllows(appliesTo: string | undefined, context: AppliesToContext = {}): boolean {
  const text = appliesTo?.trim() ?? ''
  if (text.length === 0) return true
  const parsed = text
    .split(/[,;、\s]+/u)
    .map(item => APPLIES_TO_ITEM_RE.exec(item))
    .filter((match): match is RegExpExecArray => match !== null)
  // 整串都是散文（认不出任何 key=value）→ 不做判断。
  if (parsed.length === 0) return true

  const files = (context.files ?? []).map(file => file.toLowerCase())
  for (const match of parsed) {
    const key = (match[1] ?? '').toLowerCase()
    const value = (match[2] ?? '').trim()
    if (value.length === 0) continue
    if (MODULE_KEYS.has(key)) {
      // 没有文件证据就不判：宁可多给一条，也不因为「这一轮没提到那个模块」而静默扣掉知识。
      if (files.length === 0) continue
      if (!files.some(file => file.includes(value.toLowerCase()))) return false
      continue
    }
    const exact = exactVersionFor(key, context.stack)
    if (exact === undefined) continue
    if (!satisfiesVersion(exact, value)) return false
  }
  return true
}

/**
 * 把画像压成一行可读摘要，用于注入行与工具输出。
 * @param stack - 技术栈画像。
 * @returns 形如 `java/spring-boot, minecraft~1.20` 的摘要；空画像返回空串。
 */
export function stackSummary(stack: StackProfile | undefined): string {
  if (stack === undefined) return ''
  const parts: string[] = []
  const language = stack.languages[0]
  const framework = stack.frameworks?.[0]
  if (language !== undefined && framework !== undefined) parts.push(`${language}/${framework}`)
  else if (language !== undefined) parts.push(language)
  else if (framework !== undefined) parts.push(framework)

  if (stack.ecosystem !== undefined) {
    const version = stack.versionConstraints?.[stack.ecosystem] ?? stack.versions?.[stack.ecosystem]
    parts.push(version === undefined ? stack.ecosystem : `${stack.ecosystem}${version.startsWith('~') ? '' : '@'}${version}`)
  }
  return parts.join(', ')
}
