/**
 * SQLite/FTS5 索引测试。
 *
 * 重点验三件事：
 * 1. **中文能命中** —— FTS5 开箱对中文无效，靠的是写入/查询同一套预分词；
 * 2. **过滤口径与内存路径一致** —— 状态、分区、语言三档；
 * 3. **失败必然可回退** —— 索引不可用/损坏/无 token 时返回 `undefined`，调用方走内存 BM25。
 *
 * `node:sqlite` 在旧 Node 上不存在，因此探测不到时整个文件跳过（不是失败）。
 *
 * @module dsh-memory-layer/test/sqlite-index
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteTechniqueIndex, loadSqlite, matchExpression, segment } from '../src/sqlite-index.js'
import { recallFacets, toTechniqueDocs } from '../src/recall.js'
import type { StackProfile, TechniqueKind, TechniqueRecord } from '../src/types.js'

const AVAILABLE = loadSqlite() !== undefined
const JAVA: StackProfile = { languages: ['java'] }

/** 造一条技巧记录。 */
function tech(id: string, name: string, when: string, summary: string, overrides: Partial<TechniqueRecord> = {}): TechniqueRecord {
  return {
    id,
    ts: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    scope: 'global',
    partition: 'default',
    kind: 'procedure' as TechniqueKind,
    status: 'validated',
    sensitivity: 'internal',
    name,
    when,
    summary,
    pitfalls: [],
    verify: [],
    stack: JAVA,
    tags: [],
    evidence: [],
    deidentified: true,
    hits: 1,
    applied: 0,
    successes: 0,
    failures: 0,
    provenance: 'human',
    ...overrides,
  }
}

const CORPUS: TechniqueRecord[] = [
  tech('tq_note', '序列图 note 的三种锚定语义', '注释放错位置时', 'note left 锚定消息，note right of 锚定参与者。'),
  tech('tq_charset', '读写 CJK 图时显式指定 -charset UTF-8', '标签渲染成问号时', '命令行加 -charset UTF-8 与文件编码对齐。'),
  tech('tq_discount', '折扣先算等级折扣再叠加活动折扣', '新增优惠玩法时', 'DiscountCalculator 顺序不可交换。', {
    subject: 'DiscountCalculator',
    appliesTo: 'module=settlement',
  }),
  tech('tq_draft', '草稿状态的技巧不该被默认检索到', '排查草稿时', '草稿只参与显式检索。', { status: 'draft' }),
  tech('tq_gone', '已废弃的技巧', '不该出现时', 'deprecated 必须被过滤。', { status: 'deprecated' }),
  tech('tq_other', 'Kotlin 项目的技巧', '在 kotlin 项目里', '语言不匹配就该被过滤。', {
    stack: { languages: ['kotlin'] },
  }),
]

/** 每个用例一个临时索引文件。 */
async function withIndex(run: (index: SqliteTechniqueIndex, file: string) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-index-'))
  const file = join(root, 'index.sqlite')
  const index = new SqliteTechniqueIndex(file)
  try {
    index.build(CORPUS)
    await run(index, file)
  } finally {
    index.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('SQLite 索引：中文查询能命中（靠预分词，不是靠 FTS5 默认行为）', { skip: !AVAILABLE }, async () => {
  // 先钉住事实：FTS5 的分词器对中文整句无效，所以必须我们自己分词。
  assert.equal(segment('注释放错位置'), segment('注释放错位置'), '预分词必须稳定')
  assert.ok(segment('注释放错位置').includes(' '), `中文应切成多个 token：${segment('注释放错位置')}`)
  await withIndex(index => {
    const hits = index.search('备注位置不对，想挂在参与者上', 3, { stack: JAVA })
    assert.ok(hits !== undefined && hits.includes('tq_note'), `中文查询应命中 tq_note：${JSON.stringify(hits)}`)
  })
})

test('SQLite 索引：字段加权让「代码单元名」命中排前', { skip: !AVAILABLE }, async () => {
  await withIndex(index => {
    const hits = index.search('DiscountCalculator', 3, { stack: JAVA })
    assert.equal(hits?.[0], 'tq_discount', `subject 权重最高，应排第一：${JSON.stringify(hits)}`)
  })
})

test('SQLite 索引：状态 / 分区 / 语言三档过滤与内存路径同口径', { skip: !AVAILABLE }, async () => {
  await withIndex(index => {
    const verified = index.search('技巧', 20, { stack: JAVA }) ?? []
    assert.ok(!verified.includes('tq_draft'), '默认不返回草稿')
    assert.ok(!verified.includes('tq_gone'), 'deprecated 必须被过滤')
    assert.ok(!verified.includes('tq_other'), '语言不匹配必须被过滤')

    const withDrafts = index.search('草稿', 20, { includeDrafts: true, stack: JAVA }) ?? []
    assert.ok(withDrafts.includes('tq_draft'), '显式检索时能看到草稿')

    const wrongPartition = index.search('DiscountCalculator', 5, { stack: JAVA, partition: 'other' })
    assert.ok(!(wrongPartition ?? []).includes('tq_discount'), '分区不同不得串味')
  })
})

test('SQLite 索引：语料签名未变时跳过重建，变了才重建', { skip: !AVAILABLE }, async () => {
  await withIndex(index => {
    assert.equal(index.build(CORPUS), false, '签名未变应跳过')
    const changed = [...CORPUS, tech('tq_new', '新写入的技巧', '新增时', '用来触发重建。')]
    assert.equal(index.build(changed), true, '语料变了应重建')
    const hits = index.search('新写入', 5, { stack: JAVA }) ?? []
    assert.ok(hits.includes('tq_new'), '重建后应能搜到新记录')
  })
})

test('SQLite 索引：不可用时返回 undefined，调用方回退内存 BM25', { skip: !AVAILABLE }, async () => {
  await withIndex((index, file) => {
    // 无 token 的查询（纯标点）：没有可匹配项，必须明确表示"请回退"。
    assert.equal(matchExpression('！！！'), '', '纯标点没有 token')
    assert.equal(index.search('！！！', 5), undefined, '无 token 时返回 undefined')

    // 索引被外部破坏（删表）：同样回退而不是把检索打挂。
    const broken = new SqliteTechniqueIndex(file)
    try {
      const handles = broken as unknown as { open(): { exec(sql: string): void } }
      handles.open().exec('DROP TABLE technique_index')
      assert.equal(broken.search('备注', 5, { stack: JAVA }), undefined, '索引损坏应回退')
    } finally {
      broken.close()
    }
  })
})

test('SQLite 索引：作为打分器接进 facet 召回，覆盖多个主题', { skip: !AVAILABLE }, async () => {
  const docs = toTechniqueDocs(CORPUS)
  await withIndex(index => {
    const scorer = (query: string, limit: number) => index.search(query, limit, { includeDrafts: false, stack: JAVA })
    const hits = recallFacets('先看折扣顺序，再确认备注位置，顺便查编码问题', docs, {
      limit: 5,
      stack: JAVA,
      scorer,
    }).map(hit => hit.id)
    assert.ok(hits.includes('tq_discount'), `折扣主题应在：${hits.join(', ')}`)
    assert.ok(hits.includes('tq_note'), `备注主题应在：${hits.join(', ')}`)
    assert.ok(hits.includes('tq_charset'), `编码主题应在：${hits.join(', ')}`)
    assert.equal(new Set(hits).size, hits.length, '不得重复')
  })
})

test('SQLite 索引：打分器返回 undefined 时 facet 召回归内存路径', { skip: !AVAILABLE }, async () => {
  const docs = toTechniqueDocs(CORPUS)
  const hits = recallFacets('折扣与备注', docs, { limit: 3, stack: JAVA, scorer: () => undefined })
  assert.ok(hits.length > 0, '打分器不可用时应回退内存 BM25 而不是空结果')
})
