/**
 * 召回层测试：中英分词、BM25 排序与空查询回退。
 *
 * @module dsh-memory-layer/test/recall.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStandingRule, recall, recallDocsFacets, recallFacets, recallTechniques, toDocs, toTechniqueDocs, tokenize } from '../src/recall.js'
import type { EpisodicRecord, SemanticRecord, TechniqueRecord } from '../src/types.js'

/** 造一条情景记录。 */
function episodic(overrides: Partial<EpisodicRecord> = {}): EpisodicRecord {
  return {
    id: 'ep_1',
    ts: 1_700_000_000_000,
    sessionId: 's1',
    scope: 'project',
    title: '',
    summary: '',
    decisions: [],
    todos: [],
    files: [],
    tags: [],
    source: 'rule',
    ...overrides,
  }
}

/** 造一条语义记录。 */
function semantic(overrides: Partial<SemanticRecord> = {}): SemanticRecord {
  return {
    id: 'sm_1',
    ts: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    scope: 'project',
    kind: 'fact',
    key: 'k',
    text: '',
    hits: 1,
    sources: [],
    tags: [],
    ...overrides,
  }
}

test('中文切成相邻二字 bigram', () => {
  assert.deepEqual(tokenize('跨会话记忆'), ['跨会', '会话', '话记', '记忆'])
})

test('英文按词切分、去停用词、保留数字', () => {
  assert.deepEqual(tokenize('The plugin uses TypeScript 2026'), ['plugin', 'uses', 'typescript', '2026'])
})

test('中英混排各自成 token', () => {
  const tokens = tokenize('使用 pnpm 安装')
  assert.ok(tokens.includes('pnpm'))
  assert.ok(tokens.includes('使用'))
  assert.ok(tokens.includes('安装'))
})

test('相关记忆排在前面', () => {
  const docs = toDocs(
    [
      episodic({ id: 'ep_a', summary: '讨论了数据库索引优化' }),
      episodic({ id: 'ep_b', summary: '用户偏好使用 pnpm 而不是 npm' }),
    ],
    [],
  )
  const hits = recall('pnpm 还是 npm', docs, { limit: 2 })
  assert.equal(hits[0]?.id, 'ep_b')
})

test('语义层在同等命中下优先于情景层', () => {
  const docs = toDocs(
    [episodic({ id: 'ep_a', summary: 'pnpm 配置' })],
    [semantic({ id: 'sm_a', text: 'pnpm 配置' })],
  )
  const hits = recall('pnpm', docs, { limit: 2 })
  assert.equal(hits[0]?.layer, 'semantic')
  assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0))
})

test('无命中时返回空数组，便于调用方决定不注入', () => {
  const docs = toDocs([episodic({ summary: '数据库索引' })], [])
  assert.deepEqual(recall('量子计算', docs, { limit: 3 }), [])
})

test('空查询退化为最近记忆', () => {
  const docs = toDocs(
    [
      episodic({ id: 'old', ts: 1_000 }),
      episodic({ id: 'new', ts: 9_000 }),
    ],
    [],
  )
  const hits = recall('   ', docs, { limit: 1 })
  assert.equal(hits[0]?.id, 'new')
})

test('limit 为 0 或空库时返回空', () => {
  assert.deepEqual(recall('pnpm', [], { limit: 3 }), [])
  assert.deepEqual(recall('pnpm', toDocs([episodic({ summary: 'pnpm' })], []), { limit: 0 }), [])
})

test('新鲜度加权让更近的记忆在同等命中下得分更高', () => {
  const now = 1_800_000_000_000
  const docs = toDocs(
    [
      episodic({ id: 'stale', summary: 'pnpm 配置', ts: now - 90 * 24 * 3600 * 1000 }),
      episodic({ id: 'fresh', summary: 'pnpm 配置', ts: now }),
    ],
    [],
  )
  const hits = recall('pnpm', docs, { limit: 2, now })
  assert.equal(hits[0]?.id, 'fresh')
})

test('情景文档带出 sessionId，供注入侧挡掉本会话自己的摘要', () => {
  const docs = toDocs([episodic({ id: 'ep_a', sessionId: 's-a' }), episodic({ id: 'ep_b', sessionId: 's-b' })], [])
  assert.equal(docs[0]?.meta?.sessionId, 's-a')
  assert.equal(docs[1]?.meta?.sessionId, 's-b')
  // 语义层没有会话归属，不该凭空造一个。
  const sem = toDocs([], [{ id: 'sm_1', key: 'k', kind: 'fact', text: 't', hits: 1, sources: ['s1'], tags: [], ts: 1, updatedAt: 1, scope: 'global', partition: 'default' }])
  assert.equal(sem[0]?.meta?.sessionId, undefined)
})

test('toDocs 的作用域标记取自调用方给的桶，而不是记录里的 scope 字段', () => {
  // 记录里写着 `global`，但调用方说这批来自项目桶（两个桶是两个目录，桶才是事实来源）：
  // 标记必须听调用方的，否则 `memory_search(scope)` 会按一条冗余字段把结果放错作用域。
  const episodicRecord = episodic({ id: 'ep_p', scope: 'global' })
  const semanticRecord = { id: 'sm_g', key: 'k', kind: 'fact' as const, text: 't', hits: 1, sources: ['s1'], tags: [], ts: 1, updatedAt: 1, scope: 'project' as const, partition: 'default' }
  assert.equal(toDocs([episodicRecord], [], 'project')[0]?.meta?.scope, 'project')
  assert.equal(toDocs([], [semanticRecord], 'global')[0]?.meta?.scope, 'global')
  // 不传作用域时保持原样（老调用方与注入路径不受影响）。
  assert.equal(toDocs([episodicRecord], [])[0]?.meta?.scope, undefined)
})

/** 造一条已验证的技巧记录。 */
function technique(overrides: Partial<TechniqueRecord> = {}): TechniqueRecord {
  return {
    id: 'tq_1',
    ts: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    scope: 'global',
    partition: 'default',
    kind: 'procedure',
    status: 'validated',
    sensitivity: 'internal',
    name: 'name',
    when: 'when',
    summary: 'summary',
    pitfalls: [],
    verify: [],
    stack: { languages: [] },
    tags: [],
    evidence: [],
    deidentified: true,
    hits: 0,
    applied: 1,
    successes: 1,
    failures: 0,
    provenance: 'model',
    ...overrides,
  }
}

test('相关性门槛：只中一个常见词的弱命中被丢掉，命中领域词的保留', () => {
  // 真库实测的不相关轮次都是「四五个词里只中一个」（如「把函数重命名」只共享了 config），
  // 那种命中正是「每轮白白注入 736–1056 字符」的来源。
  const strong = technique({
    id: 'tq_strong',
    name: 'PlantUML 组件图连接方向',
    when: '画组件图时',
    summary: '单横线水平、双横线竖直。',
    domain: 'plantuml',
  })
  const weak = technique({ id: 'tq_weak', name: 'config default', when: 'adding config', summary: 'Give the config option a default.' })
  const docs = toTechniqueDocs([strong, weak])
  const query = 'rename this function for clarity and add a config flag'
  const ids = (hits: readonly { id: string }[]): string[] => hits.map(hit => hit.id)
  const unfiltered = recallTechniques(query, docs, { limit: 5, now: 1_700_000_000_000 })
  assert.deepEqual(ids(unfiltered), ['tq_weak'], '不设门槛时弱命中照旧返回（老行为）')
  const filtered = recallTechniques(query, docs, { limit: 5, now: 1_700_000_000_000, gate: { minMatched: 2 } })
  assert.deepEqual(ids(filtered), [], '只中一个词 → 丢掉')
  // 相关查询不受影响：门槛只做「减法」。
  const onTopic = recallTechniques('PlantUML 组件图连接方向怎么画', docs, { limit: 5, now: 1_700_000_000_000, gate: { minMatched: 2 } })
  assert.deepEqual(ids(onTopic), ['tq_strong'])
})

test('门槛不得用小语料误杀相关命中：分数会随库规模缩水，命中词数不会', () => {
  // 这条是设计动机的回归锁：同一条相关命中在 354 条的库里是 2.47 分（真库 9.28），
  // 在 2 条的库里只有 0.5 分。所以默认门槛**不能**是绝对分数 —— 否则新装的小库
  // 会把所有技巧都判成不相关，技巧层静默失效。
  const docs = toTechniqueDocs([technique({
    id: 'tq_only',
    name: 'PlantUML 组件图连接方向',
    when: '画组件图时',
    summary: '单横线水平、双横线竖直。',
  })])
  const query = 'PlantUML 组件图连接方向怎么画'
  const byMatched = recallTechniques(query, docs, { limit: 5, now: 1_700_000_000_000, gate: { minMatched: 2 } })
  assert.deepEqual(byMatched.map(hit => hit.id), ['tq_only'], '命中词数达标 → 保留')
  // 同一份数据、同一条查询，若门槛误设成绝对分数就会一条不剩。
  const byScore = recallTechniques(query, docs, { limit: 5, now: 1_700_000_000_000, gate: { minScore: 4 } })
  assert.deepEqual(byScore, [], '绝对分数门槛在小语料上会把相关命中一起杀掉（故默认关闭）')
})

test('门槛对记忆层同样生效：只中一个词的情景摘要不进注入', () => {
  // 记忆与技巧在这一点上是同一个病：BM25 只要共享一个常见词就给分。区别只在
  // 「不相关的那一条」对记忆而言同样是纯噪声 —— 实测里一个不相关的轮次仍注入了
  // 903 字符的记忆条目，而它对本轮任务没有任何信息量。
  const docs = toDocs([episodic({ id: 'ep_weak', summary: 'pnpm 相关问题汇总', ts: 1_700_000_000_000 })], [])
  const gate = { minMatched: 2 }
  const query = 'pnpm config lockfile 策略是什么'
  assert.equal(recallDocsFacets(query, docs, { limit: 5, now: 1_700_000_000_000 }).length, 1, '不设门槛时照旧返回')
  assert.deepEqual(recallDocsFacets(query, docs, { limit: 5, now: 1_700_000_000_000, gate }), [], '只中一个词 → 丢掉')
})

test('isStandingRule 只认语义层的偏好与约束', () => {
  // 这个判定只服务于注入路径（常驻规则从检索语料里摘出来单独直取），因此它属于召回层：
  // 谁是常驻规则由一个地方说了算。事实与决定是「关于某件事的陈述」，只在相关时才有价值。
  const docs = toDocs([episodic({ id: 'ep_1', summary: 's' })], [
    semantic({ id: 'sm_p', kind: 'preference', text: 't' }),
    semantic({ id: 'sm_c', kind: 'constraint', text: 't' }),
    semantic({ id: 'sm_f', kind: 'fact', text: 't' }),
    semantic({ id: 'sm_d', kind: 'decision', text: 't' }),
  ])
  const standing = docs.filter(doc => isStandingRule(doc)).map(doc => doc.id)
  assert.deepEqual(standing, ['sm_p', 'sm_c'])
})

test('门槛只作用于自动注入：显式检索（不传 gate）行为完全不变', () => {
  const weak = technique({ id: 'tq_w', name: 'config default', when: 'adding config', summary: 'Give the config option a default.' })
  const docs = toTechniqueDocs([weak])
  const gated = recallFacets('add a config flag', docs, { limit: 3, now: 1_700_000_000_000, gate: { minMatched: 2 } })
  assert.deepEqual(gated, [], '注入路径上被门槛丢掉')
  // 工具显式检索走的就是这条（不传 gate）：模型主动要的东西一条不少。
  const explicit = recallFacets('add a config flag', docs, { limit: 3, now: 1_700_000_000_000 })
  assert.deepEqual(explicit.map(hit => hit.id), ['tq_w'])
})

test('短查询自动放宽：两词查询只中一个词不算「不相关」', () => {
  // `PlantUML 中文` 这种两词查询只命中一个词，可能正是正确答案；按 2 硬卡会误杀。
  const docs = toTechniqueDocs([technique({ id: 'tq_cjk', name: 'CJK 图渲染', when: '中文乱码时', summary: '显式指定 -charset UTF-8。' })])
  const hits = recallTechniques('PlantUML 中文', docs, { limit: 5, now: 1_700_000_000_000, gate: { minMatched: 2 } })
  assert.deepEqual(hits.map(hit => hit.id), ['tq_cjk'])
})
