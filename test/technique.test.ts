/**
 * 技巧层测试：存储合并、状态迁移、调用面索引与召回过滤。
 *
 * @module dsh-memory-layer/test/technique.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryStore,
  TECHNIQUE_FILE,
  emptyMetrics,
  scopeDirName,
  techniqueKey,
  techniqueText,
} from '../src/store.js'
import { applyOutcome, confidenceOf, injectable, symbolIndex, techniqueIndexLine, techniqueSymbols } from '../src/technique.js'
import { recallTechniques, toTechniqueDocs } from '../src/recall.js'
import type { TechniqueDraft, TechniqueRecord } from '../src/types.js'

/** 建一个临时记忆库，并在用例结束时清理。 */
async function withStore(run: (store: MemoryStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-technique-test-'))
  try {
    await run(new MemoryStore(root), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 造一条技巧草稿。 */
function draft(overrides: Partial<TechniqueDraft> = {}): TechniqueDraft {
  return {
    kind: 'api-usage',
    name: '调用 OrdersClient 前必须先 authorize',
    when: '首次集成 OrdersClient',
    summary: 'OrdersClient 的调用需要先完成授权，否则返回 401 而不是抛错。',
    stack: { languages: ['java'] },
    pitfalls: [],
    verify: [],
    tags: [],
    evidence: [],
    ...overrides,
  }
}

/** 造一条完整技巧记录。 */
function record(overrides: Partial<TechniqueRecord> = {}): TechniqueRecord {
  return {
    id: 'tq_1',
    ts: 1,
    updatedAt: 1,
    scope: 'global',
    partition: 'default',
    kind: 'api-usage',
    status: 'draft',
    sensitivity: 'internal',
    name: 'name',
    when: 'when',
    summary: 'summary',
    pitfalls: [],
    verify: [],
    stack: { languages: ['java'] },
    tags: [],
    evidence: [],
    deidentified: true,
    hits: 1,
    applied: 0,
    successes: 0,
    failures: 0,
    provenance: 'model',
    ...overrides,
  }
}

// ---- 存储 -------------------------------------------------------------------

test('techniqueKey 归一化标点、空白与大小写，但不混淆不同触发条件', () => {
  assert.equal(
    techniqueKey('调用 OrdersClient', '首次集成'),
    techniqueKey('调用  ordersclient。', '首次集成'),
  )
  assert.notEqual(
    techniqueKey('调用 OrdersClient', '首次集成'),
    techniqueKey('调用 OrdersClient', '批量重试'),
  )
})

test('技巧层空库读取返回空数组', async () => {
  await withStore(async store => {
    assert.deepEqual(await store.readTechniques('global'), [])
  })
})

test('同一条技巧再次观察时合并而不是新增，并累加命中', async () => {
  await withStore(async store => {
    const first = await store.upsertTechniques([draft()], {
      scope: 'global', sessionId: 's1', provenance: 'model', now: 100,
    })
    assert.equal(first.created, 1)
    assert.equal(first.merged, 0)
    assert.equal(first.records[0]?.hits, 1)

    const second = await store.upsertTechniques(
      [draft({ tags: ['retry'], pitfalls: ['忘记设置幂等键'] })],
      { scope: 'global', sessionId: 's2', provenance: 'model', now: 200 },
    )
    assert.equal(second.created, 0)
    assert.equal(second.merged, 1)
    assert.equal(second.records.length, 1, '同一身份只保留一条')
    assert.equal(second.records[0]?.hits, 2)
    assert.equal(second.records[0]?.id, first.records[0]?.id, 'id 保持稳定')
    assert.deepEqual(second.records[0]?.tags, ['retry'])
    assert.deepEqual(second.records[0]?.pitfalls, ['忘记设置幂等键'])
    // 证据按来源会话累积，形成跨项目佐证。
    assert.deepEqual(second.records[0]?.evidence.map(item => item.sessionId), ['s1', 's2'])
  })
})

test('状态与敏感级别在合并时只升不降', async () => {
  await withStore(async store => {
    await store.upsertTechniques([draft({ status: 'validated', sensitivity: 'internal' })], {
      scope: 'global', sessionId: 's1', provenance: 'model',
    })
    const merged = await store.upsertTechniques([draft({ status: 'draft', sensitivity: 'confidential' })], {
      scope: 'global', sessionId: 's2', provenance: 'model',
    })
    assert.equal(merged.records[0]?.status, 'validated', '草稿不得把已验证记录降级')
    assert.equal(merged.records[0]?.sensitivity, 'confidential', '敏感级别取更严格的一方')
  })
})

test('技巧落盘为一行一个 JSON，且加密时同样按行可解', async () => {
  await withStore(async store => {
    await store.upsertTechniques([draft(), draft({ name: '另一条', when: '另一个时机' })], {
      scope: 'global', sessionId: 's1', provenance: 'model',
    })
    const raw = await readFile(join(store.scopeDir('global'), TECHNIQUE_FILE), 'utf8')
    const lines = raw.trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0] as string).name, '调用 OrdersClient 前必须先 authorize')
  })
})

test('技巧文件权限仅属主可读写', async () => {
  await withStore(async store => {
    await store.upsertTechniques([draft()], { scope: 'global', sessionId: 's1', provenance: 'model' })
    const file = await stat(join(store.scopeDir('global'), TECHNIQUE_FILE))
    assert.equal(file.mode & 0o077, 0, `文件权限过宽：${(file.mode & 0o777).toString(8)}`)
  })
})

test('全局域按分区落在不同目录，默认分区沿用历史路径', async () => {
  assert.equal(scopeDirName('global', '/work/a'), 'global')
  assert.equal(scopeDirName('global', '/work/a', 'default'), 'global')
  assert.equal(scopeDirName('global', '/work/a', 'Acme Corp'), join('global', 'acme-corp'))

  await withStore(async store => {
    await store.upsertTechniques([draft()], {
      scope: 'global', partition: 'acme', sessionId: 's1', provenance: 'model',
    })
    assert.equal((await store.readTechniques('global', undefined, 'acme')).length, 1)
    assert.equal((await store.readTechniques('global')).length, 0, '默认分区不串味')
  })
})

test('updateTechnique 原地替换而不累加命中', async () => {
  await withStore(async store => {
    const created = await store.upsertTechniques([draft()], { scope: 'global', sessionId: 's1', provenance: 'human' })
    const target = created.records[0]
    assert.ok(target !== undefined)
    const updated = { ...target, status: 'validated' as const, hits: target.hits, successes: 1 }
    assert.equal(await store.updateTechnique(updated), true)
    const reloaded = await store.readTechniques('global')
    assert.equal(reloaded[0]?.status, 'validated')
    assert.equal(reloaded[0]?.hits, 1, '回报结果不应被当成又一次观察')
    assert.equal(await store.updateTechnique({ ...updated, id: 'tq_missing' }), false)
  })
})

test('forgetTechnique 支持按 id 删除与整域清空', async () => {
  await withStore(async store => {
    const created = await store.upsertTechniques([draft()], { scope: 'global', sessionId: 's1', provenance: 'human' })
    const id = created.records[0]?.id ?? ''
    assert.equal(await store.forgetTechnique('global', undefined, undefined, 'tq_none'), 0)
    assert.equal(await store.forgetTechnique('global', undefined, undefined, id), 1)
    await store.upsertTechniques([draft()], { scope: 'global', sessionId: 's2', provenance: 'human' })
    assert.equal(await store.forgetTechnique('global', undefined, undefined, '*'), 1)
    assert.equal((await store.readTechniques('global')).length, 0)
  })
})

test('反思指标可落盘并读回，缺失时给出初值', async () => {
  await withStore(async store => {
    assert.deepEqual(await store.readMetrics(), emptyMetrics())
    await store.saveMetrics({ ...emptyMetrics(), reflections: 3, newTechniques: 2, emptyStreak: 1 })
    const loaded = await store.readMetrics()
    assert.equal(loaded.reflections, 3)
    assert.equal(loaded.newTechniques, 2)
    assert.equal(loaded.emptyStreak, 1)
  })
})

test('技巧的可检索文本不含示例代码', () => {
  const text = techniqueText(record({
    name: '注册方块',
    example: { language: 'java', kind: 'usage', code: 'Registry.register(SECRET_TOKEN)' },
  }))
  assert.match(text, /注册方块/u)
  assert.ok(!text.includes('SECRET_TOKEN'), '示例是说明，不该主导检索')
})

// ---- 领域逻辑 ---------------------------------------------------------------

test('置信度用拉普拉斯平滑，未采用时为中性', () => {
  assert.equal(confidenceOf(record()), 0.5)
  assert.equal(confidenceOf(record({ successes: 3, failures: 0 })), (3 + 1) / (3 + 0 + 2))
  assert.ok(confidenceOf(record({ successes: 1, failures: 4 })) < 0.5)
})

test('一次成功即从草稿升为已验证，三次成功且有代码证据才成为 canonical', () => {
  let current = record()
  current = applyOutcome(current, 'success', 10)
  assert.equal(current.status, 'validated')
  assert.equal(current.lastVerifiedAt, 10)

  current = applyOutcome(current, 'success', 20)
  current = applyOutcome(current, 'success', 30)
  assert.equal(current.status, 'validated', '缺少代码证据时不能成为 canonical')

  current = record({ successes: 2, evidence: [{ kind: 'code', repo: 'demo' }] })
  current = applyOutcome(current, 'success', 40)
  assert.equal(current.status, 'canonical')
})

test('连续失败会废弃，且废弃是粘性终态', () => {
  let current = record({ successes: 1, status: 'validated' })
  current = applyOutcome(current, 'failure', 10)
  assert.equal(current.status, 'validated', '一次失败还不至于废弃')
  current = applyOutcome(current, 'failure', 20)
  assert.equal(current.status, 'deprecated')
  current = applyOutcome(current, 'success', 30)
  assert.equal(current.status, 'deprecated', '废弃后不再自动复活')
})

test('调用面索引与索引行', () => {
  const withApi = record({
    id: 'tq_api',
    name: 'authorize 前置',
    when: '首次集成',
    api: [
      { symbol: 'OrdersClient.authorize', signature: 'authorize(token)', notes: '先于 create' },
      { symbol: 'OrdersClient.create' },
    ],
    status: 'validated',
    stack: { languages: ['java'] },
  })
  assert.deepEqual(techniqueSymbols(withApi), ['OrdersClient.authorize', 'OrdersClient.create'])
  const index = symbolIndex([withApi])
  assert.deepEqual(index.get('OrdersClient.create'), ['tq_api'])
  const line = techniqueIndexLine(withApi)
  assert.match(line, /authorize 前置/u)
  assert.match(line, /\[validated\]/u)
  assert.match(line, /java/u)
  assert.match(line, /tq_api/u)
  assert.equal(injectable(withApi), true)
  assert.equal(injectable(record({ status: 'draft' })), false)
  assert.equal(injectable(record({ status: 'deprecated' })), false)
})

// ---- 召回 -------------------------------------------------------------------

test('技巧召回：草稿默认不参与，显式检索时可见', () => {
  const docs = toTechniqueDocs([
    record({ id: 'tq_draft', name: '草稿技巧', when: '草稿时机', summary: '草稿说明', status: 'draft' }),
    record({ id: 'tq_ok', name: '已验证技巧', when: '验证时机', summary: '验证说明', status: 'validated' }),
  ])
  const injectableOnly = recallTechniques('技巧', docs, { stack: { languages: ['java'] } })
  assert.deepEqual(injectableOnly.map(hit => hit.id), ['tq_ok'])

  const withDrafts = recallTechniques('草稿', docs, { stack: { languages: ['java'] }, includeDrafts: true })
  assert.deepEqual(withDrafts.map(hit => hit.id), ['tq_draft'])
})

test('技巧召回：技术栈不匹配直接过滤，而不是降权', () => {
  const docs = toTechniqueDocs([
    record({ id: 'tq_java', name: 'Java 技巧', when: 'java 时机', summary: 'java 说明', status: 'validated', stack: { languages: ['java'] } }),
  ])
  assert.equal(recallTechniques('技巧', docs, { stack: { languages: ['typescript'] } }).length, 0)
  assert.equal(recallTechniques('技巧', docs, { stack: { languages: ['java'] } }).length, 1)
})

test('技巧召回：分区不同不串味', () => {
  const docs = toTechniqueDocs([
    record({ id: 'tq_a', name: '客户技巧', when: '客户时机', summary: '客户说明', status: 'validated', partition: 'acme' }),
  ])
  assert.equal(recallTechniques('技巧', docs, { partition: 'other' }).length, 0)
  assert.equal(recallTechniques('技巧', docs, { partition: 'acme' }).length, 1)
})

test('技巧召回：调用名精确命中显著加权', () => {
  const docs = toTechniqueDocs([
    record({
      id: 'tq_api',
      name: 'authorize 前置',
      when: '集成时',
      summary: '调用前需要授权',
      status: 'validated',
      api: [{ symbol: 'OrdersClient.create' }],
    }),
  ])
  const plain = recallTechniques('集成 authorize', docs, {})[0]?.score ?? 0
  const boosted = recallTechniques('集成 authorize', docs, { symbols: ['OrdersClient.create'] })[0]?.score ?? 0
  assert.ok(boosted > plain, '符号命中应提升得分')
  assert.ok(Math.abs(boosted / plain - 1.6) < 1e-6, '加成为 1.6 倍')
})

test('技巧召回：无命中时返回空，由调用方决定不注入', () => {
  const docs = toTechniqueDocs([record({ name: '唯一技巧', when: '唯一时机', summary: '唯一说明', status: 'validated' })])
  assert.deepEqual(recallTechniques('完全无关的词汇 zzzz', docs, {}), [])
})
