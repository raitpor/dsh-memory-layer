/**
 * 加密原语单元测试：AES-256-GCM 往返、篡改检测、密钥解析与密钥文件。
 *
 * @module dsh-memory-layer/test/crypto.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CIPHER_PREFIX,
  KEY_BYTES,
  KEY_ENV,
  createCodec,
  decryptLine,
  encryptLine,
  generateKey,
  isEncrypted,
  parseKeyMaterial,
  resolveKey,
  writeKeyFile,
} from '../src/crypto.js'

/** 建一个临时目录并在用例结束后清理。 */
async function withTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-crypto-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('加解密往返保持原文', () => {
  const key = generateKey()
  const plain = '用户偏好使用 pnpm；中文、emoji 🎯 与换行\n第二行'
  const cipherText = encryptLine(plain, key)

  assert.ok(isEncrypted(cipherText))
  assert.ok(cipherText.startsWith(CIPHER_PREFIX))
  assert.ok(!cipherText.includes('pnpm'), '密文不应包含明文片段')
  assert.equal(decryptLine(cipherText, key), plain)
})

test('同一明文两次加密得到不同密文（随机 IV）', () => {
  const key = generateKey()
  assert.notEqual(encryptLine('same', key), encryptLine('same', key))
})

test('密文被篡改时解密失败而不是返回被污染的明文', () => {
  const key = generateKey()
  const cipherText = encryptLine('重要内容', key)
  const parts = cipherText.slice(CIPHER_PREFIX.length).split(':')
  const data = Buffer.from(parts[2] as string, 'base64')
  data[0] = (data[0] as number) ^ 0xff
  const tampered = `${CIPHER_PREFIX}${parts[0]}:${parts[1]}:${data.toString('base64')}`

  assert.throws(() => decryptLine(tampered, key), /unable to authenticate|authenticate/u)
})

test('用错密钥解密失败', () => {
  const cipherText = encryptLine('机密', generateKey())
  assert.throws(() => decryptLine(cipherText, generateKey()))
})

test('非密文行按明文返回（兼容旧的明文记忆库）', () => {
  const key = generateKey()
  assert.equal(decryptLine('{"plain":"json"}', key), '{"plain":"json"}')
  assert.equal(isEncrypted('{"plain":"json"}'), false)
})

test('密文格式非法时抛错', () => {
  const key = generateKey()
  assert.throws(() => decryptLine(`${CIPHER_PREFIX}not-base64-enough`, key), /malformed/u)
  assert.throws(() => decryptLine(`${CIPHER_PREFIX}YWJj:YWJj:YWJj`, key), /malformed/u)
})

test('createCodec 的 encode/decode 互为逆操作', () => {
  const codec = createCodec(generateKey())
  const plain = '{"id":"ep_1","summary":"会话摘要"}'
  assert.equal(codec.decode(codec.encode(plain)), plain)
})

test('parseKeyMaterial 接受 64 位 hex 与 base64，拒绝非法输入', () => {
  const key = generateKey()
  assert.equal(parseKeyMaterial(key.toString('hex'))?.length, KEY_BYTES)
  assert.equal(parseKeyMaterial(`${key.toString('base64')}`)?.length, KEY_BYTES)
  assert.equal(parseKeyMaterial('  ' + key.toString('hex') + '\n')?.length, KEY_BYTES)
  assert.equal(parseKeyMaterial('too-short'), undefined)
  assert.equal(parseKeyMaterial('z'.repeat(64)), undefined)
})

test('resolveKey 优先使用环境变量且不落盘', async () => {
  await withTemp(async dir => {
    const key = generateKey()
    const file = join(dir, 'key')
    assert.equal(resolveKey(file, key.toString('hex')).toString('hex'), key.toString('hex'))
    await assert.rejects(() => readFile(file, 'utf8'), /ENOENT/u)
  })
})

test('resolveKey 环境变量格式非法时抛错（不静默换密钥）', async () => {
  await withTemp(async dir => {
    assert.throws(() => resolveKey(join(dir, 'key'), 'not-a-key'), /DSH_MEMORY_LAYER_KEY/u)
  })
})

test('resolveKey 首次运行生成密钥文件，后续运行复用同一密钥', async () => {
  await withTemp(async dir => {
    const file = join(dir, 'nested', 'memory.key')
    const first = resolveKey(file, undefined)
    const second = resolveKey(file, undefined)
    assert.equal(first.toString('hex'), second.toString('hex'), '不得每次运行都换密钥')

    const onDisk = await readFile(file, 'utf8')
    assert.equal(onDisk.trim(), first.toString('hex'))
    // 密钥文件权限收紧到 0600
    const info = await stat(file)
    assert.equal(info.mode & 0o077, 0, `密钥文件权限过宽：${(info.mode & 0o777).toString(8)}`)
  })
})

test('resolveKey 遇到损坏的密钥文件时报错而不是覆盖它', async () => {
  await withTemp(async dir => {
    const file = join(dir, 'key')
    await writeFile(file, 'garbage\n', 'utf8')
    assert.throws(() => resolveKey(file, undefined), /malformed/u)
    assert.equal((await readFile(file, 'utf8')).trim(), 'garbage')
  })
})

test('writeKeyFile 使用 0600 权限', async () => {
  await withTemp(async dir => {
    const file = join(dir, 'sub', 'key')
    writeKeyFile(file, generateKey())
    const info = await stat(file)
    assert.equal(info.mode & 0o077, 0, `密钥文件权限过宽：${(info.mode & 0o777).toString(8)}`)
  })
})

test('KEY_ENV 常量与文档一致', () => {
  assert.equal(KEY_ENV, 'DSH_MEMORY_LAYER_KEY')
})
