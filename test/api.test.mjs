import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const api = require('../src/api.cjs')
const config = require('../src/config.cjs')

const BASE = path.join(process.cwd(), '.test-tmp')
fs.mkdirSync(BASE, { recursive: true })
let tmp
function freshHome() {
  tmp = fs.mkdtempSync(path.join(BASE, 'api-'))
  return tmp
}

function mockRes() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers || {}
    },
    end(text) {
      out.body = text || ''
    },
  }
}

function mockReq(method, url, body) {
  const req = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  req.method = method
  req.url = url
  return req
}

function invoke(handler, req) {
  const res = mockRes()
  return Promise.resolve(handler(req, res)).then(() => res.out)
}

const ctx = { connection: { requestRejection: () => undefined } }
let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`✗ ${name}\n  ${error && error.message}`)
  }
}

await test('sanitizeConfig 接受合法配置并拒绝非法类型', () => {
  const ok = config.sanitizeConfig({ maps: ['D:\\a=/mnt/data/a'], auto: false, dryRun: true })
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.value.auto, false)
  assert.equal(ok.value.maps.length, 1)
  const bad = config.sanitizeConfig({ maps: ['bad'], auto: 'yes' })
  assert.equal(bad.errors.length, 2)
})

await test('writeFileConfig 原子写入且保留未知键', () => {
  const home = freshHome()
  fs.writeFileSync(path.join(home, 'crossos.json'), JSON.stringify({ maps: ['D:\\x=/x'], keepMe: 42 }), 'utf8')
  config.writeFileConfig(home, { auto: false })
  const data = JSON.parse(fs.readFileSync(path.join(home, 'crossos.json'), 'utf8'))
  assert.equal(data.auto, false)
  assert.equal(data.keepMe, 42)
  assert.deepEqual(data.maps, ['D:\\x=/x'])
  const mode = fs.statSync(path.join(home, 'crossos.json')).mode & 0o777
  assert.equal(mode, 0o600)
})

await test('GET /dsh-crossos/api/config 返回文件内容与待迁移摘要', async () => {
  const home = freshHome()
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  const handler = api.createHandler(ctx, { home })
  const out = await invoke(handler, mockReq('GET', '/dsh-crossos/api/config'))
  assert.equal(out.status, 200)
  const body = JSON.parse(out.body)
  assert.equal(body.ok, true)
  assert.equal(body.home, home)
  assert.deepEqual(body.fileConfig.maps, [])
  assert.equal(body.pending.count, 0)
  assert.ok(body.file.endsWith('crossos.json'))
})

await test('PUT 写入配置后 GET 反映出来，且拒绝非法值', async () => {
  const home = freshHome()
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  const handler = api.createHandler(ctx, { home })

  const bad = await invoke(handler, mockReq('PUT', '/dsh-crossos/api/config', { config: { maps: ['oops'] } }))
  assert.equal(bad.status, 400)
  assert.equal(JSON.parse(bad.body).ok, false)

  const good = await invoke(handler, mockReq('PUT', '/dsh-crossos/api/config', {
    config: { maps: [{ from: 'D:\\项目', to: '/mnt/data/项目' }], auto: false },
  }))
  assert.equal(good.status, 200)
  const body = JSON.parse(good.body)
  assert.deepEqual(body.fileConfig.maps, [{ from: 'D:\\项目', to: '/mnt/data/项目' }])
  assert.equal(body.fileConfig.auto, false)

  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'crossos.json'), 'utf8'))
  assert.equal(onDisk.auto, false)

  const ag = await invoke(handler, mockReq('GET', '/dsh-crossos/api/config'))
  assert.equal(JSON.parse(ag.body).fileConfig.maps[0].from, 'D:\\项目')
})

await test('未知路径返回 404，非法方法返回 405', async () => {
  const home = freshHome()
  const handler = api.createHandler(ctx, { home })
  const notFound = await invoke(handler, mockReq('GET', '/dsh-crossos/api/nope'))
  assert.equal(notFound.status, 404)
  const wrong = await invoke(handler, mockReq('DELETE', '/dsh-crossos/api/config'))
  assert.equal(wrong.status, 405)
})

await test('connection.requestRejection 拒绝时直接短路', async () => {
  const home = freshHome()
  const handler = api.createHandler({ connection: { requestRejection: () => 403 } }, { home })
  const out = await invoke(handler, mockReq('GET', '/dsh-crossos/api/config'))
  assert.equal(out.status, 403)
  assert.equal(out.body, '')
})

try { fs.rmSync(BASE, { recursive: true, force: true }) } catch {}
console.log(`api.test: ${passed} 通过，${failures.length} 失败`)
for (const f of failures) console.error(f)
process.exit(failures.length ? 1 : 0)
