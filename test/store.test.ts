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
  MemoryStore,
  SEMANTIC_FILE,
  StoreIntegrityError,
  StoreLockedError,
  WRITER_LOCK_FILE,
  semanticKey,
  slugify,
  scopeDirName,
} from '../src/store.js'
import { createCodec } from '../src/crypto.js'
import type { EpisodicRecord, TechniqueDraft } from '../src/types.js'

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
