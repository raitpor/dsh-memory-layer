/**
 * 记忆库的本地加密：仅使用 Node 内置 `node:crypto`，不引入任何第三方依赖。
 *
 * 设计要点：
 *
 * 1. **算法**：AES-256-GCM（认证加密）。除机密性外还提供完整性校验 ——
 *    密文被篡改时解密直接失败，而不是返回被污染的明文。
 * 2. **粒度**：按**行**加解密。JSONL 天然按行存储；语义层 JSON 也写成单行，
 *    因此「行」对所有文件都等价于一个完整载荷，同时保留「单行损坏不影响其余」的特性。
 * 3. **兼容**：解码时遇到非 `enc:v1:` 前缀的行按明文返回，因此**旧明文记忆库仍可读**，
 *    会在下一次写入时自然转为密文。
 * 4. **密钥存放**：默认密钥文件放在记忆库目录内（`<dir>/.dsh-memory-layer.key`，权限 `0600`），
 *    使记忆库自包含、备份后可恢复。密钥与密文同处意味着「能读密文者也能读密钥」——
 *    若需要真正的隔离，请用环境变量 `DSH_MEMORY_LAYER_KEY` 注入密钥（此时密钥完全不落盘），
 *    或把 `keyFile` 指向记忆库之外的路径。
 *
 * @module dsh-memory-layer/crypto
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 加密算法：AES-256-GCM。 */
export const ALGORITHM = 'aes-256-gcm'

/** 密文行前缀（含版本号，便于将来换算法）。 */
export const CIPHER_PREFIX = 'enc:v1:'

/** 密钥长度（AES-256）。 */
export const KEY_BYTES = 32

/** GCM nonce 长度（12 字节是 GCM 推荐值）。 */
export const IV_BYTES = 12

/** GCM 认证标签长度。 */
export const TAG_BYTES = 16

/** 环境变量：直接注入密钥（hex 或 base64），设置后密钥不落盘。 */
export const KEY_ENV = 'DSH_MEMORY_LAYER_KEY'

/** 密钥文件默认文件名（放在记忆库目录内，使记忆库自包含可备份）。 */
export const KEY_FILE_NAME = '.dsh-memory-layer.key'

/** 密钥文件权限：仅属主可读。 */
export const KEY_FILE_MODE = 0o600

/** 单行编解码器：由 {@link createCodec} 产出，供存储层按行调用。 */
export interface StoreCodec {
  /**
   * 把一行明文编成待落盘的文本。
   * @param plain - 明文行。
   * @returns 待写入的文本行。
   */
  encode(plain: string): string
  /**
   * 把一行落盘文本还原为明文。密文解密失败时抛错。
   * @param stored - 落盘文本行。
   * @returns 明文行；非密文行原样返回（向后兼容旧明文记忆库）。
   */
  decode(stored: string): string
}

/**
 * 判断一行文本是否为密文。
 * @param line - 落盘文本行。
 * @returns 是密文时为 `true`。
 */
export function isEncrypted(line: string): boolean {
  return line.startsWith(CIPHER_PREFIX)
}

/**
 * 用密钥加密一段文本。
 * @param plain - 明文。
 * @param key - 32 字节密钥。
 * @returns `enc:v1:<iv>:<tag>:<ciphertext>`（各段为 base64）。
 */
export function encryptLine(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    CIPHER_PREFIX,
    iv.toString('base64'),
    ':',
    tag.toString('base64'),
    ':',
    ciphertext.toString('base64'),
  ].join('')
}

/**
 * 解密一行文本。非密文行原样返回，便于读取旧的明文记忆库。
 *
 * @param stored - 落盘文本行。
 * @param key - 32 字节密钥。
 * @returns 明文行。
 * @throws 当密文被篡改、密钥不匹配或格式非法时。
 */
export function decryptLine(stored: string, key: Buffer): string {
  if (!isEncrypted(stored)) return stored
  const parts = stored.slice(CIPHER_PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('memory-crypto: malformed ciphertext')
  const [ivPart, tagPart, dataPart] = parts as [string, string, string]
  const iv = Buffer.from(ivPart, 'base64')
  const tag = Buffer.from(tagPart, 'base64')
  const data = Buffer.from(dataPart, 'base64')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('memory-crypto: malformed ciphertext')
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/**
 * 用密钥构造存储层编解码器。
 * @param key - 32 字节密钥。
 * @returns 行级编解码器。
 */
export function createCodec(key: Buffer): StoreCodec {
  return {
    encode: plain => encryptLine(plain, key),
    decode: stored => decryptLine(stored, key),
  }
}

/**
 * 解析密钥文本（hex 或 base64）。
 * @param text - 环境变量或密钥文件的内容。
 * @returns 32 字节密钥；格式非法时返回 `undefined`。
 */
export function parseKeyMaterial(text: string): Buffer | undefined {
  const trimmed = text.trim()
  if (/^[0-9a-fA-F]{64}$/u.test(trimmed)) return Buffer.from(trimmed, 'hex')
  if (/^[A-Za-z0-9+/]{43}=?$/u.test(trimmed)) {
    const decoded = Buffer.from(trimmed, 'base64')
    if (decoded.length === KEY_BYTES) return decoded
  }
  return undefined
}

/**
 * 生成一个新的随机密钥。
 * @returns 32 字节密钥。
 */
export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/**
 * 把密钥写成密钥文件（权限 `0600`）。
 * @param file - 目标路径。
 * @param key - 32 字节密钥。
 */
export function writeKeyFile(file: string, key: Buffer): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: KEY_FILE_MODE })
}

/**
 * 解析本次运行使用的密钥。
 *
 * 优先级：环境变量 `DSH_MEMORY_LAYER_KEY` > 已有密钥文件 > 新建密钥文件。
 *
 * @param file - 密钥文件路径。
 * @param env - 环境变量取值（默认读 `process.env`）。
 * @returns 32 字节密钥。
 * @throws 当环境变量或密钥文件存在但格式非法时（宁可失败，也不要静默换密钥导致旧记忆不可读）。
 */
export function resolveKey(file: string, env: string | undefined = process.env[KEY_ENV]): Buffer {
  if (env !== undefined && env.trim().length > 0) {
    const parsed = parseKeyMaterial(env)
    if (parsed === undefined) {
      throw new Error(`memory-crypto: ${KEY_ENV} must be 64 hex characters or a base64-encoded 32-byte key`)
    }
    return parsed
  }
  try {
    const existing = parseKeyMaterial(readFileSync(file, 'utf8'))
    if (existing === undefined) throw new Error(`memory-crypto: key file "${file}" is malformed`)
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const key = generateKey()
  writeKeyFile(file, key)
  return key
}
