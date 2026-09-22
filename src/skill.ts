/**
 * 把一条已验证技巧**物化**成标准 `SKILL.md`。
 *
 * 分工（对应设计 §12）：插件内的记忆层负责「学」——挖掘、证据、置信度、适用性；
 * skill 负责「跨 harness 用」。导出就是这两者之间的桥。
 *
 * 两条硬约束：
 *
 * 1. **只有已验证的技巧能导出**：草稿与已废弃的记录不得变成 skill，
 *    否则未经验证的猜测会以「技能」的身份在所有 harness 里生效。
 * 2. **`confidential` 禁止导出**：业务机密一旦进入账号级共享域就不可撤回。
 *
 * 前言的键必须落在 skill 加载器接受的集合内（`name` / `description` / `allowed-tools` /
 * `tags` / `metadata`）—— 其余键会被丢弃，于是「导出成功但行为变了」。
 *
 * @module dsh-memory-layer/skill
 */

import { stackSummary } from './stack/index.js'
import type { TechniqueRecord } from './types.js'

/** skill 允许出现在前言里的键。 */
export const SKILL_FRONTMATTER_KEYS: readonly string[] = [
  'name',
  'description',
  'allowed-tools',
  'tags',
  'metadata',
]

/** skill 名的字符集与长度限制（与加载器契约一致）。 */
export const SKILL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/u

/** 描述的长度上限。 */
export const SKILL_DESCRIPTION_MAX = 1024

/** 渲染选项。 */
export interface SkillRenderOptions {
  /** 允许使用的工具白名单；给出时写入 `allowed-tools`。 */
  allowedTools?: readonly string[]
  /** 是否在正文里包含示例；默认包含。 */
  includeExample?: boolean
}

/** 渲染产物。 */
export interface RenderedSkill {
  /** skill 目录名（同时也是前言里的 `name`）。 */
  name: string
  /** 索引用的描述。 */
  description: string
  /** 完整 `SKILL.md` 文本。 */
  markdown: string
}

/**
 * 把技巧名压成合法的 skill 名。
 *
 * 追加 id 片段是为了**避免碰撞**：两条技巧 slug 后同名时，
 * 后一次安装会静默覆盖前一条（加载器的行为），而这是不可接受的静默数据丢失。
 * 非 ASCII 名字（如纯中文）slug 后为空，此时回退到 `technique-<id>`——
 * 语义信息由 `description` 承担，那才是检索真正索引的字段。
 *
 * @param record - 技巧记录。
 * @returns 合法的 skill 名。
 */
export function skillNameOf(record: TechniqueRecord): string {
  const slug = record.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replace(/-+$/u, '')
  const suffix = record.id.replace(/^tq_/u, '').replace(/[^a-z0-9]/giu, '').slice(0, 8) || 'x'
  const base = slug.length >= 3 ? slug : 'technique'
  return `${base}-${suffix}`.slice(0, 64)
}

/**
 * 构造前言里的 `description`。
 *
 * 这是**唯一**被语义检索索引的字段，所以要写清「做什么」与「什么时候用」，
 * 并尽量用使用者会敲的词，而不是内部术语。
 *
 * @param record - 技巧记录。
 * @returns 单行描述。
 */
export function skillDescriptionOf(record: TechniqueRecord): string {
  const stack = stackSummary(record.stack)
  const parts = [
    record.summary.length > 0 ? record.summary : record.name,
    `Use when: ${record.when}.`,
    stack.length === 0 ? '' : `Applies to: ${stack}.`,
    record.tags.length === 0 ? '' : `Keywords: ${record.tags.join(', ')}.`,
  ]
  return clampOneLine(parts.filter(part => part.length > 0).join(' '), SKILL_DESCRIPTION_MAX)
}

/**
 * 渲染一条技巧为 `SKILL.md`。
 * @param record - 技巧记录（调用方负责校验状态与敏感级别）。
 * @param options - 渲染选项。
 * @returns 渲染产物。
 */
export function renderSkill(record: TechniqueRecord, options: SkillRenderOptions = {}): RenderedSkill {
  const name = skillNameOf(record)
  const description = skillDescriptionOf(record)

  const lines: string[] = ['---', `name: ${name}`, `description: ${description}`]
  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    lines.push(`allowed-tools: [${options.allowedTools.join(', ')}]`)
  }
  if (record.tags.length > 0) lines.push(`tags: [${record.tags.join(', ')}]`)
  lines.push(
    'metadata:',
    `  technique-id: ${record.id}`,
    `  status: ${record.status}`,
    `  sensitivity: ${record.sensitivity}`,
    '  source: dsh-memory-layer',
  )
  const stack = stackSummary(record.stack)
  if (stack.length > 0) lines.push(`  stack: ${stack}`)
  lines.push('---', '', `# ${record.name}`, '', `**When to use**: ${record.when}`, '', record.summary)

  if (record.invariants !== undefined && record.invariants.length > 0) {
    lines.push('', '## Invariants', ...record.invariants.map(item => `- ${item}`))
  }
  if (record.steps !== undefined && record.steps.length > 0) {
    lines.push('', '## Steps', ...record.steps.map((step, index) => `${index + 1}. ${step}`))
  }
  if (record.api !== undefined && record.api.length > 0) {
    lines.push('', '## API surface')
    for (const surface of record.api) {
      const signature = surface.signature === undefined ? '' : ` — \`${surface.signature}\``
      const notes = surface.notes === undefined ? '' : ` (${surface.notes})`
      lines.push(`- \`${surface.symbol}\`${signature}${notes}`)
    }
  }
  if ((options.includeExample ?? true) && record.example !== undefined) {
    lines.push(
      '',
      '## Example (illustrative only — never execute verbatim)',
      '',
      `\`\`\`${record.example.language}`,
      record.example.code,
      '```',
    )
  }
  if (record.pitfalls.length > 0) {
    lines.push('', '## Pitfalls', ...record.pitfalls.map(item => `- ${item}`))
  }
  if (record.verify.length > 0) {
    lines.push('', '## How to verify', ...record.verify.map(item => `- ${item}`))
  }
  if (record.conflictsWith !== undefined && record.conflictsWith.length > 0) {
    lines.push(
      '',
      '## Alternatives for the same trigger',
      ...record.conflictsWith.map(id => `- Also see technique \`${id}\` (same trigger, different approach)`),
    )
  }
  lines.push('')

  return { name, description, markdown: lines.join('\n') }
}

/** 前言解析结果。 */
export interface SkillFrontmatter {
  /** 顶层键值（`metadata` 以原文保留）。 */
  values: Record<string, string>
  /** 出现过的全部顶层键，按出现顺序。 */
  keys: string[]
  /** 正文（前言之后的内容）。 */
  body: string
}

/**
 * 解析 `SKILL.md` 前言。
 *
 * 只支持加载器实际使用的写法：`key: value` 与二级缩进的 `metadata` 块。
 * 不做通用 YAML 解析 —— 引入 YAML 依赖与「零第三方运行时依赖」冲突，
 * 而这里只需要能自检我们自己生成的内容。
 *
 * @param markdown - 完整文档。
 * @returns 解析结果；缺少前言时 `undefined`。
 */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatter | undefined {
  const lines = markdown.split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return undefined
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return undefined

  const values: Record<string, string> = {}
  const keys: string[] = []
  let metadataDepth = 0
  for (const line of lines.slice(1, end)) {
    if (line.trim().length === 0) continue
    const nested = /^\s+/u.test(line)
    if (nested) {
      if (metadataDepth > 0) values.metadata = `${values.metadata ?? ''}${line.trim()}; `
      continue
    }
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(line)
    if (match === null) continue
    const key = match[1] as string
    keys.push(key)
    values[key] = (match[2] ?? '').trim()
    metadataDepth = key === 'metadata' ? 1 : 0
  }

  return { values, keys, body: lines.slice(end + 1).join('\n') }
}

/** 校验结果。 */
export type SkillValidation = { ok: true } | { ok: false; problems: string[] }

/**
 * 自检生成的 `SKILL.md` 是否合法。
 *
 * 导出前必须跑一次：宁可不导出，也不要在目标 harness 里留下一个「装上了但不生效」的技能。
 *
 * @param markdown - 完整文档。
 * @returns 校验结果。
 */
export function verifySkill(markdown: string): SkillValidation {
  const problems: string[] = []
  const front = parseSkillFrontmatter(markdown)
  if (front === undefined) return { ok: false, problems: ['缺少 --- 包裹的前言'] }

  const name = front.values.name ?? ''
  if (!SKILL_NAME_RE.test(name)) {
    problems.push(`name 不合法（须为 1–64 位 ASCII 字母/数字/连字符/下划线）："${name}"`)
  }
  const description = front.values.description ?? ''
  if (description.length === 0) problems.push('description 为空（它是唯一被检索索引的字段）')
  else if (description.length > SKILL_DESCRIPTION_MAX) {
    problems.push(`description 超过 ${SKILL_DESCRIPTION_MAX} 字符`)
  }
  if (description.includes('\n')) problems.push('description 不得跨行')

  for (const key of front.keys) {
    if (!SKILL_FRONTMATTER_KEYS.includes(key)) {
      problems.push(`前言键 "${key}" 不在加载器接受的集合内，会被丢弃`)
    }
  }
  if (front.body.trim().length === 0) problems.push('正文为空')

  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}

/** 压成单行并截断。 */
function clampOneLine(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/gu, ' ').trim()
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`
}
