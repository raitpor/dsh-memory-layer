/**
 * P4 测试：同触发另解标记、`SKILL.md` 渲染与自检。
 *
 * 导出是本插件唯一会**写进别人的目录**的动作，所以自检必须严：
 * 前言键不在加载器接受的集合内、名字不合法、描述为空，都会导致
 * 「装上了但不生效」—— 这比导出失败更糟，因为它没有报错。
 *
 * @module dsh-memory-layer/test/skill.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SKILL_FRONTMATTER_KEYS,
  parseSkillFrontmatter,
  renderSkill,
  skillDescriptionOf,
  skillNameOf,
  verifySkill,
} from '../src/skill.js'
import { assignConflicts } from '../src/store.js'
import { techniqueIndexLine } from '../src/technique.js'
import type { TechniqueRecord } from '../src/types.js'

/** 造一条技巧记录。 */
function record(overrides: Partial<TechniqueRecord> = {}): TechniqueRecord {
  return {
    id: 'tq_abcdef12-3456-7890-abcd-ef1234567890',
    ts: 1,
    updatedAt: 1,
    scope: 'global',
    partition: 'default',
    kind: 'api-usage',
    status: 'validated',
    sensitivity: 'internal',
    name: 'authorize before create',
    when: 'integrating the orders client',
    summary: 'Call authorize before create, otherwise the client returns 401 instead of throwing.',
    steps: ['Call authorize with the token', 'Then call create'],
    api: [{ symbol: 'OrdersClient.authorize', signature: 'authorize(token)', notes: 'must precede create' }],
    example: { language: 'java', kind: 'usage', code: 'OrdersClient.authorize(token);' },
    pitfalls: ['create without authorize returns 401'],
    verify: ['no 401 from the first call'],
    stack: { languages: ['java'] },
    tags: ['orders'],
    evidence: [{ kind: 'code', repo: 'demo', role: 'api-client' }],
    deidentified: true,
    hits: 1,
    applied: 1,
    successes: 1,
    failures: 0,
    provenance: 'model',
    ...overrides,
  }
}

// ---- 同触发另解 -------------------------------------------------------------

test('同一触发条件下的多条技巧互相标记，孤例不标记', () => {
  // 判定标准是「触发条件归一化后相同」——标点与大小写等价，措辞不同则不合并。
  const left = record({ id: 'tq_a', when: 'integrating the orders client' })
  const right = record({ id: 'tq_b', when: 'Integrating the Orders Client!', name: '另一种做法' })
  const alone = record({ id: 'tq_c', when: 'a completely different trigger' })
  assignConflicts([left, right, alone])

  assert.deepEqual(left.conflictsWith, ['tq_b'], '同一触发、不同做法应互相可见')
  assert.deepEqual(right.conflictsWith, ['tq_a'], '标记是双向的')
  assert.equal(alone.conflictsWith, undefined)
})

test('已解决的记录退出另解集合，且旧标记会被清空', () => {
  const left = record({ id: 'tq_a', when: 'same trigger here' })
  const right = record({ id: 'tq_b', when: 'same trigger here' })
  assignConflicts([left, right])
  assert.deepEqual(left.conflictsWith, ['tq_b'])

  right.status = 'deprecated'
  assignConflicts([left, right])
  assert.equal(left.conflictsWith, undefined, '解决一条后不得残留幽灵分歧')
  assert.equal(right.conflictsWith, undefined, '已解决的记录本身也不参与')
})

test('索引行会提示「同一触发下另有做法」', () => {
  const withConflict = record({ conflictsWith: ['tq_other'] })
  assert.match(techniqueIndexLine(withConflict), /同一触发下另有做法: tq_other/u)
  assert.ok(!techniqueIndexLine(record()).includes('另有做法'))
})

// ---- 命名与描述 -------------------------------------------------------------

test('skill 名合法且不碰撞（中文名回退到 technique-<id>）', () => {
  const ascii = skillNameOf(record())
  assert.match(ascii, /^[a-z0-9-]+$/u)
  assert.match(ascii, /^authorize-before-create-[0-9a-f]{8}$/u)

  const chinese = skillNameOf(record({ name: '注册方块的最小集合' }))
  assert.match(chinese, /^technique-[0-9a-f]{8}$/u, '非 ASCII 名 slug 后为空，必须回退')

  // 同名不同 id 必须得到不同 skill 名，否则安装时会静默互相覆盖。
  const first = skillNameOf(record({ id: 'tq_11111111-1111-1111-1111-111111111111' }))
  const second = skillNameOf(record({ id: 'tq_22222222-2222-2222-2222-222222222222' }))
  assert.notEqual(first, second)
  assert.ok(first.length <= 64)
})

test('描述是单行，且包含语义检索需要的触发词', () => {
  const description = skillDescriptionOf(record())
  assert.ok(!description.includes('\n'))
  assert.match(description, /authorize before create/u)
  assert.match(description, /Use when: integrating the orders client/u)
  assert.match(description, /orders/u)
})

// ---- 渲染与自检 -------------------------------------------------------------

test('渲染出的 SKILL.md 前言只含加载器接受的键且通过自检', () => {
  const rendered = renderSkill(record(), { allowedTools: ['read_file'] })
  const check = verifySkill(rendered.markdown)
  assert.deepEqual(check, { ok: true })

  const front = parseSkillFrontmatter(rendered.markdown)
  assert.ok(front !== undefined)
  for (const key of front.keys) {
    assert.ok(SKILL_FRONTMATTER_KEYS.includes(key), `前言键 "${key}" 会被加载器丢弃`)
  }
  assert.equal(front.values.name, rendered.name)
  assert.equal(front.values['allowed-tools'], '[read_file]')
  assert.match(front.body, /# authorize before create/u)
  assert.match(rendered.markdown, /```java/u)
  assert.match(rendered.markdown, /## Pitfalls/u)
  assert.match(rendered.markdown, /illustrative only/u, '示例必须标注仅供参考')
})

test('自检能拦下会「装上了但不生效」的文档', () => {
  assert.equal(verifySkill('# 没有前言').ok, false)
  const noDescription = renderSkill(record()).markdown.replace(/^description:.*$/mu, '')
  const badDescription = verifySkill(noDescription)
  assert.equal(badDescription.ok, false)
  assert.ok(!badDescription.ok && badDescription.problems.some(item => item.includes('description')))

  const badName = renderSkill(record()).markdown.replace(/^name:.*$/mu, 'name: 中文名')
  const nameCheck = verifySkill(badName)
  assert.equal(nameCheck.ok, false)

  const extraKey = renderSkill(record()).markdown.replace('tags:', 'disable-model-invocation: true\ntags:')
  const extraCheck = verifySkill(extraKey)
  assert.equal(extraCheck.ok, false)
  assert.ok(!extraCheck.ok && extraCheck.problems.some(item => item.includes('disable-model-invocation')))
})

test('缺少前言时解析返回 undefined', () => {
  assert.equal(parseSkillFrontmatter('随便一段文本'), undefined)
  assert.equal(parseSkillFrontmatter('---\nname: x\n'), undefined, '未闭合的前言应被拒绝')
})

test('另解会写进导出产物，便于跨 harness 看到分歧', () => {
  const rendered = renderSkill(record({ conflictsWith: ['tq_other'] }))
  assert.match(rendered.markdown, /Alternatives for the same trigger/u)
  assert.match(rendered.markdown, /tq_other/u)
})
