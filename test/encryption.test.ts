/**
 * 存储层加密集成测试：验证落盘为密文、读回为明文、旧明文库兼容，
 * 以及单行损坏不影响其余记录。
 *
 * @module dsh-memory-layer/test/encryption.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CIPHER_PREFIX, createCodec, generateKey } from '../src/crypto.js'
import { MemoryStore } from '../src/store.js'
import type { EpisodicRecord } from '../src/types.js'

/** 造一条情景记录。 */
function episodic(overrides: Partial<EpisodicRecord> = {}): EpisodicRecord {
  return {
    id: 'ep_1',
    ts: 1_700_000_000_000,
    sessionId: 's1',
    scope: 'project',
    cwd: '/work/demo',
    title: '标题',
    summary: '摘要内容',
    decisions: [],
    todos: [],
    files: [],
    tags: [],
    source: 'rule',
    ...overrides,
  }
}

/**
 * 建一个临时记忆库并在用例结束后清理。
 * @param run - 用例主体，接收加密 store、密钥与目录。
 */
async function withStore(
  run: (store: MemoryStore, key: Buffer, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mem-enc-'))
  const key = generateKey()
  try {
    await run(new MemoryStore(root, createCodec(key)), key, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('情景层落盘为密文，读回为明文', async () => {
  await withStore(async (store, _key, _root) => {
    await store.saveEpisodic(episodic({ summary: '敏感的会话摘要' }))

    const file = join(store.scopeDir('project', '/work/demo'), 'episodic.jsonl')
    const onDisk = (await readFile(file, 'utf8')).trim()
    assert.ok(onDisk.startsWith(CIPHER_PREFIX), '落盘内容应为密文行')
    assert.ok(!onDisk.includes('敏感的会话摘要'), '落盘内容不应包含明文')
    assert.ok(!onDisk.includes('"id"'), '落盘内容不应是可读 JSON')

    const records = await store.readEpisodic('project', '/work/demo')
    assert.equal(records.length, 1)
    assert.equal(records[0]?.summary, '敏感的会话摘要')
  })
})

test('语义层落盘同样为密文并可按 key 合并', async () => {
  await withStore(async (store, _key, _root) => {
    await store.upsertSemantic(
      [{ kind: 'preference', text: '用户偏好 pnpm。' }],
      { scope: 'project', cwd: '/work/demo', sessionId: 's1', tags: [] },
    )
    const file = join(store.scopeDir('project', '/work/demo'), 'semantic.json')
    const onDisk = (await readFile(file, 'utf8')).trim()
    assert.ok(onDisk.startsWith(CIPHER_PREFIX))
    assert.ok(!onDisk.includes('pnpm'))

    const again = await store.upsertSemantic(
      [{ kind: 'preference', text: '用户偏好 pnpm。' }],
      { scope: 'project', cwd: '/work/demo', sessionId: 's2', tags: [] },
    )
    assert.equal(again.length, 1, '加密后仍应正确合并同一条事实')
    assert.equal(again[0]?.hits, 2)
  })
})

test('旧明文记忆库仍可读，并在下次写入后转为密文', async () => {
  await withStore(async (store, _key, _root) => {
    const dir = store.scopeDir('project', '/work/demo')
    // 用一次真实写入建立目录结构，再把它替换成「旧的明文格式」。
    await store.saveEpisodic(episodic({ id: 'ep_old', summary: '占位' }))
    const file = join(dir, 'episodic.jsonl')
    await writeFile(file, `${JSON.stringify(episodic({ summary: '旧明文' }))}\n`, 'utf8')

    const records = await store.readEpisodic('project', '/work/demo')
    assert.equal(records.length, 1, '旧的明文行应被按明文读入')
    assert.equal(records[0]?.summary, '旧明文')

    await store.saveEpisodic(episodic({ id: 'ep_2', summary: '新写入' }))
    const onDisk = await readFile(file, 'utf8')
    assert.ok(onDisk.includes(CIPHER_PREFIX), '重写后应整体转为密文')
    assert.ok(!onDisk.includes('旧明文'))
  })
})

test('无法解密的行被跳过，其余记录仍可读', async () => {
  await withStore(async (store, _key, _root) => {
    await store.saveEpisodic(episodic({ id: 'ep_good_1', summary: '第一条' }))
    const dir = store.scopeDir('project', '/work/demo')
    const file = join(dir, 'episodic.jsonl')
    const good = await readFile(file, 'utf8')

    // 插入一行用别的密钥加密的内容（模拟篡改或密钥变更）。
    const foreign = createCodec(generateKey()).encode(JSON.stringify(episodic({ id: 'ep_foreign' })))
    await writeFile(file, `${good}${foreign}\n`, 'utf8')

    const records = await store.readEpisodic('project', '/work/demo')
    assert.equal(records.length, 1, '无法解密的行应被跳过')
    assert.equal(records[0]?.id, 'ep_good_1')
  })
})

test('未配置编解码器时保持明文（显式关闭加密）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mem-plain-'))
  try {
    const store = new MemoryStore(root)
    await store.saveEpisodic(episodic({ summary: '明文摘要' }))
    const file = join(store.scopeDir('project', '/work/demo'), 'episodic.jsonl')
    const onDisk = await readFile(file, 'utf8')
    assert.ok(onDisk.includes('明文摘要'), 'encrypt: false 时应为明文')
    assert.ok(!onDisk.includes(CIPHER_PREFIX))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
