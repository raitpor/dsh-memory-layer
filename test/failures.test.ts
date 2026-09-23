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
  deriveTrigger,
  enforcementFor,
  failureApplies,
  failureDetail,
  failureLessonLine,
  failureTrigger,
  failureWarningLine,
  guardLiteralFromArguments,
  lessonMatches,
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


// ---- 白盒补充：分支矩阵（覆盖率显示这些分支此前从未被走到） ----------------------

test('deriveTrigger 的四种输入组合与全空兜底', () => {
  assert.equal(deriveTrigger({ tool: 'bash' }), '使用 bash 时')
  assert.match(deriveTrigger({ tool: 'bash', template: 'boom' }) ?? '', /使用 bash 时遇到「boom」/u)
  assert.equal(deriveTrigger({ errorName: 'ENOENT' }), '使用 ENOENT 时')
  assert.equal(deriveTrigger({ template: 'boom' }), '调用工具时遇到「boom」这类情况')
  assert.equal(deriveTrigger({}), undefined, '三者皆空时应返回 undefined')
  assert.equal(deriveTrigger({ tool: '', errorName: '', template: '   ' }), undefined, '空白不算内容')
})

test('failureTrigger：显式触发方式优先，**空白字符串**应回落到推导', () => {
  const explicit = record({ trigger: '改文件前没读' })
  assert.equal(failureTrigger(explicit), '改文件前没读')
  // 覆盖率显示这条分支此前没被走到：trigger 存在但只有空白。
  const blank = record({ trigger: '   ' })
  assert.match(failureTrigger(blank) ?? '', /使用 bash 时/u, '空白 trigger 应回落到指纹推导')

  const missing = record()
  assert.match(failureTrigger(missing) ?? '', /使用 bash 时遇到「boom」/u, '缺省时应由指纹推导')
  // 指纹里什么都没有时无从推导。
  assert.equal(failureTrigger(record({ fingerprint: { kind: 'semantic', key: 'k' } })), undefined)
})

test('failureLessonLine：未复发与已复发两种文案', () => {
  const fresh = failureLessonLine(record({ status: 'deprecated', remedy: '先建目录', trigger: '写报告前', occurrencesAtResolve: 3, occurrences: 3 }))
  assert.match(fresh, /\[已解决\]/u)
  assert.doesNotMatch(fresh, /解决后又触发/u, '未复发不应提复发次数')
  assert.match(fresh, /触发场景：写报告前/u)

  const relapsed = failureLessonLine(record({ status: 'deprecated', remedy: '先建目录', trigger: '写报告前', occurrencesAtResolve: 3, occurrences: 5 }))
  assert.match(relapsed, /已解决·解决后又触发 2 次/u, '解决后复发应据实写出')

  const noRemedy = failureLessonLine(record({ status: 'deprecated', remedy: '', trigger: '写报告前' }))
  assert.match(noRemedy, /没写做法/u, '没有做法时应明说')
})

test('failureDetail：已解决记录带上解决时间、复发次数与触发方式', () => {
  const detail = failureDetail(record({
    status: 'deprecated',
    remedy: '先建目录',
    trigger: '写报告前',
    resolvedAt: 1_700_000_000_000,
    occurrencesAtResolve: 2,
    occurrences: 4,
  }))
  assert.match(detail, /Trigger: 写报告前/u)
  assert.match(detail, /Resolved at: .*（解决后又触发 2 次）/u)
  const fresh = failureDetail(record({ status: 'deprecated', resolvedAt: 1_700_000_000_000, occurrencesAtResolve: 2, occurrences: 2 }))
  assert.match(fresh, /Resolved at: /u)
  assert.doesNotMatch(fresh, /解决后又触发/u)
})

test('lessonMatches：工具命中、两词重合、单词重合与无重合四档', () => {
  const target = record({ trigger: '写 report.json 之前忘了建目录', remedy: '先创建报告目录再写文件' })
  // ① 工具命中直接放行。
  assert.equal(lessonMatches(target, new Set(), new Set(['bash'])), true)
  // ② 词面重合 ≥2 → 放行。
  assert.equal(lessonMatches(target, new Set(['report', 'json']), new Set()), true)
  // ③ 只重合一个词 → 不放行（单词偶合太容易）。
  assert.equal(lessonMatches(target, new Set(['report']), new Set()), false)
  // ④ 完全不同的话题 → 不放行。
  assert.equal(lessonMatches(target, new Set(['plantuml', 'swimlane']), new Set(['read_file'])), false)
})

test('guardLiteralFromArguments：非标准参数名也取字面量，危险/过短/过长一律放弃', () => {
  // 覆盖率显示：从 Object.values 兜底取值的分支此前没被走到。
  assert.equal(guardLiteralFromArguments({ weird_key: 'npm test' }), 'npm test')
  assert.equal(guardLiteralFromArguments({ command: 'npm test', weird: 'x' }), 'npm test', '标准键优先')
  assert.equal(guardLiteralFromArguments({ command: '/etc/passwd' }), undefined, '含路径分隔符放弃')
  assert.equal(guardLiteralFromArguments({ command: 'AKIAIOSFODNN7EXAMPLE' }), undefined, '含凭据放弃')
  assert.equal(guardLiteralFromArguments({ command: 'ls' }), undefined, '过短放弃')
  assert.equal(guardLiteralFromArguments({ command: 'x'.repeat(200) }), undefined, '过长放弃')
  assert.equal(guardLiteralFromArguments({}), undefined, '没有字符串参数放弃')
  assert.equal(guardLiteralFromArguments(null), undefined)
})
