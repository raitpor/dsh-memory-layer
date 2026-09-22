/**
 * 失败经验层测试：指纹稳定性、升级阈值、守卫窄性与预警文案。
 *
 * 指纹是整个特性的技术核心 —— 若同一个错误在不同会话里算出不同的 key，
 * 「重复犯错」就永远识别不出来。因此这里对归一化的覆盖最密。
 *
 * @module dsh-memory-layer/test/failures.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  enforcementFor,
  failureApplies,
  failureWarningLine,
  guardMatches,
  isSelfDenial,
  machineFingerprint,
  machineFingerprintKey,
  normalizeErrorTemplate,
  observeToolFailure,
  semanticFingerprint,
  shouldWarn,
  SELF_DENIAL_CODE,
} from '../src/failures.js'
import type { FailureRecord } from '../src/types.js'

/** 造一条失败记录。 */
function record(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    id: 'fa_1',
    ts: 1,
    updatedAt: 1,
    scope: 'global',
    partition: 'default',
    fingerprint: { kind: 'machine', key: 'k', tool: 'bash', template: 'boom' },
    symptom: 'boom',
    remedy: '',
    enforcement: 'warn',
    occurrences: 2,
    prevented: 0,
    sessions: ['s1'],
    firstSeen: 1,
    lastSeen: 1,
    stack: { languages: ['java'] },
    evidence: [],
    status: 'validated',
    provenance: 'auto',
    ...overrides,
  }
}

test('归一化剥离路径、行号、地址、哈希、端口与字面量', () => {
  const raw = "Error: Cannot find module 'left-pad' at /home/u/proj/node_modules/x.js:42:17 (0x7ffee3a1) port 8080 took 120ms"
  const template = normalizeErrorTemplate(raw)
  assert.ok(!template.includes('/home/u/proj'), template)
  assert.ok(!template.includes('42'), template)
  assert.ok(!template.includes('0x7ffee3a1'), template)
  assert.ok(!template.includes('left-pad'), template)
  assert.ok(!template.includes('8080'), template)
  assert.ok(!template.includes('120ms'), template)
  assert.match(template, /Cannot find module/u)
})

test('版本号收敛为 VER，不与裸数字混为一谈', () => {
  const template = normalizeErrorTemplate('Unsupported class file major version 61 for 1.20.1')
  assert.match(template, /VER/u)
  assert.match(template, /version N/u)
})

test('同一个错误在不同路径、行号与取值下得到同一指纹', () => {
  const first = machineFingerprint({
    tool: 'bash',
    errorName: 'Error',
    errorCode: 'MODULE_NOT_FOUND',
    message: "Cannot find module 'aaa' at /work/a/node_modules/index.js:12:3",
  })
  const second = machineFingerprint({
    tool: 'bash',
    errorName: 'Error',
    errorCode: 'MODULE_NOT_FOUND',
    message: "Cannot find module 'bbbb' at /work/b/node_modules/other.js:987:41",
  })
  assert.ok(first !== undefined && second !== undefined)
  assert.equal(first.key, second.key, '跨会话识别同一个错误的前提')
})

test('错误类型不同则指纹不同', () => {
  const left = machineFingerprint({ tool: 'bash', errorName: 'TypeError', message: 'undefined is not a function' })
  const right = machineFingerprint({ tool: 'bash', errorName: 'RangeError', message: 'undefined is not a function' })
  assert.notEqual(left?.key, right?.key)
})

test('空消息不产生指纹（宁可漏记，也不造会误合并的空指纹）', () => {
  assert.equal(machineFingerprint({ tool: 'bash', message: '   \n  ' }), undefined)
})

test('指纹 key 由工具、错误名/码与模板共同决定', () => {
  const base = { tool: 'bash', errorName: 'E', errorCode: 'C', template: 't' }
  assert.equal(machineFingerprintKey(base), machineFingerprintKey({ ...base }))
  assert.notEqual(machineFingerprintKey(base), machineFingerprintKey({ ...base, tool: 'edit_file' }))
})

test('观测同时给出可读现象', () => {
  const observation = observeToolFailure({
    tool: 'bash',
    errorName: 'Error',
    message: 'first line\nsecond line',
  })
  assert.equal(observation?.symptom, 'first line')
})

test('语义指纹只做精确归一化匹配，过短文本不产生指纹', () => {
  const left = semanticFingerprint('不要用 npm，请用 pnpm')
  const right = semanticFingerprint('不要用 npm，请用 PNPM')
  assert.equal(left?.key, right?.key)
  assert.equal(semanticFingerprint('好'), undefined)
  assert.equal(left?.kind, 'semantic')
})

test('升级阈值：预警 → 询问 → 拦截', () => {
  const thresholds = { warn: 2, ask: 3, block: 5 }
  assert.equal(enforcementFor(1, thresholds), 'warn')
  assert.equal(enforcementFor(2, thresholds), 'warn')
  assert.equal(enforcementFor(3, thresholds), 'ask')
  assert.equal(enforcementFor(5, thresholds), 'block')
  assert.equal(enforcementFor(99, { warn: 2, ask: 3, block: 0 }), 'ask', 'block=0 表示永不硬拦截')
})

test('已解决的记录不再预警', () => {
  assert.equal(shouldWarn(record({ occurrences: 9 }), { warn: 2, ask: 3, block: 0 }), true)
  assert.equal(shouldWarn(record({ occurrences: 9, status: 'deprecated' }), { warn: 2, ask: 3, block: 0 }), false)
  assert.equal(shouldWarn(record({ occurrences: 1 }), { warn: 2, ask: 3, block: 0 }), false)
})

test('自身拒绝被识别，避免自我强化循环', () => {
  assert.equal(isSelfDenial(SELF_DENIAL_CODE, undefined), true)
  assert.equal(isSelfDenial(undefined, SELF_DENIAL_CODE), true)
  assert.equal(isSelfDenial('MODULE_NOT_FOUND', 'Error'), false)
})

test('守卫匹配必须窄：没有任何约束条件时一律不命中', () => {
  assert.equal(guardMatches({ tool: 'bash' }, 'bash', { command: 'rm -rf /' }), false)
  assert.equal(guardMatches({ tool: 'bash', allOf: ['rm -rf'] }, 'bash', { command: 'rm -rf /' }), true)
  assert.equal(guardMatches({ tool: 'bash', allOf: ['rm -rf'] }, 'edit_file', { command: 'rm -rf /' }), false)
  assert.equal(guardMatches({ tool: 'bash', argKeys: ['command'] }, 'bash', { file_path: 'x' }), false)
  assert.equal(guardMatches({ tool: 'bash', pattern: '^rm ' }, 'bash', { command: 'rm -rf /' }), false, 'pattern 作用于 JSON 文本')
  assert.equal(guardMatches({ tool: 'bash', pattern: 'rm ' }, 'bash', { command: 'rm -rf /' }), true)
  assert.equal(guardMatches({ tool: 'bash', pattern: '([' }, 'bash', { command: 'x' }), false, '非法正则不命中')
})

test('适用性沿用技巧层口径', () => {
  assert.equal(failureApplies(record(), { languages: ['java'] }), true)
  assert.equal(failureApplies(record(), { languages: ['typescript'] }), false)
  assert.equal(failureApplies(record(), undefined), true)
})

test('预警文案：有 remedy 给 remedy，没有就明确要求先定位根因', () => {
  const withRemedy = failureWarningLine(record({ remedy: '先执行 authorize' }), ['src/a.java'])
  assert.match(withRemedy, /已重复 2 次/u)
  assert.match(withRemedy, /先执行 authorize/u)
  assert.match(withRemedy, /src\/a\.java/u)

  const without = failureWarningLine(record({ remedy: '' }))
  assert.match(without, /先定位根因/u)
  assert.ok(!without.includes('正确做法'))
})
