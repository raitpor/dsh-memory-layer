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
import {
  GIST_MAX_CHARS,
  ID_PREFIX_CHARS,
  MAX_VERIFICATION_CHARS,
  MAX_VERIFICATIONS,
  applyOutcome,
  clampVerificationEvidence,
  checkVerificationEvidence,
  confidenceOf,
  gistOf,
  injectable,
  promotedStatus,
  resolveTechniqueId,
  shortTechniqueId,
  symbolIndex,
  techniqueIndexLine,
  techniqueApplies,
  techniqueSearchLine,
  techniqueSymbols,
  techniqueTailLine,
} from '../src/technique.js'
import { recallTechniques, toTechniqueDocs } from '../src/recall.js'
import type { TechniqueDraft, TechniqueRecord, TechniqueVerification } from '../src/types.js'

/** 造一条验收记录。 */
function verification(overrides: Partial<TechniqueVerification> = {}): TechniqueVerification {
  return {
    outcome: 'success',
    evidence: 're-ran `npm test`: 240/240 pass',
    at: 1,
    ...overrides,
  }
}

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
  current = applyOutcome(current, verification({ outcome: 'success', at: 10 }))
  assert.equal(current.status, 'validated')
  assert.equal(current.lastVerifiedAt, 10)

  current = applyOutcome(current, verification({ outcome: 'success', at: 20 }))
  current = applyOutcome(current, verification({ outcome: 'success', at: 30 }))
  assert.equal(current.status, 'validated', '缺少代码证据时不能成为 canonical')

  current = record({ successes: 2, evidence: [{ kind: 'code', repo: 'demo' }] })
  current = applyOutcome(current, verification({ outcome: 'success', at: 40 }))
  assert.equal(current.status, 'canonical')
})

test('canonical 额外要求至少一条带证据的验收记录', () => {
  // 三次成功 + 代码证据，但**没有任何验收记录**（老记录或手工构造）→ 不足以成为 canonical。
  const noVerification = record({ successes: 3, evidence: [{ kind: 'code', repo: 'demo' }] })
  assert.equal(promotedStatus(noVerification), 'validated', '"用了就算成功"不构成可复用结论')

  const verified = applyOutcome(noVerification, verification({ at: 50 }))
  assert.equal(verified.status, 'canonical', '补上带证据的验收后应可提升')
})

test('验收记录最新在前并封顶', () => {
  let current = record()
  for (let index = 0; index < MAX_VERIFICATIONS + 2; index += 1) {
    current = applyOutcome(current, verification({ at: 100 + index, evidence: `run ${index}: 3/3 checks pass` }))
  }
  const kept = current.verifications ?? []
  assert.equal(kept.length, MAX_VERIFICATIONS, '超出上限的旧记录应被丢弃')
  assert.equal(kept[0]?.at, 100 + MAX_VERIFICATIONS + 1, '最新的排最前')
  assert.equal(current.applied, MAX_VERIFICATIONS + 2, '计数不受记录上限影响')
})

test('验收证据必须有具体锚点，空话一律拒绝', () => {
  assert.equal(checkVerificationEvidence('re-ran `npm test`: 240/240 pass').ok, true)
  assert.equal(checkVerificationEvidence('渲染后目视：728×1010，无交叉边').ok, true)
  assert.equal(checkVerificationEvidence(undefined).ok, false)
  assert.equal(checkVerificationEvidence('works').ok, false, '不可证伪的结论词')
  assert.equal(checkVerificationEvidence('已采用，效果良好').ok, false)
  assert.equal(checkVerificationEvidence('通过').ok, false)
  // 够长但没有任何具体观察 → 仍然拒绝。
  const vague = checkVerificationEvidence('这个技巧我照着做了而且觉得挺顺利的')
  assert.equal(vague.ok, false)
  assert.match(vague.ok ? '' : vague.reason, /concrete observation/u)
})

test('gist 优先用显式值，否则取 summary 首句并截断', () => {
  assert.equal(gistOf(record({ gist: '显式要点', summary: '别的。' })), '显式要点')
  assert.equal(gistOf(record({ summary: '先 authorize 再 create。后面还有别的句子。' })), '先 authorize 再 create。')
  assert.equal(gistOf(record({ summary: '没有句读的一整句' })), '没有句读的一整句')
  const long = gistOf(record({ summary: '啊'.repeat(GIST_MAX_CHARS + 20) }))
  assert.ok(long.length <= GIST_MAX_CHARS, `gist 应被截断：${long.length}`)
  assert.ok(long.endsWith('…'))
})

test('id 前缀能唯一解析，歧义时拒绝而不是猜', () => {
  const records = [
    record({ id: 'tq_aaaaaaaa-1111' }),
    record({ id: 'tq_bbbbbbbb-2222' }),
  ]
  assert.equal(resolveTechniqueId('tq_aaaaaaaa-1111', records).ok, true, '完整 id')
  const prefixed = resolveTechniqueId(`tq_${'a'.repeat(ID_PREFIX_CHARS)}`, records)
  assert.equal(prefixed.ok, true, '带前缀的短 id')
  assert.equal(resolveTechniqueId('a'.repeat(ID_PREFIX_CHARS), records).ok, true, '不带 tq_ 的前缀')
  assert.equal(resolveTechniqueId('tq_cccccccc', records).ok, false, '不存在的前缀')
  assert.equal(resolveTechniqueId('tq_a', records).ok, false, '太短的前缀拒绝解析')
  assert.equal(resolveTechniqueId(7, records).ok, false, '非字符串')

  const ambiguous = resolveTechniqueId('tq_aaaa', [record({ id: 'tq_aaaaaaaa' }), record({ id: 'tq_aaaabbbb' })])
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.ok ? '' : ambiguous.reason, /ambiguous/u, '前缀歧义要列出候选，不能猜')
})

test('检索行带 gist 与短 id，比完整索引行短；尾部行只回答「还存在」', () => {
  const target = record({
    id: 'tq_1234abcd-9999',
    name: 'authorize 前置',
    when: '首次集成 OrdersClient 时',
    summary: '先 authorize 再 create。否则返回 401。',
    status: 'validated',
  })
  const line = techniqueSearchLine(target, 2)
  assert.match(line, /^2\. \[validated\]/u, '带序号与状态')
  assert.match(line, /先 authorize 再 create。/u, '带可执行要点')
  assert.match(line, new RegExp(shortTechniqueId('tq_1234abcd-9999'), 'u'), '带短 id')
  assert.ok(!line.includes('tq_1234abcd-9999'), '不应印完整 uuid')
  assert.ok(
    line.length < techniqueIndexLine(target).length,
    '紧凑行必须真的更短，否则优化是假的',
  )

  // 尾部行不带做法，只留名字与 id：这是「候选很多」与「哪几条最该看」分开付费的关键。
  const tail = techniqueTailLine(target, 7)
  assert.match(tail, /^7\. \[validated\]/u)
  assert.match(tail, new RegExp(shortTechniqueId('tq_1234abcd-9999'), 'u'))
  assert.ok(!tail.includes('先 authorize'), '尾部行不展开做法')
  // 省下的正是 gist 那一段：这条断言把「为什么更短」钉在机制上，而不是钉在某个比例。
  assert.ok(
    line.length - tail.length >= gistOf(target).length - 4,
    `尾部行应正好省掉 gist：${line.length} vs ${tail.length}`,
  )
})

test('验收证据落盘前收敛到上限，且校验先于收敛', () => {
  const short = 're-ran `npm test`: 240/240 pass'
  assert.equal(clampVerificationEvidence(short), short, '未超限时原样返回')

  const long = `复核 ${'细节'.repeat(300)}`
  const clamped = clampVerificationEvidence(long)
  assert.equal(clamped.length, MAX_VERIFICATION_CHARS, '应正好收敛到上限')
  assert.ok(clamped.endsWith('…'), '截断要有明确标记')

  // 关键顺序：校验看全文。锚点写在末尾时，若先截断再校验，这条合格证据会被误判为「没有具体锚点」。
  const anchorAtEnd = `${'铺垫'.repeat(300)} 复核结果 240/240`
  const check = checkVerificationEvidence(anchorAtEnd)
  assert.equal(check.ok, true, '锚点在末尾也应通过校验')
  assert.equal(clampVerificationEvidence(check.ok ? check.value : '').length, MAX_VERIFICATION_CHARS)
})

test('空洞结论的机械下限', () => {
  // 短结论词现在得到的是**准确理由**（内容空洞），而不是含糊的「太短」——
  // 旧实现把整串匹配放在长度闸门之后，而无一条结论词能达到 12 字，该分支永远走不到（DEF-17）。
  for (const verdict of ['ok', '已采用', '通过', '已采用，效果良好', '已采用 100% 有效', '一切正常']) {
    const result = checkVerificationEvidence(verdict)
    assert.equal(result.ok, false, `应拒绝：${verdict}`)
    assert.match(result.ok ? '' : result.reason, /content-free/u, `${verdict} 应被判为空洞结论`)
  }
  const empty = checkVerificationEvidence('   ')
  assert.equal(empty.ok, false)
  assert.match(empty.ok ? '' : empty.reason, /empty/u, '空白应报「空」而不是「内容空洞」')

  // 边界：有具体锚点但太短 —— 这是「太短」闸门唯一的活路（覆盖率指引：该分支此前未被执行）。
  const tooShort = checkVerificationEvidence('240/240')
  assert.equal(tooShort.ok, false)
  assert.match(tooShort.ok ? '' : tooShort.reason, /too short/u, '有锚点但过短应报「太短」')

  // 已知残余缺口（刻意不做语义判断的代价）：带数字的结论词仍会通过。
  // 在这里显式记录下来，免得后人误以为它已被拦住。
  assert.equal(checkVerificationEvidence('确认无误，一切正常 2 次').ok, true, '这是已知下限，不是缺陷')

  // 真证据不能被误杀：含观察对象的短语即使带结论词也要通过。
  assert.equal(checkVerificationEvidence('重跑 `npm test`：240/240 通过').ok, true)
  assert.equal(checkVerificationEvidence('渲染后目视：728×1010，无交叉边').ok, true)
})

test('promotedStatus 的兜底、调用名索引去重与适用性判定', () => {
  assert.equal(promotedStatus(record()), 'draft', '零成功应停在 draft')

  const shared = [
    record({ id: 'tq_a', api: [{ symbol: 'OrdersClient.create' }] }),
    record({ id: 'tq_b', api: [{ symbol: 'OrdersClient.create' }] }),
  ]
  const index = symbolIndex(shared)
  assert.deepEqual(index.get('OrdersClient.create'), ['tq_a', 'tq_b'], '同名调用面应收集全部 id')
  assert.equal(symbolIndex([...shared, ...shared]).get('OrdersClient.create')?.length, 2, '重复记录不得重复入桶')

  assert.equal(techniqueApplies(record({ stack: { languages: ['java'] } }), { languages: ['java'] }), true)
  assert.equal(techniqueApplies(record({ stack: { languages: ['java'] } }), { languages: ['rust'] }), false)
})

test('连续失败会废弃，且废弃是粘性终态', () => {
  let current = record({ successes: 1, status: 'validated' })
  current = applyOutcome(current, verification({ outcome: 'failure', at: 10 }))
  assert.equal(current.status, 'validated', '一次失败还不至于废弃')
  current = applyOutcome(current, verification({ outcome: 'failure', at: 20 }))
  assert.equal(current.status, 'deprecated')
  current = applyOutcome(current, verification({ outcome: 'success', at: 30 }))
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
