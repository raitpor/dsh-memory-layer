/**
 * 存储层测试：分层落盘、同会话覆盖、语义合并与删除。
 *
 * @module dsh-memory-layer/test/store.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EPISODIC_FILE,
  LOCK_STALE_MS,
  MAX_SEMANTIC_PER_SCOPE,
  MAX_TECHNIQUES_PER_SCOPE,
  MemoryStore,
  SEMANTIC_FILE,
  StoreIntegrityError,
  StoreLockedError,
  WRITER_LOCK_FILE,
  semanticKey,
  slugify,
  scopeDirName,
  deriveDomainFromTags,
  normalizeDomain,
  techniqueKey,
} from '../src/store.js'
import { createCodec } from '../src/crypto.js'
import type { EpisodicRecord, TechniqueDraft, TechniqueRecord } from '../src/types.js'

/** 建一个临时记忆库，并在用例结束时清理。 */
async function withStore(run: (store: MemoryStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  try {
    await run(new MemoryStore(root), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 造一条情景记录。 */
function episodic(overrides: Partial<EpisodicRecord> = {}): EpisodicRecord {
  return {
    id: 'ep_1',
    ts: 1_700_000_000_000,
    sessionId: 's1',
    scope: 'project',
    cwd: '/work/demo',
    title: 'title',
    summary: 'summary',
    decisions: [],
    todos: [],
    files: [],
    tags: [],
    source: 'rule',
    ...overrides,
  }
}

test('空库读取返回空数组', async () => {
  await withStore(async store => {
    assert.deepEqual(await store.readEpisodic('project', '/work/demo'), [])
    assert.deepEqual(await store.readSemantic('project', '/work/demo'), [])
  })
})

test('情景层写入后可读回，且同 sessionId 只保留一条', async () => {
  await withStore(async store => {
    await store.saveEpisodic(episodic({ id: 'ep_1', summary: 'first' }))
    await store.saveEpisodic(episodic({ id: 'ep_2', sessionId: 's2', summary: 'other' }))
    await store.saveEpisodic(episodic({ id: 'ep_3', summary: 'replaced' }))

    const records = await store.readEpisodic('project', '/work/demo')
    assert.equal(records.length, 2, '同一会话应被原地替换')
    assert.deepEqual(records.map(record => record.id), ['ep_2', 'ep_3'])
    assert.equal(records.at(-1)?.summary, 'replaced')
  })
})

test('不同项目目录互相隔离', async () => {
  await withStore(async store => {
    await store.saveEpisodic(episodic({ cwd: '/work/a' }))
    await store.saveEpisodic(episodic({ id: 'ep_b', cwd: '/work/b' }))

    assert.equal((await store.readEpisodic('project', '/work/a')).length, 1)
    assert.equal((await store.readEpisodic('project', '/work/b')).length, 1)
    assert.notEqual(store.scopeDir('project', '/work/a'), store.scopeDir('project', '/work/b'))
  })
})

test('global 作用域忽略 cwd', async () => {
  await withStore(async store => {
    await store.saveEpisodic(episodic({ scope: 'global', sessionId: 'g1' }))
    assert.equal((await store.readEpisodic('global')).length, 1)
    assert.equal(store.scopeDir('global', '/work/a'), store.scopeDir('global', '/work/b'))
  })
})

test('语义层同 key 合并并累加命中次数', async () => {
  await withStore(async store => {
    const first = await store.upsertSemantic(
      [{ kind: 'preference', text: '用户偏好使用 pnpm。' }],
      { scope: 'project', cwd: '/work/demo', sessionId: 's1', tags: ['pkg'] },
    )
    assert.equal(first.length, 1)
    assert.equal(first[0]?.hits, 1)

    const second = await store.upsertSemantic(
      [{ kind: 'preference', text: '用户偏好 使用 pnpm' }],
      { scope: 'project', cwd: '/work/demo', sessionId: 's2', tags: ['tools'] },
    )
    assert.equal(second.length, 1, '归一化后相同的事实应合并为一条')
    assert.equal(second[0]?.hits, 2)
    assert.deepEqual(second[0]?.sources, ['s1', 's2'])
    assert.deepEqual(second[0]?.tags, ['pkg', 'tools'])
  })
})

test('语义层取代语义：旧条被标记而不是被删，同 key 重申不动它（DEF-31）', async () => {
  await withStore(async store => {
    const before = await store.upsertSemantic(
      [{ kind: 'preference', text: '用户偏好用 npm 安装依赖。' }],
      { scope: 'global', sessionId: 's1', tags: [] },
    )
    const oldId = before[0]?.id
    if (oldId === undefined) throw new Error('语义层应产出 id')

    // 改口：新事实 + 显式取代旧条，一次写入完成。
    const after = await store.upsertSemantic(
      [{ kind: 'preference', text: '用户偏好用 pnpm 安装依赖。' }],
      { scope: 'global', sessionId: 's2', tags: [], supersedes: oldId },
    )
    const old = after.find(record => record.id === oldId)
    const fresh = after.find(record => record.text.includes('pnpm'))
    if (fresh === undefined) throw new Error('应写入新事实')
    assert.equal(after.length, 2, '旧条必须留在库里可追溯')
    assert.equal(old?.supersededBy, fresh.id, '旧条应指向取代它的新条')
    assert.ok((old?.supersededAt ?? 0) > 0, '应记录取代时间')
    assert.equal(fresh.supersededBy, undefined, '新条自己不应被标记')

    // 重申同一句话（归一化后同 key）：那是确认，不是取代 —— 不能把自己标成已取代。
    const reaffirmed = await store.upsertSemantic(
      [{ kind: 'preference', text: '用户偏好用 pnpm 安装依赖' }],
      { scope: 'global', sessionId: 's3', tags: [], supersedes: fresh.id },
    )
    const same = reaffirmed.find(record => record.id === fresh.id)
    assert.equal(same?.hits, 2, '同 key 应合并并累加命中')
    assert.equal(same?.supersededBy, undefined, '重申不得把自己标记为已取代')
    assert.equal(reaffirmed.length, 2)

    // 目标不存在时什么都不做（调用方负责先校验，这里兜住竞态）。
    const untouched = await store.upsertSemantic(
      [{ kind: 'fact', text: '另一条无关事实。' }],
      { scope: 'global', sessionId: 's4', tags: [], supersedes: 'sm_不存在' },
    )
    assert.equal(untouched.length, 3)
    assert.equal(untouched.filter(record => record.supersededBy !== undefined).length, 1)
  })
})

test('forget 可按 id 删除，也支持整域清空', async () => {
  await withStore(async store => {
    await store.saveEpisodic(episodic())
    await store.upsertSemantic(
      [{ kind: 'fact', text: '项目使用 TypeScript。' }],
      { scope: 'project', cwd: '/work/demo', sessionId: 's1', tags: [] },
    )

    assert.equal(await store.forget('project', '/work/demo', 'ep_1'), 1)
    assert.equal((await store.readEpisodic('project', '/work/demo')).length, 0)

    assert.equal(await store.forget('project', '/work/demo', '*'), 1)
    assert.equal((await store.readSemantic('project', '/work/demo')).length, 0)
  })
})

test('存储文件是可直接阅读的 JSON / JSONL', async () => {
  await withStore(async store => {
    await store.saveEpisodic(episodic())
    const dir = store.scopeDir('project', '/work/demo')
    const lines = (await readFile(join(dir, EPISODIC_FILE), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0] as string).summary, 'summary')

    await store.upsertSemantic(
      [{ kind: 'fact', text: '一句话事实' }],
      { scope: 'project', cwd: '/work/demo', sessionId: 's1', tags: [] },
    )
    const parsed = JSON.parse(await readFile(join(dir, SEMANTIC_FILE), 'utf8')) as unknown[]
    assert.equal(parsed.length, 1)
  })
})

test('损坏行被跳过而不是让整个库读不出来', async () => {
  await withStore(async store => {
    await store.saveEpisodic(episodic())
    const file = join(store.scopeDir('project', '/work/demo'), EPISODIC_FILE)
    const good = await readFile(file, 'utf8')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, `{not json\n${good}`, 'utf8')

    const records = await store.readEpisodic('project', '/work/demo')
    assert.equal(records.length, 1)
    assert.equal(records[0]?.id, 'ep_1')
  })
})

test('semanticKey 归一化标点、空白与大小写', () => {
  assert.equal(semanticKey('用户偏好使用 pnpm。'), semanticKey('用户偏好 使用 PNPM'))
  assert.notEqual(semanticKey('使用 pnpm'), semanticKey('使用 npm'))
})

test('slugify 与 scopeDirName 产出文件系统安全的目录名', () => {
  assert.equal(slugify('/work/My Project!'), 'work-my-project')
  assert.equal(slugify('///'), 'root')
  assert.match(scopeDirName('project', '/work/demo'), /^projects\/demo-[0-9a-f]{8}$/u)
  assert.equal(scopeDirName('global', '/work/demo'), 'global')
})

test('countProjectEpisodic 汇总所有项目桶，且不把 global 算进去', async () => {
  await withStore(async store => {
    await store.saveEpisodic(episodic({ id: 'ep_a', cwd: '/work/a', sessionId: 'sa' }))
    await store.saveEpisodic(episodic({ id: 'ep_b', cwd: '/work/b', sessionId: 'sb' }))
    await store.saveEpisodic(episodic({ id: 'ep_c', cwd: '/work/b', sessionId: 'sc' }))
    await store.saveEpisodic(episodic({ id: 'ep_g', scope: 'global', sessionId: 'sg' }))

    assert.equal((await store.readEpisodic('project', '/work/a')).length, 1, '当前桶只有 1 条')
    assert.equal(await store.countProjectEpisodic(), 3, '跨项目总数应为 3，global 不计')
  })
})


// ---- 白盒补充：失败层合并时 trigger 的「只填空、不覆盖」语义 ----------------------

test('upsertFailures：trigger 只在缺失时补上，已有值不被后来的观测改写', async () => {
  await withStore(async store => {
    const fingerprint = { kind: 'machine' as const, key: 'k1', tool: 'bash', template: 'boom' }
    const options = {
      scope: 'global' as const,
      partition: 'default',
      sessionId: 's1',
      enforcement: () => 'warn' as const,
    }
    // ① 首次写入带上 trigger。
    await store.upsertFailures([{ fingerprint, symptom: 'boom', trigger: '使用 bash 时' }], options)
    let [record] = await store.readFailures('global')
    assert.equal(record?.trigger, '使用 bash 时')

    // ② 再次观测带**不同** trigger：已有的语义结论不该被粗粒度推导覆盖。
    await store.upsertFailures([{ fingerprint, symptom: 'boom again', trigger: '换了个推导' }], options)
    ;[record] = await store.readFailures('global')
    assert.equal(record?.trigger, '使用 bash 时', '已有 trigger 必须保留')
    assert.equal(record?.occurrences, 2, '次数照常累加')
    assert.equal(record?.symptom, 'boom again', '现象取最近一次')
  })
})

test('upsertFailures：先无 trigger 后补上时，缺失的那次会被填上', async () => {
  await withStore(async store => {
    const fingerprint = { kind: 'machine' as const, key: 'k2', tool: 'bash', template: 'boom' }
    const options = {
      scope: 'global' as const,
      partition: 'default',
      sessionId: 's1',
      enforcement: () => 'warn' as const,
    }
    await store.upsertFailures([{ fingerprint, symptom: 'boom' }], options)
    let [record] = await store.readFailures('global')
    assert.equal(record?.trigger, undefined, '未提供时不应凭空造出 trigger')

    await store.upsertFailures([{ fingerprint, symptom: 'boom', trigger: '使用 bash 时遇到「boom」' }], options)
    ;[record] = await store.readFailures('global')
    assert.equal(record?.trigger, '使用 bash 时遇到「boom」', '缺失时应补上')
  })
})


test('forgetFailure：按记录 id 删除与整域清空', async () => {
  await withStore(async store => {
    const options = {
      scope: 'global' as const,
      partition: 'default',
      sessionId: 's1',
      enforcement: () => 'warn' as const,
    }
    await store.upsertFailures([
      { fingerprint: { kind: 'machine' as const, key: 'k1', tool: 'bash', template: 'a' }, symptom: 'a' },
      { fingerprint: { kind: 'machine' as const, key: 'k2', tool: 'bash', template: 'b' }, symptom: 'b' },
    ], options)
    // 参数是**记录 id**，不是指纹 key —— 传 key 删不掉任何东西。
    assert.equal(await store.forgetFailure('global', undefined, 'default', 'k1'), 0)
    const records = await store.readFailures('global')
    const target = records.find(record => record.fingerprint.key === 'k1')
    assert.ok(target !== undefined)
    assert.equal(await store.forgetFailure('global', undefined, 'default', target.id), 1)
    assert.equal((await store.readFailures('global')).length, 1)
    assert.equal(await store.forgetFailure('global', undefined, 'default', '*'), 1, '`*` 清空整域')
    assert.equal((await store.readFailures('global')).length, 0)
  })
})

// ---- B1：写入互斥（跨进程锁 + 进程内串行） ----------------------------------

/** 造一条技巧草稿。 */
function draft(index: number): TechniqueDraft {
  return {
    kind: 'procedure',
    name: `concurrent ${index}`,
    when: `case ${index}`,
    summary: `Written for case ${index}.`,
    pitfalls: [], verify: [], stack: { languages: [] }, tags: [], evidence: [],
  }
}

test('同一记忆库上的并发读-改-写不再互相覆盖', async () => {
  await withStore(async (_store, root) => {
    const a = new MemoryStore(root)
    const b = new MemoryStore(root)
    // 两个实例同时各写 10 条：每条都是「读全量 → 改 → 整体重写」，未加锁时后写者抹掉前写者。
    await Promise.all([
      a.upsertTechniques(Array.from({ length: 10 }, (_, i) => draft(i)), { scope: 'global', sessionId: 'sA', provenance: 'model' }),
      b.upsertTechniques(Array.from({ length: 10 }, (_, i) => draft(100 + i)), { scope: 'global', sessionId: 'sB', provenance: 'model' }),
    ])
    const records = await new MemoryStore(root).readTechniques('global')
    assert.equal(records.length, 20, '两边的写入都要在')
  })
})

test('别人持锁时拒绝写入（而不是覆盖它的记录）', async () => {
  await withStore(async (store, root) => {
    await store.upsertTechniques([draft(1)], { scope: 'global', sessionId: 's1', provenance: 'model' })
    const file = join(root, 'global', 'techniques.jsonl')
    const before = await readFile(file, 'utf8')

    // 造一把「新鲜的」别人的锁：从锁的角度看，就是一个正在写的实例。
    const lock = join(root, WRITER_LOCK_FILE)
    await writeFile(lock, `${JSON.stringify({ owner: 'other-host#999', pid: 999, at: Date.now() })}\n`)
    await assert.rejects(
      () => store.upsertTechniques([draft(2)], { scope: 'global', sessionId: 's2', provenance: 'model' }),
      (error: unknown) => error instanceof StoreLockedError,
      '持续被占时应报 StoreLockedError',
    )
    assert.equal(await readFile(file, 'utf8'), before, '被拒绝时目标文件必须原样不动')
    await rm(lock, { force: true })
  })
})

test('过期的锁会被接管，而不是把库永久锁死', async () => {
  await withStore(async (store, root) => {
    await store.upsertTechniques([draft(1)], { scope: 'global', sessionId: 's1', provenance: 'model' })
    const lock = join(root, WRITER_LOCK_FILE)
    await writeFile(lock, `${JSON.stringify({ owner: 'dead-host#404', pid: 404, at: 0 })}\n`)
    // 把 mtime 拨到过期之前：模拟持锁进程已经死掉。
    const old = new Date(Date.now() - LOCK_STALE_MS * 10)
    await utimes(lock, old, old)

    await store.upsertTechniques([draft(2)], { scope: 'global', sessionId: 's2', provenance: 'model' })
    const records = await new MemoryStore(root).readTechniques('global')
    assert.equal(records.length, 2, '接管后写入应成功')
    await assert.rejects(() => stat(lock), '写完必须释放锁')
  })
})

// ---- B2：密钥不匹配时 fail-closed -------------------------------------------

/** 造一个加密库，写入一条后用错误的密钥重新打开。 */
async function withWrongKey(run: (broken: MemoryStore, file: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-key-'))
  try {
    const good = new MemoryStore(root, createCodec(Buffer.alloc(32, 7)))
    await good.upsertTechniques([draft(1)], { scope: 'global', sessionId: 's1', provenance: 'model' })
    const broken = new MemoryStore(root, createCodec(Buffer.alloc(32, 9)))
    await run(broken, join(root, 'global', 'techniques.jsonl'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('整份文件解不开时拒绝写入，保住旧密文', async () => {
  await withWrongKey(async (broken, file) => {
    const raw = await readFile(file, 'utf8')
    assert.equal((await broken.readTechniques('global')).length, 0, '读不出来时按空库处理（既有约定）')
    assert.equal(broken.integrityBroken, true, '整份解不开必须被标记')
    assert.equal(broken.undecodableLines, 1, '解不开的行数要能报出来')

    await assert.rejects(
      () => broken.upsertTechniques([draft(2)], { scope: 'global', sessionId: 's2', provenance: 'model' }),
      (error: unknown) => error instanceof StoreIntegrityError,
      '此时写入必须被拒绝',
    )
    assert.equal(await readFile(file, 'utf8'), raw, '拒绝写入后旧密文必须原样保留，恢复密钥还能救回来')
  })
})

test('个别行解不开时容忍并计数，写入照常', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-partial-'))
  try {
    const good = new MemoryStore(root, createCodec(Buffer.alloc(32, 7)))
    await good.upsertTechniques([draft(1)], { scope: 'global', sessionId: 's1', provenance: 'model' })
    const file = join(root, 'global', 'techniques.jsonl')
    // 混入一行用别的密钥加密的内容：单行解不开，但整份文件不是全解不开。
    const foreign = createCodec(Buffer.alloc(32, 9)).encode(JSON.stringify({ id: 'tq_foreign' }))
    await writeFile(file, `${await readFile(file, 'utf8')}${foreign}\n`)

    const reopened = new MemoryStore(root, createCodec(Buffer.alloc(32, 7)))
    assert.equal((await reopened.readTechniques('global')).length, 1, '好行仍然读得出来')
    assert.equal(reopened.integrityBroken, false, '个别行解不开不算整库损坏')
    assert.equal(reopened.undecodableLines, 1, '跳过的行数要能报出来')
    await reopened.upsertTechniques([draft(2)], { scope: 'global', sessionId: 's2', provenance: 'model' })
    assert.equal((await reopened.readTechniques('global')).length, 2, '容忍坏行时写入必须照常')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('语义层也有容量上限，且优先保留命中多的', async () => {
  await withStore(async (store) => {
    // 去重键由正文派生，因此反复写同一句话就是「反复观察到同一条事实」。
    for (let i = 0; i < 21; i += 1) {
      await store.upsertSemantic([{ kind: 'fact', text: '重要的老事实' }],
        { scope: 'global', sessionId: `s${i}`, tags: [] })
    }
    await store.upsertSemantic(
      Array.from({ length: MAX_SEMANTIC_PER_SCOPE + 50 }, (_, i) => ({
        kind: 'fact' as const, text: `填充事实条目第 ${i} 号`,
      })),
      { scope: 'global', sessionId: 'bulk', tags: [] },
    )
    const records = await store.readSemantic('global')
    assert.equal(records.length, MAX_SEMANTIC_PER_SCOPE, `应保留 ${MAX_SEMANTIC_PER_SCOPE} 条`)
    const important = records.find(record => record.text === '重要的老事实')
    assert.ok(important !== undefined, '命中多的老事实不能被按时间淘汰掉')
    assert.equal(important.hits, 21, '命中次数仍要累计')
  })
})

test('锁文件内容损坏时，仍能报出「有别的实例在写」', async () => {
  await withStore(async (store, root) => {
    // 持锁进程在写锁文件的中途崩掉，会留下半截内容；此时不能因为解析失败就当作没锁。
    await writeFile(join(root, WRITER_LOCK_FILE), '{"owner": "half')
    await assert.rejects(
      () => store.upsertTechniques([draft(1)], { scope: 'global', sessionId: 's1', provenance: 'model' }),
      (error: unknown) => error instanceof StoreLockedError && /unknown/u.test((error as Error).message),
      '内容损坏的锁仍要阻塞写入，并把持锁者报成 unknown',
    )
  })
})

test('updateTechniques：一批更新合并成一次写入', async () => {
  await withStore(async (store) => {
    const created = await store.upsertTechniques(
      Array.from({ length: 3 }, (_, i) => draft(i)),
      { scope: 'global', sessionId: 's1', provenance: 'model' },
    )
    const before = created.records.map(record => ({ ...record, name: `${record.name} (updated)` }))
    const written = await store.updateTechniques(before)
    assert.equal(written, 3, '三条都应写入')
    const after = await store.readTechniques('global')
    assert.equal(after.length, 3, '批量更新不得新增或丢记录')
    assert.ok(after.every(record => record.name.endsWith('(updated)')))
    // 不存在的 id 只是被跳过，不影响同一批里的其他记录。
    const ghost = { ...before[0]!, id: 'tq_ghost' }
    assert.equal(await store.updateTechniques([ghost, { ...before[1]!, name: 'again' }]), 1, '未知 id 跳过')
    assert.equal((await store.readTechniques('global')).find(r => r.id === before[1]!.id)?.name, 'again')
  })
})

// ---- P0.1：容量淘汰按「保留价值」而不是按时间 ------------------------------

/**
 * 造 `count` 条同批写入的草稿，把第 `valuable` 条中的前若干条伪装成「有价值的**最老**卡」。
 *
 * 伪装只能用 `updateTechniques` 直接改记录：`upsertTechniques` 造出来的新卡一律
 * `retrieveCount`/`successes` 为 0，而本组用例要检验的正是「有使用痕迹」这一档。
 *
 * @param store - 记忆库。
 * @param count - 记录条数。
 * @param valuable - 前多少条算「有价值的活卡」。
 * @returns 全部记录（已按 ts 拉开：有价值的那批**最老**）。
 */
async function seedWithValuableHead(
  store: MemoryStore,
  count: number,
  valuable: number,
): Promise<TechniqueRecord[]> {
  const created = await store.upsertTechniques(
    Array.from({ length: count }, (_, i) => draft(i)),
    { scope: 'global', sessionId: 's1', provenance: 'model', now: 5_000 },
  )
  const patched = created.records.map((record, index) => (index < valuable
    // 头部这批：最老（纯 ts 先进先出必定先丢它们），但被检索过、也验收成功过。
    ? { ...record, ts: 1_000 + index, status: 'validated' as const, retrieveCount: 1, successes: 1 }
    : { ...record, ts: 2_000 + index }))
  assert.equal(await store.updateTechniques(patched), count, '伪装必须先落盘')
  return patched
}

test('容量淘汰按价值：库满时丢的是没用过的草稿，而不是最老的活卡', async () => {
  // 动机（实测）：淘汰原本是 `sort(ts).slice(-500)`，即「时间先进先出」。真库 3 天窗口里每天挤掉
  // 约 33 条，而近 3 天**注入过**的 100 个卡 id 已有 13 个不在真源里 —— 老 ≠ 没用。
  await withStore(async (store) => {
    const seeded = await seedWithValuableHead(store, MAX_TECHNIQUES_PER_SCOPE, 10)
    const valuableIds = new Set(seeded.slice(0, 10).map(record => record.id))

    const added = await store.upsertTechniques([draft(9_999)], {
      scope: 'global', sessionId: 's2', provenance: 'model', now: 9_000,
    })
    const kept = await store.readTechniques('global')
    assert.equal(kept.length, MAX_TECHNIQUES_PER_SCOPE, `仍应正好在上限：${kept.length}`)
    assert.ok(
      [...valuableIds].every(id => kept.some(record => record.id === id)),
      '被检索/被验收成功过的老卡一条都不能少（纯 ts 先进先出会先丢这 10 条）',
    )
    assert.ok(kept.some(record => record.id === added.records[0]?.id), '新卡必须进得来')
    // 丢掉的必须是一条**没有使用痕迹**的草稿：它的 ts 比活卡新，所以只有「按价值」才会选中它。
    const gone = seeded.find(record => !kept.some(item => item.id === record.id))
    assert.ok(gone !== undefined, '应恰好淘汰一条')
    assert.equal(gone.retrieveCount, undefined, '被淘汰的那条不得有任何检索记录')
    assert.equal(gone.successes, 0, '被淘汰的那条不得有成功记录')
  })
})

test('容量淘汰按价值：已归档的卡最先让位，即使它是最新写的', async () => {
  // 归档是**可逆**的「退出竞争」（见 isArchivable），容量淘汰是不可逆的删除：
  // 先丢已经走过归档这一步、且没人把它救回来的卡，才不会误删还活着的知识。
  await withStore(async (store) => {
    const seeded = await seedWithValuableHead(store, MAX_TECHNIQUES_PER_SCOPE, 0)
    const newest = seeded[seeded.length - 1]!
    // 把**最新**的那条标成已归档：纯 ts 先进先出永远轮不到它。
    assert.equal(
      await store.updateTechniques([{ ...newest, ts: 9_000, archivedAt: 8_000 }]),
      1,
    )
    await store.upsertTechniques([draft(9_999)], {
      scope: 'global', sessionId: 's2', provenance: 'model', now: 9_500,
    })
    const kept = await store.readTechniques('global')
    assert.equal(kept.length, MAX_TECHNIQUES_PER_SCOPE)
    assert.ok(kept.some(record => record.id === newest.id) === false, '已归档的卡应最先被淘汰')
  })
})

test('容量淘汰：单次批量写入越过上限时，按同一套价值排序丢，且回报的新建数与存活一致', async () => {
  // 反方向：新卡豁免不能变成「上限可被一次批量写入越过」。库里没有旧卡可丢时，刚写入的卡自己让位。
  await withStore(async (store) => {
    const oversized = MAX_TECHNIQUES_PER_SCOPE + 40
    const result = await store.upsertTechniques(
      Array.from({ length: oversized }, (_, i) => draft(i)),
      { scope: 'global', sessionId: 's1', provenance: 'model', now: 1_000 },
    )
    assert.equal(result.records.length, MAX_TECHNIQUES_PER_SCOPE, '上限是硬约束')
    assert.equal(
      (await store.readTechniques('global')).length,
      MAX_TECHNIQUES_PER_SCOPE,
      '落盘也必须正好在上限',
    )
    assert.equal(result.created, MAX_TECHNIQUES_PER_SCOPE, '回报的新建数必须是**存活**的条数，不能虚报')
  })
})

test('容量淘汰：库里全是活卡时，新写的草稿仍然进得来（让位的是一张活卡，而不是它自己）', async () => {
  // 「新卡豁免」不是锦上添花：库满且残留的都是有价值的卡时，若按纯价值排序连新卡一起算，
  // 刚写进来的草稿（价值最低）会**当场**被自己挤掉 —— 库从此停止生长，而调用方还报「新增 1 条」。
  await withStore(async (store) => {
    const seeded = await seedWithValuableHead(store, MAX_TECHNIQUES_PER_SCOPE, MAX_TECHNIQUES_PER_SCOPE)
    const added = await store.upsertTechniques([draft(9_999)], {
      scope: 'global', sessionId: 's2', provenance: 'model', now: 9_000,
    })
    const kept = await store.readTechniques('global')
    assert.equal(added.created, 1, '新建数应为 1（虚报会让调用方以为写进去了）')
    assert.ok(
      kept.some(record => record.id === added.records[0]?.id),
      '新草稿必须真的在库里',
    )
    assert.equal(kept.length, MAX_TECHNIQUES_PER_SCOPE, '上限不变')
    assert.equal(
      seeded.filter(record => !kept.some(item => item.id === record.id)).length,
      1,
      '恰好让位一张旧卡',
    )
  })
})

test('P3 deriveDomainFromTags：只认已经在用的领域名，别名走同一套归一化', () => {
  // 规则刻意保守：**不从任意标签造新领域**。真库实测 125 条无领域卡里，能这样认出来的只有 33 条，
  // 其余 92 条的标签是技术栈与版本（`minecraft` / `porting` / `1.21.1`）—— 拿它们当领域会让
  // 领域词表凭空多出几十个只用过一次的名字。
  const known = new Set(['gradle', 'plantuml', 'dsh-plugin'])
  assert.equal(deriveDomainFromTags(['zzz', 'gradle'], known), 'gradle')
  assert.equal(deriveDomainFromTags(['puml'], known), 'plantuml', '别名表与 normalizeDomain 同口径')
  assert.equal(deriveDomainFromTags(['Minecraft', 'Porting'], known), undefined, '栈标签不是领域名')
  assert.equal(deriveDomainFromTags([], known), undefined)
  assert.equal(deriveDomainFromTags(['gradle'], new Set()), undefined, '空词表认不出任何东西')
  assert.equal(deriveDomainFromTags(['plantuml', 'gradle'], known), 'plantuml', '保序：取第一个认得出的')
})

test('normalizeDomain（0.2.10）：折叠大小写与空白、查别名表、空值即「无领域」', () => {
  // 动机（实测）：真库里 141 个领域名中，`PlantUML`(84) 与 `plantuml`(60) 是同一个词的两半 ——
  // 它会顺着 knownDomainsForMining 喂回模型，让模型继续在两个写法之间随机选。
  assert.equal(normalizeDomain('PlantUML'), 'plantuml')
  assert.equal(normalizeDomain('  minecraft-modding  '), 'minecraft-modding')
  assert.equal(normalizeDomain('SDO   门禁'), 'sdo 门禁', '内部空白压成一个空格')
  assert.equal(normalizeDomain('puml'), 'plantuml', '别名表把同义写法归到一起')
  assert.equal(normalizeDomain('plantuml-diagram'), 'plantuml')
  // 空与空白等价于「没有领域」：返回 undefined 而不是空串，写入侧据此省略该字段。
  assert.equal(normalizeDomain(undefined), undefined)
  assert.equal(normalizeDomain('   '), undefined)
  // 与产生侧 clip(48) 同口径：迁移不制造比写入更长的值。
  assert.equal(normalizeDomain('x'.repeat(80))?.length, 48)
  // 大小写折叠对**合并身份**是零风险的：techniqueKey 一直就转小写。
  assert.equal(techniqueKey('n', 'w', 'PlantUML'), techniqueKey('n', 'w', 'plantuml'))
})
