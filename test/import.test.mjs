#!/usr/bin/env node
'use strict'

/**
 * dsh-crossos 自测：从"另一套系统写下的会话目录"复制会话。
 *
 * 覆盖：sourceHome 解析、复制落位（保持源 cwd 的目录名）、已存在跳过、
 * 未命中映射跳过、目标不存在跳过、dryRun 不落盘、*.lock 不复制、
 * 多源去重、复制后能被迁移流程正常 rebase 并归组。
 *
 * 运行：node test/import.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { copyFromSources, sourceHome } = require('../src/import.cjs')
const engine = require('../src/engine.cjs')

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const zc = (s) => zlib.zstdCompressSync(Buffer.from(s, 'utf8'), CHECKSUM)

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    process.stdout.write(`  ✓ ${name}\n`)
  } catch (error) {
    failed++
    failures.push({ name, error })
    process.stdout.write(`  ✗ ${name}\n    ${error && error.message}\n`)
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-crossos-import-'))
const OTHER = path.join(TMP, 'other-dsh')
const DATA = path.join(TMP, 'data')
const PROJ = path.join(DATA, 'Projects/demo-app')
const WIN_CWD = 'D:\\Projects\\demo-app'
const LINUX_CWD = PROJ
const WIN_ID = 'session-cccc3333-0000-4000-8000-000000000003'
const WIN_ID2 = 'session-dddd4444-0000-4000-8000-000000000004'
const EVENTS = ['{"type":"user","text":"来自另一套系统"}', '{"type":"assistant","text":"hi"}']
const MAPS = [{ from: 'D:\\', to: DATA }]
const QUIET = { info() {}, warn() {} }

fs.mkdirSync(PROJ, { recursive: true })
fs.mkdirSync(path.join(DATA, 'Projects/other-app'), { recursive: true })
fs.mkdirSync(path.join(OTHER, 'sessions'), { recursive: true })

function newHome(name) {
  const home = path.join(TMP, name)
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
  return home
}

function mkSession(root, { id, cwd, events = EVENTS }) {
  const dir = path.join(root, 'sessions', engine.projectKey(cwd), engine.encodeSegment(id))
  fs.mkdirSync(dir, { recursive: true })
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1792397775242,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, Buffer.concat([zc(JSON.stringify(header) + '\n'), zc(events.join('\n') + '\n')]))
  return { dir, file }
}

const winSession = mkSession(OTHER, { id: WIN_ID, cwd: WIN_CWD })
mkSession(OTHER, { id: WIN_ID2, cwd: 'D:\\Projects\\other-app' })
fs.writeFileSync(path.join(winSession.dir, 'session.lock'), 'lock\n')

console.log('\nsourceHome')

test('home 目录原样返回', () => {
  assert.equal(sourceHome(OTHER), OTHER)
})

test('sessions 目录取其父目录', () => {
  assert.equal(sourceHome(path.join(OTHER, 'sessions')), OTHER)
})

test('~ 会被展开', () => {
  assert.equal(sourceHome('~/.dsh'), path.join(os.homedir(), '.dsh'))
})

console.log('\n复制')

test('把源会话复制进本机，保持源 cwd 的目录名', () => {
  const home = newHome('copy-basic')
  const result = copyFromSources({ home, sources: [OTHER], maps: MAPS, config: {}, log: QUIET })
  assert.equal(result.copied.length, 2)
  const item = result.copied.find((c) => c.session.id === WIN_ID)
  assert.equal(item.copied, true)
  assert.ok(fs.existsSync(item.destFile))
  assert.equal(path.basename(item.destDir), engine.encodeSegment(WIN_ID))
  assert.equal(path.basename(path.dirname(item.destDir)), engine.projectKey(WIN_CWD))
  // 复制阶段不改写 header，改写交给后续 rebase
  const header = engine.readHeader(item.destFile)
  assert.equal(header.cwd, WIN_CWD)
  // 事件行逐字节一致
  const before = engine.readLogText(winSession.file).text
  const after = engine.readLogText(item.destFile).text
  assert.equal(after, before)
})

test('*.lock 不复制', () => {
  const home = newHome('copy-nolock')
  const result = copyFromSources({ home, sources: [OTHER], maps: MAPS, config: {}, log: QUIET })
  const item = result.copied.find((c) => c.session.id === WIN_ID)
  assert.ok(!fs.existsSync(path.join(item.destDir, 'session.lock')))
})

test('本机已有同 id 会话时跳过', () => {
  const home = newHome('copy-existing')
  mkSession(home, { id: WIN_ID, cwd: WIN_CWD })
  const result = copyFromSources({ home, sources: [OTHER], maps: MAPS, config: {}, log: QUIET })
  assert.ok(!result.copied.some((c) => c.session.id === WIN_ID))
  assert.ok(result.skipped.some((s) => s.id === WIN_ID && s.reason.includes('已有同 id')))
})

test('源 cwd 未命中映射时跳过', () => {
  const home = newHome('copy-nomap')
  const result = copyFromSources({ home, sources: [OTHER], maps: [{ from: 'E:\\', to: DATA }], config: {}, log: QUIET })
  assert.equal(result.copied.length, 0)
  assert.ok(result.skipped.some((s) => s.reason.includes('未命中')))
})

test('requireTargetExists=true 时目标不存在则跳过', () => {
  const home = newHome('copy-notarget')
  const missing = path.join(TMP, 'not-mounted')
  const result = copyFromSources({
    home,
    sources: [OTHER],
    maps: [{ from: 'D:\\', to: missing }],
    config: { requireTargetExists: true },
    log: QUIET,
  })
  assert.equal(result.copied.length, 0)
  assert.ok(result.skipped.some((s) => s.reason.includes('不存在')))
})

test('requireTargetExists=false 时仍复制', () => {
  const home = newHome('copy-notarget-off')
  const missing = path.join(TMP, 'not-mounted')
  const result = copyFromSources({
    home,
    sources: [OTHER],
    maps: [{ from: 'D:\\', to: missing }],
    config: { requireTargetExists: false },
    log: QUIET,
  })
  assert.equal(result.copied.length, 2)
})

test('dryRun 只预览不落盘', () => {
  const home = newHome('copy-dry')
  const result = copyFromSources({ home, sources: [OTHER], maps: MAPS, config: {}, log: QUIET, dryRun: true })
  assert.equal(result.copied.length, 2)
  for (const item of result.copied) assert.ok(!fs.existsSync(item.destFile))
  assert.equal(engine.scanSessions(home, []).length, 0)
})

test('源目录不存在时给出警告而不崩溃', () => {
  const home = newHome('copy-missing')
  const result = copyFromSources({ home, sources: [path.join(TMP, 'nope')], maps: MAPS, config: {}, log: QUIET })
  assert.equal(result.copied.length, 0)
  assert.ok(result.warnings.some((w) => w.includes('不存在')))
})

test('源目录就是本机 DSH_HOME 时忽略', () => {
  const home = newHome('copy-self')
  const result = copyFromSources({ home, sources: [home], maps: MAPS, config: {}, log: QUIET })
  assert.equal(result.copied.length, 0)
  assert.ok(result.warnings.some((w) => w.includes('本机')))
})

test('多个源里的同一会话只复制一次', () => {
  const home = newHome('copy-multi')
  const result = copyFromSources({ home, sources: [OTHER, OTHER], maps: MAPS, config: {}, log: QUIET })
  assert.equal(result.copied.length, 2)
})

console.log('\n复制后再迁移')

test('复制进来的会话可被 rebase 到本机路径并归组', () => {
  const home = newHome('copy-then-rebase')
  copyFromSources({ home, sources: [OTHER], maps: MAPS, config: {}, log: QUIET })
  // 本机已有 Linux 侧工作区记录
  const ws = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'cffb8dfe-c8a9-4718-ba8b-b9b36b119760', workspaceIds: ['5cf2cf68-3878-444d-9206-71d5e3c423a4', 'cffb8dfe-c8a9-4718-ba8b-b9b36b119760'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        '5cf2cf68-3878-444d-9206-71d5e3c423a4': { path: LINUX_CWD, title: 'demo-app', sessionIds: [], createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' },
        'cffb8dfe-c8a9-4718-ba8b-b9b36b119760': { path: path.join(TMP, 'default-ws'), title: 'default', sessionIds: [], createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' },
      },
    },
  }
  fs.mkdirSync(ws.tables.workspaces['cffb8dfe-c8a9-4718-ba8b-b9b36b119760'].path, { recursive: true })
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify(ws, null, 2) + '\n')

  const plan = engine.buildPlan({
    home,
    maps: MAPS,
    adopt: true,
    requireTargetExists: true,
    skipCollisions: true,
    skipLive: true,
    onlyExistingWorkspacePaths: false,
  })
  assert.ok(plan.moves.length >= 2)
  engine.applyPlan(plan, { home, force: true, keepOld: false })

  for (const id of [WIN_ID, WIN_ID2]) {
    const found = engine.scanSessions(home, []).find((s) => s.id === id)
    assert.ok(found, `${id} 应在迁移后仍可列出`)
    assert.equal(found.cwd, id === WIN_ID ? LINUX_CWD : path.join(DATA, 'Projects/other-app'))
  }
  const after = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'))
  const records = Object.values(after.tables.workspaces)
  const linuxRecord = records.find((r) => r.path === LINUX_CWD)
  assert.ok(linuxRecord && linuxRecord.sessionIds.includes(WIN_ID))
  const otherRecord = records.find((r) => r.path === path.join(DATA, 'Projects/other-app'))
  assert.ok(otherRecord && otherRecord.sessionIds.includes(WIN_ID2))
})

/* ------------------------------------------------------------------ */

try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {}

console.log(`\nimport.test: ${passed} 通过，${failed} 失败`)
if (failed) {
  for (const f of failures) process.stderr.write(`\n失败：${f.name}\n${f.error && f.error.stack}\n`)
  process.exitCode = 1
}
