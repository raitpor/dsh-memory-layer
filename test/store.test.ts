/**
 * 存储层测试：分层落盘、同会话覆盖、语义合并与删除。
 *
 * @module dsh-memory-layer/test/store.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EPISODIC_FILE,
  MemoryStore,
  SEMANTIC_FILE,
  semanticKey,
  slugify,
  scopeDirName,
} from '../src/store.js'
import type { EpisodicRecord } from '../src/types.js'

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
