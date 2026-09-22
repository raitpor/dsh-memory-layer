/**
 * 技巧层的领域逻辑：置信度、状态迁移、调用面索引与展示。
 *
 * 这里不碰磁盘 —— 存储读写在 `store.ts`，召回打分在 `recall.ts`，
 * 本模块只做「一条技巧该怎么算、该处于什么状态」这类纯函数判断，便于单独测试。
 *
 * @module dsh-memory-layer/technique
 */

import { STATUS_RANK } from './store.js'
import { stacksCompatible, stackSummary } from './stack/index.js'
import type { StackProfile, TechniqueRecord, TechniqueStatus } from './types.js'

/** 采用结果：由 `technique_apply` 工具或会话末自动关联回报。 */
export type TechniqueOutcome = 'success' | 'failure'

/** 连续失败达到该次数且多于成功次数时，记录被标记为 `deprecated`。 */
export const DEPRECATE_AFTER_FAILURES = 2

/** 成功次数达到该值、无失败、且有代码证据时，可提升为 `canonical`。 */
export const PROMOTE_AFTER_SUCCESSES = 3

/**
 * 计算一条技巧的置信度（拉普拉斯平滑，落在 0–1）。
 *
 * 用「实际采用结果」而非「被召回次数」作为依据：被召回不代表有用，
 * 被采用且成功才算数。
 *
 * @param record - 技巧记录。
 * @returns 置信度。
 */
export function confidenceOf(record: TechniqueRecord): number {
  return (record.successes + 1) / (record.successes + record.failures + 2)
}

/**
 * 依据计数推导「应处的状态」（不会降级，由调用方与现值取高）。
 * @param record - 技巧记录。
 * @returns 推导出的状态。
 */
export function promotedStatus(record: TechniqueRecord): TechniqueStatus {
  if (record.successes >= PROMOTE_AFTER_SUCCESSES
    && record.failures === 0
    && record.evidence.some(item => item.kind === 'code')) {
    return 'canonical'
  }
  if (record.successes >= 1) return 'validated'
  return 'draft'
}

/**
 * 应用一次采用结果，返回新的记录（不修改入参）。
 *
 * 迁移规则：
 * - 成功 → 计数 +1，刷新 `lastVerifiedAt`，可能提升状态；
 * - 失败 → 计数 +1，连续失败超过成功且达到阈值时标记 `deprecated`；
 * - `deprecated` 是粘性的，不会被自动提升。
 *
 * @param record - 原记录。
 * @param outcome - 采用结果。
 * @param now - 当前时间。
 * @returns 更新后的记录。
 */
export function applyOutcome(record: TechniqueRecord, outcome: TechniqueOutcome, now: number = Date.now()): TechniqueRecord {
  const successes = record.successes + (outcome === 'success' ? 1 : 0)
  const failures = record.failures + (outcome === 'failure' ? 1 : 0)
  const updated: TechniqueRecord = {
    ...record,
    applied: record.applied + 1,
    successes,
    failures,
    updatedAt: now,
  }
  if (outcome === 'success') updated.lastVerifiedAt = now

  if (failures >= DEPRECATE_AFTER_FAILURES && failures > successes) {
    updated.status = 'deprecated'
    return updated
  }
  const promoted = promotedStatus(updated)
  if (STATUS_RANK[promoted] > STATUS_RANK[updated.status]) updated.status = promoted
  return updated
}

/**
 * 取一条技巧的规范化调用名（`api-usage` 的主要检索途径）。
 * @param record - 技巧记录。
 * @returns 调用名数组（保序去重）。
 */
export function techniqueSymbols(record: TechniqueRecord): string[] {
  const out: string[] = []
  for (const surface of record.api ?? []) {
    const symbol = surface.symbol.trim()
    if (symbol.length > 0 && !out.includes(symbol)) out.push(symbol)
  }
  return out
}

/**
 * 建立「调用名 → 技巧 id」索引，供召回时精确命中。
 * @param records - 技巧记录。
 * @returns 符号索引。
 */
export function symbolIndex(records: readonly TechniqueRecord[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const record of records) {
    for (const symbol of techniqueSymbols(record)) {
      const bucket = index.get(symbol)
      if (bucket === undefined) index.set(symbol, [record.id])
      else if (!bucket.includes(record.id)) bucket.push(record.id)
    }
  }
  return index
}

/**
 * 渲染一条技巧的**索引行**：注入 system prompt 与工具输出的共用格式。
 *
 * 只含「名称 / 适用栈 / 触发条件 / id」，不含步骤与示例 —— 细节由 `technique_get` 按需展开，
 * 这是控制上下文成本的关键。
 *
 * @param record - 技巧记录。
 * @returns 单行文本。
 */
export function techniqueIndexLine(record: TechniqueRecord): string {
  const stack = stackSummary(record.stack)
  const parts = [
    record.name,
    stack.length === 0 ? '' : `适用: ${stack}`,
    `何时用: ${record.when}`,
    `id ${record.id}`,
  ]
  if (record.status !== 'draft') parts.splice(1, 0, `[${record.status}]`)
  return parts.filter(part => part.length > 0).join(' — ')
}

/**
 * 判断一条技巧是否适用于给定的当前栈。
 * @param record - 技巧记录。
 * @param current - 当前项目的观测栈。
 * @returns 适用时为 `true`。
 */
export function techniqueApplies(record: TechniqueRecord, current: StackProfile | undefined): boolean {
  return stacksCompatible(record.stack, current)
}

/**
 * 判断一条技巧是否可以参与**自动注入**：草稿与废弃都不参与。
 * @param record - 技巧记录。
 * @returns 可注入时为 `true`。
 */
export function injectable(record: TechniqueRecord): boolean {
  return record.status === 'validated' || record.status === 'canonical'
}
