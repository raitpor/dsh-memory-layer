/**
 * 版本与版本区间：技巧适用性判定的基础。
 *
 * 刻意只实现一个**极小的子集**，够用且零依赖：
 *
 * - 比较：按点分段的数值比较（`1.20.1` > `1.20`）；
 * - 约束：空格分隔的多个比较式按 AND 组合，支持
 *   `>= > <= < = ~ ^` 与裸前缀（`1.20` / `1.20.x` / `1.20.*`）。
 *
 * Minecraft 的破坏性变更基本发生在 minor（`1.20` → `1.21`），
 * 因此 `~1.20`（>=1.20 且 <1.21）是最常用的写法。
 *
 * @module dsh-memory-layer/stack/version
 */

/**
 * 把版本串解析成数值分段；非数字段按 0 处理。
 * @param value - 版本串，允许带 `v` 前缀与预发布后缀（`1.20.1-rc.1`）。
 * @returns 数值分段数组。
 */
export function parseVersion(value: string): number[] {
  const cleaned = value.trim().replace(/^v/iu, '')
  const core = cleaned.split(/[-+]/u)[0] ?? ''
  if (core.length === 0) return []
  return core.split('.').map(part => {
    const match = /^(\d+)/u.exec(part)
    return match === null ? 0 : Number(match[1])
  })
}

/**
 * 比较两个版本。
 * @param left - 左版本。
 * @param right - 右版本。
 * @returns 左小于右返回负数，相等返回 0，否则正数。
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 判断版本是否满足单个比较式。
 * @param version - 待判定版本。
 * @param comparator - 单个比较式，如 `>=1.20` / `~1.20` / `1.20.x`。
 * @returns 满足时为 `true`。
 */
function satisfiesComparator(version: string, comparator: string): boolean {
  const trimmed = comparator.trim()
  if (trimmed.length === 0) return true

  const match = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/u.exec(trimmed)
  if (match === null) return false
  const operator = match[1] ?? ''
  const target = (match[2] ?? '').trim()

  // 裸版本 / 通配：按分段前缀匹配（`1.20` 命中 `1.20.1`，但不命中 `1.201`）。
  if (operator === '') {
    return hasPrefix(version, target.replace(/\.?[*x]$/iu, ''))
  }
  if (operator === '=') return compareVersions(version, target) === 0

  const comparison = compareVersions(version, target)
  if (operator === '>=') return comparison >= 0
  if (operator === '>') return comparison > 0
  if (operator === '<=') return comparison <= 0
  if (operator === '<') return comparison < 0

  const targetParts = parseVersion(target)
  if (operator === '~') {
    // ~1.20 与 ~1.20.3 都表示 >= 目标 且 < 下一个 minor。
    const upper = [targetParts[0] ?? 0, (targetParts[1] ?? 0) + 1]
    return comparison >= 0 && compareVersions(version, upper.join('.')) < 0
  }
  // ^1.20 → <2.0.0
  const upper = [(targetParts[0] ?? 0) + 1]
  return comparison >= 0 && compareVersions(version, upper.join('.')) < 0
}

/**
 * 版本是否以给定前缀开头（按分段比较）。
 * @param version - 待判定版本。
 * @param prefix - 前缀，如 `1.20`。
 * @returns 是前缀时为 `true`。
 */
function hasPrefix(version: string, prefix: string): boolean {
  const left = parseVersion(version)
  const right = parseVersion(prefix)
  if (right.length === 0) return true
  if (left.length < right.length) return false
  return right.every((segment, index) => left[index] === segment)
}

/**
 * 判断版本是否满足一个空格分隔的约束表达式。
 *
 * 空约束视为「不限制」，返回 `true`；多个比较式必须**全部**满足。
 *
 * @param version - 待判定版本。
 * @param constraint - 约束表达式，如 `>=1.20 <1.21`。
 * @returns 满足时为 `true`。
 */
export function satisfiesVersion(version: string, constraint: string): boolean {
  const trimmed = constraint.trim()
  if (trimmed.length === 0) return true
  return trimmed
    .split(/\s+/u)
    .filter(part => part.length > 0)
    .every(part => satisfiesComparator(version, part))
}
