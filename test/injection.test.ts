/**
 * 注入层测试：条目整形（去重复标题 + 逐条封顶）与注入块的固定开销。
 *
 * @module dsh-memory-layer/test/injection
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RECALL_ENTRY_CHARS, compactEntryText } from '../src/injection.js'

test('注入条目：与正文重复的标题只保留一份', () => {
  const title = '把注入成本降下来，哪些地方能省'
  const text = [
    title,
    '会话共 2 轮。 请求：把注入成本降下来，哪些地方能省。 过程：bash、read 结果：已列出清单。',
    'src/index.ts',
  ].join('\n')
  const compact = compactEntryText(text)
  assert.ok(!compact.startsWith(title), `标题不该再印一遍：${compact.slice(0, 60)}`)
  assert.equal(compact.split(title).length - 1, 1, '同一段话只应出现一次')
  assert.match(compact, /已列出清单/u, '正文必须留下')
})

test('注入条目：短标题或正文未包含标题时不误删', () => {
  // 语义事实是单行，没有标题可去重。
  assert.equal(compactEntryText('用户要求先跑测试再提交。'), '用户要求先跑测试再提交。')
  // 标题只有几个字符时不做包含判断（太容易误判）。
  const short = ['小结', '小结：本次改动集中在注入路径。'].join('\n')
  assert.match(compactEntryText(short), /^小结/u, '过短的标题不参与去重')
})

test('注入条目：逐条封顶，且截断有标记', () => {
  const long = `${'很长的一段过程描述。'.repeat(100)}结尾标记`
  const compact = compactEntryText(long)
  assert.equal(compact.length, RECALL_ENTRY_CHARS, '应正好收敛到上限')
  assert.ok(compact.endsWith('…'), '截断要有标记')
  assert.ok(!compact.includes('结尾标记'), '超出部分应被丢弃')
  assert.ok(!compact.includes('\n'), '注入条目压成一行，避免撑高块体')
})
