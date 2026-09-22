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
