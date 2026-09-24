/**
 * 可选的 **SQLite/FTS5 检索索引**。
 *
 * 定位（重要）：它**不是**真源。真源永远是 `<dir>` 下的 JSONL/JSON —— 可读、可审计、
 * 可加密、可手工修。本模块只是从真源派生出来的**可重建索引**，因此：
 *
 * - 建不起来、读不出来、版本不匹配 → 直接回退到内存 BM25（`recallTechniques`），不报错；
 * - 索引文件损坏 → 下次 `build()` 覆盖重写即可；
 * - `node:sqlite` 在旧 Node 上不存在 → `available()` 返回 `false`，调用方走内存路径。
 *
 * 为什么值得引入（实测依据）：
 * 1. **列权重 BM25**：FTS5 的 `bm25(table, w1, …, wn)` 直接给字段加权，不必自己实现 BM25F；
 * 2. **结构化过滤**：状态/分区/语言在 SQL 里过滤，规模上来后不必每次全量扫内存；
 * 3. **中文必须自己分词**：FTS5 开箱对中文无效（`unicode61` 把整段中文当一个 token，
 *    `trigram` 把整句当短语 —— 实测三条中文查询全部 0 命中）。因此**写入时按字段预分词**
 *    （复用 `tokenize`：中文出二字 bigram、拉丁出词），查询也走同一套分词，
 *    这样既能命中中文，又保住列权重。
 *
 * @module dsh-memory-layer/sqlite-index
 */

import { createRequire } from 'node:module'
import { tokenize } from './recall.js'
import { stacksCompatible } from './stack/index.js'
import type { StackProfile, TechniqueRecord } from './types.js'

/** 索引里的字段权重（越大越重要）。顺序必须与 {@link COLUMNS} 一致。 */
const COLUMN_WEIGHTS = [12, 10, 8, 4, 2, 3] as const

/** FTS5 列顺序：与 {@link COLUMN_WEIGHTS} 一一对应。 */
const COLUMNS = ['name', 'subject', 'when_text', 'summary', 'tags', 'api'] as const

/** `node:sqlite` 的最小契约（只用到这里出现的成员，便于测试替身与旧 Node 回退）。 */
interface SqliteStatement {
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

/** 数据库句柄的最小契约。 */
export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

/** `node:sqlite` 模块里我们用到的部分。 */
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase
}

/**
 * 探测 `node:sqlite` 是否可用（Node ≥ 22.5 内置；旧版本直接回退）。
 * @returns 可用时返回模块，否则 `undefined`。
 */
export function loadSqlite(): SqliteModule | undefined {
  try {
    const require = createRequire(import.meta.url)
    const module = require('node:sqlite') as SqliteModule
    return typeof module.DatabaseSync === 'function' ? module : undefined
  } catch {
    return undefined
  }
}

/**
 * 把一段文本预分词成 FTS5 可索引的空格串。
 *
 * 中文出二字 bigram、拉丁出词（复用检索口的分词器，保证**写入与查询口径一致**）：
 * 口径不一致是这类索引最隐蔽的坑 —— 索引里是 bigram、查询里是整句，命中率直接归零。
 *
 * @param text - 原始文本。
 * @returns 空格分隔的 token 串。
 */
export function segment(text: string): string {
  return tokenize(text).join(' ')
}

/**
 * 把查询变成 FTS5 的 `MATCH` 表达式：每个 token 作为一个短语，用 OR 连接。
 * @param query - 用户查询。
 * @returns MATCH 表达式；无 token 时为空串。
 */
export function matchExpression(query: string): string {
  const tokens = tokenize(query)
  if (tokens.length === 0) return ''
  // 引号包住每个 token：避免 bigram 里的符号被 FTS5 当成语法。
  return tokens.map(token => `"${token.replace(/"/gu, '""')}"`).join(' OR ')
}

/** 建表语句。`status`/`partition`/`langs` 是普通列，供 SQL 侧过滤。 */
const CREATE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS technique_index USING fts5(
  id UNINDEXED, status UNINDEXED, partition UNINDEXED, langs UNINDEXED,
  ${COLUMNS.join(', ')},
  tokenize = 'unicode61'
)`

/**
 * 技巧层的 SQLite 索引。
 *
 * 生命周期由调用方掌握：`refresh()` 时若语料签名变化就 `build()`（全量重建，
 * 几百条记录是毫秒级）；查询失败或索引缺失时 `search()` 返回 `undefined`，
 * 调用方据此回退到内存 BM25。
 */
export class SqliteTechniqueIndex {
  /** 上次建索引时的语料签名，用于跳过无变化的重建。 */
  private signature = ''

  /**
   * @param file - 索引文件路径（可重建，丢了不影响真源）。
   * @param database - 已打开的数据库句柄；缺省时按 `file` 自行打开。
   */
  constructor(private readonly file: string, private readonly database?: SqliteDatabase) {}

  /**
   * 全量重建索引（幂等）。签名未变时直接跳过。
   *
   * @param records - 当前全部技巧记录（真源读出）。
   * @returns 是否真的重建了。
   */
  build(records: readonly TechniqueRecord[]): boolean {
    const next = signatureOf(records)
    if (next === this.signature) return false
    const db = this.open()
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(CREATE_SQL)
    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM technique_index')
      const insert = db.prepare(
        `INSERT INTO technique_index (id, status, partition, langs, ${COLUMNS.join(', ')})
         VALUES (?, ?, ?, ?, ${COLUMNS.map(() => '?').join(', ')})`,
      )
      for (const record of records) {
        const languages = record.stack.languages.join(',')
        insert.run(
          record.id,
          record.status,
          record.partition,
          languages,
          segment(record.name),
          segment(record.subject ?? ''),
          segment(record.when),
          segment(record.summary),
          segment(record.tags.join(' ')),
          segment((record.api ?? []).map(surface => `${surface.symbol} ${surface.signature ?? ''}`).join(' ')),
        )
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    this.signature = next
    return true
  }

  /** 惰性打开数据库（构造时无句柄的场合）。 */
  private opened: SqliteDatabase | undefined

  /** 取（并缓存）数据库句柄。 */
  private open(): SqliteDatabase {
    if (this.database !== undefined) return this.database
    if (this.opened !== undefined) return this.opened
    const module = loadSqlite()
    if (module === undefined) throw new Error('node:sqlite is not available')
    this.opened = new module.DatabaseSync(this.file)
    return this.opened
  }

  /**
   * 按查询取回排序后的技巧 id。
   *
   * @param query - 查询文本（与写入同一套分词）。
   * @param limit - 返回条数上限。
   * @param options - 与内存路径同口径的过滤条件。
   * @returns 命中的 id（按相关度倒序）；索引不可用或无 token 时返回 `undefined` 表示**该回退**。
   */
  search(
    query: string,
    limit: number,
    options: { includeDrafts?: boolean; partition?: string; stack?: StackProfile } = {},
  ): string[] | undefined {
    if (limit <= 0) return []
    const match = matchExpression(query)
    if (match.length === 0) return undefined
    let db: SqliteDatabase
    try {
      db = this.open()
    } catch {
      return undefined
    }
    const clauses = [`technique_index MATCH ?`]
    const params: unknown[] = [match]
    if (options.includeDrafts !== true) {
      clauses.push(`status IN ('validated', 'canonical')`)
    }
    clauses.push(`status <> 'deprecated'`)
    if (options.partition !== undefined) {
      clauses.push('partition = ?')
      params.push(options.partition)
    }
    const sql = `SELECT id, langs FROM technique_index WHERE ${clauses.join(' AND ')}
      ORDER BY bm25(technique_index, ${COLUMN_WEIGHTS.join(', ')}) LIMIT ?`
    try {
      // 语言兼容性在内存里判（`stacksCompatible` 的语义不该在 SQL 里重写一遍）：
      // 多取一些候选，过滤后再截断。
      const rows = db.prepare(sql).all(...params, Math.max(limit * 4, 40)) as { id: string; langs: string }[]
      const out: string[] = []
      for (const row of rows) {
        const languages = row.langs.length === 0 ? [] : row.langs.split(',')
        if (!stacksCompatible({ languages }, options.stack)) continue
        out.push(row.id)
        if (out.length >= limit) break
      }
      return out
    } catch {
      // 索引损坏/被外部删表：当作不可用，让调用方回退。
      return undefined
    }
  }

  /** 关闭句柄（进程退出或配置切换时调用）。 */
  close(): void {
    try {
      this.opened?.close()
    } catch {
      // 关闭失败不影响真源。
    }
    this.opened = undefined
  }
}

/**
 * 语料签名：条数 + 最近更新时间 + 状态分布，足以发现任何写入。
 * @param records - 技巧记录。
 * @returns 签名字符串。
 */
function signatureOf(records: readonly TechniqueRecord[]): string {
  let latest = 0
  let verified = 0
  for (const record of records) {
    latest = Math.max(latest, record.updatedAt)
    if (record.status === 'validated' || record.status === 'canonical') verified += 1
  }
  return `${records.length}:${latest}:${verified}`
}
