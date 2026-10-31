#!/usr/bin/env node
'use strict'

/**
 * dsh-crossos 自测：在临时 DSH_HOME 里造出"Windows 侧写下的会话"与
 * "Linux 侧已有工作区"，验证插件的配置解析、计划、迁移、归组、备份、幂等。
 *
 * 运行：node test/plugin.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

const { loadConfig, normalizeMaps, bidirectional } = require('../src/config.cjs')
const plugin = require('../src/index.cjs')
const engine = require('../src/engine.cjs')

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const zc = (s) => zlib.zstdCompressSync(Buffer.from(s, 'utf8'), CHECKSUM)

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    const out = fn()
    if (out instanceof Promise) throw new Error('同步测试不接受 Promise')
    passed++
    process.stdout.write(`  ✓ ${name}\n`)
  } catch (error) {
    failed++
    failures.push({ name, error })
    process.stdout.write(`  ✗ ${name}\n    ${error && error.message}\n`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    process.stdout.write(`  ✓ ${name}\n`)
  } catch (error) {
    failed++
    failures.push({ name, error })
    process.stdout.write(`  ✗ ${name}\n    ${error && error.message}\n`)
  }
}

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-crossos-test-'))
const HOME = path.join(TMP, 'dsh')
const DATA = path.join(TMP, 'data') // 模拟本机 /mnt/data 挂载点
const PROJ = path.join(DATA, 'Projects/demo-app')
const WIN_CWD = 'D:\\Projects\\demo-app'
const LINUX_CWD = PROJ

fs.mkdirSync(PROJ, { recursive: true })
fs.mkdirSync(path.join(HOME, 'storages'), { recursive: true })
fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true })

const WS_ID = '5cf2cf68-3878-444d-9206-71d5e3c423a4'
const WS_DEFAULT = 'cffb8dfe-c8a9-4718-ba8b-b9b36b119760'
const DEFAULT_DIR = path.join(TMP, 'default-ws')
fs.mkdirSync(DEFAULT_DIR, { recursive: true })

const S_WIN = 'session-aaaa1111-0000-4000-8000-000000000001'
const S_LINUX = 'session-bbbb2222-0000-4000-8000-000000000002'
const EVENTS = ['{"type":"user","text":"你好"}', '{"type":"assistant","text":"hi"}', '{"type":"user","text":"再来"}']
const LINUX_EVENTS = ['{"type":"user","text":"linux 侧"}']
const WIN_HEADER = { type: 'session', version: 4, id: S_WIN, createdAt: 1792397775242, cwd: WIN_CWD, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
const LINUX_HEADER = { type: 'session', version: 4, id: S_LINUX, createdAt: 1793287857575, cwd: LINUX_CWD, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }

function mkSession({ id, header, events, cwd = header.cwd }) {
  const dir = path.join(HOME, 'sessions', engine.projectKey(cwd), engine.encodeSegment(id))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const frames = [zc(JSON.stringify(header) + '\n'), zc(events.join('\n') + '\n')]
  fs.writeFileSync(file, Buffer.concat(frames))
  return { dir, file }
}

const winSession = mkSession({ id: S_WIN, header: WIN_HEADER, events: EVENTS })
const linuxSession = mkSession({ id: S_LINUX, header: LINUX_HEADER, events: LINUX_EVENTS })

fs.writeFileSync(
  path.join(HOME, 'storages/workspace.json'),
  JSON.stringify(
    {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        defaultWorkspaceId: WS_DEFAULT,
        workspaceIds: [WS_ID, WS_DEFAULT],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
      tables: {
        workspaces: {
          [WS_ID]: { path: LINUX_CWD, title: 'demo-app', sessionIds: [S_LINUX], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' },
          [WS_DEFAULT]: { path: DEFAULT_DIR, title: 'default-workspace', sessionIds: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
        },
      },
    },
    null,
    2
  ) + '\n'
)

// projcache：Windows 会话带旧 cwd
fs.mkdirSync(path.join(HOME, 'storages/session_projcache/sessions'), { recursive: true })
fs.writeFileSync(
  path.join(HOME, 'storages/session_projcache/sessions', S_WIN + '.json'),
  JSON.stringify({ version: 7, record: { identity: { formatVersion: 4, createdAt: WIN_HEADER.createdAt, cwd: WIN_CWD }, rows: { title: { ver: 1, seq: 0, val: '旧标题' } } } }, null, 2)
)

function quietLog() {
  const lines = []
  return { lines, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]) }
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

process.stdout.write('\n配置解析\n')

test('字符串映射与对象映射都能规范化', () => {
  assert.deepEqual(normalizeMaps(['D:\\=/mnt/data', { windows: 'E:\\work', linux: '/mnt/work' }]), [
    { from: 'D:\\', to: '/mnt/data' },
    { from: 'E:\\work', to: '/mnt/work' },
  ])
})

test('映射自动展开成双向', () => {
  const both = bidirectional([{ from: 'D:\\', to: '/mnt/data' }])
  assert.equal(both.length, 2)
  assert.equal(engine.mapPath('D:\\Projects\\a', both), '/mnt/data/Projects/a')
  assert.equal(engine.mapPath('/mnt/data/Projects/a', both), 'D:\\Projects\\a')
})

test('非法映射会报错', () => {
  assert.throws(() => normalizeMaps(['没有等号']), /FROM=TO/)
  assert.throws(() => normalizeMaps([{}]), /无法识别/)
})

test('crossos.json 提供 maps，cordis 配置可覆盖', () => {
  const home2 = path.join(TMP, 'home2')
  fs.mkdirSync(home2, { recursive: true })
  fs.writeFileSync(path.join(home2, 'crossos.json'), JSON.stringify({ maps: ['D:\\=/mnt/data'], keepOld: true }))
  const a = loadConfig({ home: home2 })
  assert.equal(a.mapsDeclared.length, 1)
  assert.equal(a.config.keepOld, true)
  const b = loadConfig({ home: home2, maps: ['E:\\=/mnt/e'] })
  assert.equal(b.mapsDeclared[0].from, 'E:\\')
  const c = loadConfig({ home: home2, maps: [] }) // bundle patch 的默认空数组不应盖掉文件配置
  assert.equal(c.mapsDeclared.length, 1)
})

/* ------------------------------------------------------------------ */
/* 迁移                                                                */
/* ------------------------------------------------------------------ */

process.stdout.write('\n规划与执行\n')

const MAPS = bidirectional([{ from: 'D:\\', to: DATA }])

await testAsync('dry-run 不写任何文件', async () => {
  const log = quietLog()
  const before = fs.readFileSync(winSession.file)
  const summary = await plugin.runMigration({ home: HOME, maps: MAPS, config: { adoptWorkspace: true, requireTargetExists: true, skipCollision: true, skipLive: true }, log, dryRun: true })
  {
    assert.equal(summary.moves, 1)
    assert.equal(summary.done.length, 0)
    assert.deepEqual(fs.readFileSync(winSession.file), before)
    assert.ok(log.lines.some(([lvl, m]) => lvl === 'info' && m.includes('dry-run')))
  }
})

const applyOnce = async () => {
  const log = quietLog()
  const summary = await plugin.runMigration({
    home: HOME,
    maps: MAPS,
    config: { adoptWorkspace: true, requireTargetExists: true, skipCollision: true, skipLive: true },
    log,
    dryRun: false,
  })
  return { summary, log }
}

let firstRun

await testAsync('apply 迁移 Windows 会话到本机 projectKey', async () => {
  firstRun = await applyOnce()
  assert.equal(firstRun.summary.done.length, 1, JSON.stringify(firstRun.summary))
  const d = firstRun.summary.done[0]
  assert.equal(d.id, S_WIN)
  assert.equal(d.to, LINUX_CWD)
  const targetDir = path.join(HOME, 'sessions', engine.projectKey(LINUX_CWD), engine.encodeSegment(S_WIN))
  assert.ok(fs.existsSync(path.join(targetDir, 'session.v4.jsonl.zstd')), '目标日志不存在')
  assert.ok(!fs.existsSync(winSession.dir), '旧目录未移走')
})

test('header 被改写为本机路径，事件行逐字节保留', () => {
  const targetFile = path.join(HOME, 'sessions', engine.projectKey(LINUX_CWD), engine.encodeSegment(S_WIN), 'session.v4.jsonl.zstd')
  const text = engine.readLogText(targetFile).text
  const lines = text.split('\n')
  const header = JSON.parse(lines[0])
  assert.equal(header.cwd, LINUX_CWD)
  assert.equal(header.id, S_WIN)
  assert.equal(header.createdAt, WIN_HEADER.createdAt)
  assert.deepEqual(lines.slice(1).filter(Boolean), EVENTS)
})

test('workspace.json 把会话归入同路径记录，且不新建重复记录', () => {
  const data = JSON.parse(fs.readFileSync(path.join(HOME, 'storages/workspace.json'), 'utf8'))
  const ids = Object.keys(data.tables.workspaces)
  assert.equal(ids.length, 2, '不应新增记录')
  const rec = data.tables.workspaces[WS_ID]
  assert.equal(rec.path, LINUX_CWD)
  assert.ok(rec.sessionIds.includes(S_WIN), '会话未归组')
  assert.ok(rec.sessionIds.includes(S_LINUX))
  assert.equal(data.global.defaultWorkspaceId, WS_DEFAULT)
})

test('projcache 的 cwd 被修正、标题保留', () => {
  const file = path.join(HOME, 'storages/session_projcache/sessions', S_WIN + '.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(data.record.identity.cwd, LINUX_CWD)
  assert.equal(data.record.rows.title.val, '旧标题')
})

test('生成备份目录', () => {
  const root = path.join(HOME, 'backups', 'dsh-crossos')
  assert.ok(fs.existsSync(root))
  const dirs = fs.readdirSync(root)
  assert.ok(dirs.length >= 1)
})

await testAsync('幂等：再跑一次没有需要迁移的会话', async () => {
  const summary = await plugin
    .runMigration({
      home: HOME,
      maps: MAPS,
      config: { adoptWorkspace: true, requireTargetExists: true, skipCollision: true, skipLive: true },
      log: quietLog(),
      dryRun: true,
    })
  assert.equal(summary.moves, 0)
  assert.equal(summary.scanned, 2)
})

/* ------------------------------------------------------------------ */
/* 边界                                                                */
/* ------------------------------------------------------------------ */

process.stdout.write('\n边界\n')

function freshHome(name) {
  const home = path.join(TMP, name)
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'storages/workspace.json'),
    JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, defaultWorkspaceId: null, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } })
  )
  return home
}

function putSession(home, id, header, events) {
  const dir = path.join(home, 'sessions', engine.projectKey(header.cwd), engine.encodeSegment(id))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, Buffer.concat([zc(JSON.stringify(header) + '\n'), zc(events.join('\n') + '\n')]))
  return { dir, file }
}

await testAsync('目标路径不存在时跳过，不迁移', async () => {
  const home = freshHome('skip-missing')
  const opts = { type: 'session', version: 4, id: 'session-cccc3333-0000-4000-8000-000000000003', createdAt: 1, cwd: 'D:\\nope\\missing', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  const s = putSession(home, opts.id, opts, ['{"type":"user","text":"x"}'])
  const summary = await plugin.runMigration({ home, maps: MAPS, config: { requireTargetExists: true, skipCollision: true, skipLive: true }, log: quietLog(), dryRun: false })
  assert.equal(summary.moves, 0)
  assert.ok(fs.existsSync(s.file), '不该动不存在的目标')
  assert.ok(summary.warnings.some((w) => w.includes('目标目录不存在')))
})

await testAsync('目标目录已被别的会话占用时跳过', async () => {
  const home = freshHome('skip-collision')
  const idA = 'session-dddd4444-0000-4000-8000-000000000004'
  const idB = 'session-eeee5555-0000-4000-8000-000000000005'
  // 两个会话 cwd 相同：先放一个"正常"的
  const header = { type: 'session', version: 4, id: idB, createdAt: 1, cwd: LINUX_CWD, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  putSession(home, idB, header, ['{"type":"user","text":"b"}'])
  // 再放一个 Windows 会话，目标 projectKey 与 idB 不同目录，构造冲突：手工占位
  const winH = { type: 'session', version: 4, id: idA, createdAt: 1, cwd: WIN_CWD, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  const s = putSession(home, idA, winH, ['{"type":"user","text":"a"}'])
  const targetDir = path.join(home, 'sessions', engine.projectKey(LINUX_CWD), engine.encodeSegment(idA))
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(path.join(targetDir, 'session.v4.jsonl.zstd'), zc('occupied'))
  const summary = await plugin.runMigration({ home, maps: MAPS, config: { requireTargetExists: true, skipCollision: true, skipLive: true }, log: quietLog(), dryRun: false })
  assert.equal(summary.moves, 0)
  assert.ok(fs.existsSync(s.file), '原会话不该被移动')
  assert.ok(summary.warnings.some((w) => w.includes('已被另一个会话占用')))
})

await testAsync('bin status --json 输出合法 JSON', async () => {
  const out = execFileSync(process.execPath, [path.join(here, '..', 'bin', 'crossos.cjs'), 'status', '--json', '--home', HOME, '--map', 'D:\\=' + DATA], { encoding: 'utf8' })
  const data = JSON.parse(out)
  assert.ok(Array.isArray(data.sessions))
  assert.equal(data.sessions.length, 2)
})

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

process.stdout.write('\n插件入口\n')

function fakeCtx() {
  const calls = []
  const effects = []
  const apiSpecs = []
  const webServer = {
    register(spec) {
      apiSpecs.push(spec)
      return () => {}
    },
  }
  const ctx = {
    logger: {
      info: (m) => calls.push(['info', m]),
      warn: (m) => calls.push(['warn', m]),
    },
    effect(fn, label) {
      effects.push({ fn, label })
      return () => {}
    },
    inject(deps, callback) {
      if (Array.isArray(deps) && deps.includes('webServer')) callback({ webServer })
    },
  }
  return { ctx, calls, effects, apiSpecs }
}

function runEffects(effects) {
  for (const e of effects) e.fn()
}

await testAsync('无 maps 时仍注册设置页 API，但不注册启动迁移', async () => {
  const { ctx, calls, effects, apiSpecs } = fakeCtx()
  plugin.apply(ctx, { home: path.join(TMP, 'empty-home'), maps: [] })
  assert.ok(calls.some(([, m]) => m.includes('maps 为空')))
  assert.equal(effects.filter((e) => String(e.label).includes('启动迁移')).length, 0)
  runEffects(effects)
  assert.equal(apiSpecs.length, 1, '应注册一个设置页 API 路由')
  assert.equal(apiSpecs[0].kind, 'prefix')
  assert.equal(apiSpecs[0].path, '/dsh-crossos/api')
})

await testAsync('auto 模式下启动 effect 会完成迁移', async () => {
  const home = freshHome('auto-home')
  const header = { type: 'session', version: 4, id: 'session-ffff6666-0000-4000-8000-000000000006', createdAt: 1, cwd: WIN_CWD, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  putSession(home, header.id, header, ['{"type":"user","text":"auto"}'])
  const { ctx, calls, effects } = fakeCtx()
  plugin.apply(ctx, { home, maps: ['D:\\=' + DATA] })
  assert.equal(effects.filter((e) => String(e.label).includes('启动迁移')).length, 1, '应注册一个启动 effect')
  runEffects(effects)
  await new Promise((r) => setTimeout(r, 200))
  const targetDir = path.join(home, 'sessions', engine.projectKey(LINUX_CWD), engine.encodeSegment(header.id))
  assert.ok(fs.existsSync(path.join(targetDir, 'session.v4.jsonl.zstd')), '启动迁移没有落位：' + JSON.stringify(calls))
  assert.ok(fs.existsSync(path.join(home, 'crossos', 'last-run.json')), '未写运行报告')
})

await testAsync('sources 里的会话在启动时被复制并迁移', async () => {
  const home = freshHome('auto-sources-home')
  const srcHome = path.join(TMP, 'auto-sources-src')
  const srcCwd = 'E:\\Projects\\src-app'
  const target = path.join(TMP, 'auto-sources-target', 'Projects', 'src-app')
  fs.mkdirSync(target, { recursive: true })
  const srcHeader = { type: 'session', version: 4, id: 'session-9999aaaa-0000-4000-8000-000000000009', createdAt: 1, cwd: srcCwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  const srcDir = path.join(srcHome, 'sessions', engine.projectKey(srcCwd), engine.encodeSegment(srcHeader.id))
  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(path.join(srcDir, 'session.v4.jsonl.zstd'), Buffer.concat([zc(JSON.stringify(srcHeader) + '\n'), zc('{"type":"user","text":"src"}\n')]))

  const { ctx, calls, effects } = fakeCtx()
  plugin.apply(ctx, { home, maps: ['E:\\Projects\\src-app=' + target], sources: [srcHome] })
  assert.equal(effects.filter((e) => String(e.label).includes('启动迁移')).length, 1)
  runEffects(effects)
  await new Promise((r) => setTimeout(r, 300))

  const destDir = path.join(home, 'sessions', engine.projectKey(target), engine.encodeSegment(srcHeader.id))
  const destFile = path.join(destDir, 'session.v4.jsonl.zstd')
  assert.ok(fs.existsSync(destFile), '启动时没有复制并迁移：' + JSON.stringify(calls))
  assert.equal(engine.readHeader(destFile).cwd, target, 'header cwd 应改写为本机路径')
  const report = JSON.parse(fs.readFileSync(path.join(home, 'crossos', 'last-run.json'), 'utf8'))
  assert.equal(report.imported.copied, 1, '运行报告应记录复制数量')
})

await testAsync('宿主自身被识别为"运行中的 DSH"时，启动迁移仍会执行', async () => {
  const home = freshHome('busy-home')
  const header = { type: 'session', version: 4, id: 'session-ffff7777-0000-4000-8000-000000000007', createdAt: 1, cwd: WIN_CWD, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  putSession(home, header.id, header, ['{"type":"user","text":"busy"}'])

  // 造一个 cmdline 含 "dsh web"、DSH_HOME 指向测试 home 的存活进程，
  // 模拟"插件正在宿主进程内运行"这一真实场景。
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)', 'dsh', 'web'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: 'ignore',
  })
  try {
    await new Promise((r) => setTimeout(r, 200))
    const { ctx, calls, effects } = fakeCtx()
    plugin.apply(ctx, { home, maps: ['D:\\=' + DATA] })
    runEffects(effects)
    await new Promise((r) => setTimeout(r, 500))
    const targetDir = path.join(home, 'sessions', engine.projectKey(LINUX_CWD), engine.encodeSegment(header.id))
    assert.ok(
      fs.existsSync(path.join(targetDir, 'session.v4.jsonl.zstd')),
      '迁移因检测到自身进程而失败：' + JSON.stringify(calls),
    )
  } finally {
    child.kill('SIGKILL')
  }
})

process.stdout.write(`\n${passed} 通过，${failed} 失败\n`)
if (failed) {
  for (const f of failures) process.stdout.write(`\n✗ ${f.name}\n${f.error && f.error.stack}\n`)
  process.exitCode = 1
}
