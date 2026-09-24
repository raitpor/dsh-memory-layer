/**
 * 召回层测试：中英分词、BM25 排序与空查询回退。
 *
 * @module dsh-memory-layer/test/recall.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recall, toDocs, tokenize } from '../src/recall.js'
import type { EpisodicRecord, SemanticRecord } from '../src/types.js'

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
