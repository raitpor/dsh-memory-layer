/**
 * 去标识化测试：凭据脱敏、占位符化、库符号保留与轻量泄漏检查。
 *
 * @module dsh-memory-layer/test/abstract.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  abstractText,
  classifyIdentifier,
  detectIdentifiers,
  findIdentifierLeaks,
  identifiersFromPaths,
} from '../src/abstract.js'

test('凭据在去标识化阶段先被脱敏', () => {
  const secret = 'sk-live-1234567890abcdefGHIJKL'
  const { text } = abstractText(`客户端使用 ${secret} 调用接口。`)
  assert.ok(!text.includes(secret))
  assert.match(text, /\[REDACTED:openai-key\]/u)
})

test('显式标识符被替换为种类化占位符', () => {
  const { text, placeholders } = abstractText(
    '在 OrderService 里调用 OrderPolicy，并读取 com.acme.orders 的配置。',
    { identifiers: ['OrderService', 'OrderPolicy', 'com.acme.orders'] },
  )
  assert.ok(!text.includes('OrderService'))
  assert.ok(!text.includes('com.acme.orders'))
  assert.match(text, /<Class1>/u)
  assert.match(text, /<Class2>/u)
  assert.match(text, /<pkg1>/u, '编号按种类各自计数')
  assert.deepEqual(placeholders['<Class1>'], 'OrderService')
})

test('占位符编号按首次出现顺序分配，同样输入产出同样结果', () => {
  const first = abstractText('Beta 先于 Alpha 出现。', { identifiers: ['Alpha', 'Beta'] })
  const second = abstractText('Beta 先于 Alpha 出现。', { identifiers: ['Alpha', 'Beta'] })
  assert.equal(first.text, second.text)
  assert.equal(first.placeholders['<Class1>'], 'Beta')
  assert.equal(first.placeholders['<Class2>'], 'Alpha')
})

test('库与 SDK 符号默认被保留（自动识别默认关闭）', () => {
  const { text } = abstractText('调用 Registry.register 注册 BlockItem，注解 @Mixin 保持不变。')
  assert.match(text, /Registry\.register/u, '库符号是技巧里最该保留的可复用部分')
  assert.match(text, /BlockItem/u)
})

test('自动识别是显式可选项，且只认高置信度形态', () => {
  const detected = detectIdentifiers('OrderService 与 com.acme.orders 都属于项目私有代码。')
  assert.ok(detected.includes('OrderService'))
  assert.ok(detected.includes('com.acme.orders'))
  assert.ok(!detected.includes('JSON'), '通用词不该被当成私有标识')

  const { text } = abstractText('OrderService 处理订单。', { autoDetect: true })
  assert.ok(!text.includes('OrderService'))
})

test('标识符种类判定', () => {
  assert.equal(classifyIdentifier('OrderService'), 'Class')
  assert.equal(classifyIdentifier('MAX_RETRY'), 'CONST')
  assert.equal(classifyIdentifier('com.acme.orders'), 'pkg')
  assert.equal(classifyIdentifier('order_service'), 'id')
})

test('从项目文件路径推导私有标识：比正则扫描可靠', () => {
  const identifiers = identifiersFromPaths([
    'src/main/java/com/acme/orders/OrderService.java',
    'src/main/java/com/acme/orders/OrderPolicy.kt',
    'src/store.ts',
    'README.md',
  ])
  assert.ok(identifiers.includes('OrderService'))
  assert.ok(identifiers.includes('OrderPolicy'))
  assert.ok(!identifiers.includes('store'), '过短的通用文件名不该入选')
})

test('外部绝对路径被抹掉', () => {
  const { text, placeholders } = abstractText('配置在 /home/victim/.ssh/id_rsa 下。')
  assert.ok(!text.includes('/home/victim/.ssh/id_rsa'))
  assert.match(text, /\[PATH\]/u)
  assert.equal(placeholders['[PATH]'], '/home/victim/.ssh/id_rsa')
})

test('轻量泄漏检查能发现残留标识符', () => {
  assert.deepEqual(findIdentifierLeaks('还在用 OrderService', ['OrderService']), ['OrderService'])
  assert.deepEqual(findIdentifierLeaks('已经换成 <Class1>', ['OrderService']), [])
})

test('空文本不产生映射', () => {
  const result = abstractText('')
  assert.equal(result.text, '')
  assert.deepEqual(result.placeholders, {})
})
