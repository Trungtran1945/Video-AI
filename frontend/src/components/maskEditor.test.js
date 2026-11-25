import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const here = path.dirname(fileURLToPath(import.meta.url))
const srcPath = path.join(here, 'MaskEditor.jsx')

// Bundle MaskEditor.jsx to CommonJS in-memory using esbuild (available from Vite)
const bundle = esbuild.buildSync({
  entryPoints: [srcPath],
  bundle: true,
  write: false,
  format: 'cjs',
  external: ['react', 'lucide-react', '@/api/projects'],
})

const m = { exports: {} }
const customRequire = (id) => {
  if (id === 'react') return require('react')
  if (id === 'lucide-react') return {}
  if (id === '@/api/projects') return { projectsApi: {} }
  return require(id)
}
const fn = new Function('module', 'exports', 'require', bundle.outputFiles[0].text)
fn(m, m.exports, customRequire)

const {
  default: MaskEditor,
  computeBoxStyle,
  getMaskApproveState,
  approveMask,
  isAuto,
} = m.exports

test('isAuto correctly detects auto, legacy_ocr, and manual masks', () => {
  assert.equal(isAuto({ id: 'auto:123' }), true)
  assert.equal(isAuto({ id: 'legacy_ocr:456' }), true)
  assert.equal(isAuto({ id: 'm-1', source: 'AUTO' }), true)
  assert.equal(isAuto({ id: 'm-2', source: 'LEGACY_AUTO' }), true)
  assert.equal(isAuto({ id: 'm-3', source: 'LEGACY_OCR' }), true)
  assert.equal(isAuto({ id: 'm-4', isLegacy: true }), true)
  assert.equal(isAuto({ id: 'm-5', source: 'MANUAL' }), false)
  assert.equal(isAuto(null), false)
})

test('computeBoxStyle renders mask box style (not display:none) when contentBox is null', () => {
  const mask = {
    id: 'mask-1',
    ratioX: 0.25,
    ratioY: 0.5,
    ratioW: 0.5,
    ratioH: 0.25,
    type: 'blur',
    blurRadius: 8,
    opacity: 1,
    startSec: 0,
    endSec: 5,
  }

  // When contentBox is null, computeBoxStyle uses fallback 640x360 dimensions
  const style = computeBoxStyle(mask, null, { currentTime: 2 })

  assert.notEqual(style.display, 'none', 'Mask box must not return display:none when contentBox is null')
  assert.equal(style.position, 'absolute')
  assert.equal(style.left, 160) // 0.25 * 640
  assert.equal(style.top, 180)  // 0.5 * 360
  assert.equal(style.width, 320) // 0.5 * 640
  assert.equal(style.height, 90) // 0.25 * 360
  assert.equal(style.opacity, 1) // active at currentTime=2
})

test('computeBoxStyle computes fallback using video dimensions or params when contentBox is null', () => {
  const mask = {
    id: 'mask-portrait',
    ratioX: 0.1,
    ratioY: 0.2,
    ratioW: 0.8,
    ratioH: 0.3,
    type: 'solid',
    opacity: 0.8,
    startSec: 1,
    endSec: 4,
  }

  // Fallback with custom container and 9:16 portrait video params
  const style = computeBoxStyle(mask, null, {
    container: { clientWidth: 1000, clientHeight: 1000 },
    params: { videoWidth: 1080, videoHeight: 1920 },
    currentTime: 2,
    selectedId: 'mask-portrait',
  })

  assert.notEqual(style.display, 'none')
  assert.equal(style.position, 'absolute')
  // cw=1000, ch=1000; vw=1080, vh=1920; scale = 1000 / 1920; w = 1080 * (1000/1920) = 562.5; h = 1000;
  // x = (1000 - 562.5) / 2 = 218.75; y = 0
  assert.equal(Math.round(style.left), Math.round(218.75 + 0.1 * 562.5))
  assert.equal(Math.round(style.top), Math.round(0 + 0.2 * 1000))
  assert.equal(Math.round(style.width), Math.round(0.8 * 562.5))
  assert.equal(Math.round(style.height), Math.round(0.3 * 1000))
  assert.equal(style.background, 'rgba(0,0,0,0.8)')
  assert.ok(style.boxShadow.includes('rgba(96,165,250,0.6)'))
})

test('computeBoxStyle uses contentBox when provided', () => {
  const mask = {
    id: 'mask-cb',
    ratioX: 0.1,
    ratioY: 0.1,
    ratioW: 0.5,
    ratioH: 0.5,
    type: 'blur',
    startSec: 0,
    endSec: 10,
  }

  const contentBox = { x: 50, y: 25, w: 800, h: 450 }
  const style = computeBoxStyle(mask, contentBox, { currentTime: 1 })

  assert.equal(style.left, 50 + 0.1 * 800)
  assert.equal(style.top, 25 + 0.1 * 450)
  assert.equal(style.width, 0.5 * 800)
  assert.equal(style.height, 0.5 * 450)
})

test('getMaskApproveState disables Approve for AUTO masks that are already APPROVED (read-only)', () => {
  const autoApproved = {
    id: 'auto:seg-1',
    source: 'AUTO',
    status: 'APPROVED',
  }
  const state = getMaskApproveState(autoApproved)
  assert.equal(state.canApprove, false, 'Approve must be disabled for AUTO APPROVED masks')
  assert.equal(state.isSelectedAuto, true)
  assert.equal(state.isSelectedApproved, true)
  assert.ok(state.approveHint.includes('APPROVED và chỉ đọc'), `Expected hint to explain APPROVED and read-only: ${state.approveHint}`)
  assert.ok(state.approveHint.includes('Nhân bản tay'), `Expected hint to suggest duplicate: ${state.approveHint}`)
})

test('getMaskApproveState disables Approve for AUTO masks that are not APPROVED', () => {
  const autoDraft = {
    id: 'auto:seg-2',
    source: 'AUTO',
    status: 'DRAFT',
  }
  const state = getMaskApproveState(autoDraft)
  assert.equal(state.canApprove, false, 'Approve must be disabled for AUTO masks')
  assert.equal(state.isSelectedAuto, true)
  assert.ok(state.approveHint.includes('chỉ đọc'), `Expected hint to explain read-only: ${state.approveHint}`)
  assert.ok(state.approveHint.includes('Nhân bản tay'), `Expected hint to suggest duplicate: ${state.approveHint}`)
})

test('getMaskApproveState enables Approve for manual DRAFT masks and disables when already APPROVED', () => {
  const manualDraft = {
    id: 'manual-1',
    source: 'MANUAL',
    status: 'DRAFT',
  }
  const draftState = getMaskApproveState(manualDraft)
  assert.equal(draftState.canApprove, true)
  assert.ok(draftState.approveHint.includes('đã render vào video sau Chạy lại'))

  const manualApproved = {
    id: 'manual-1',
    source: 'MANUAL',
    status: 'APPROVED',
  }
  const approvedState = getMaskApproveState(manualApproved)
  assert.equal(approvedState.canApprove, false)
  assert.ok(approvedState.approveHint.includes('bản xem trước trên video gốc'))
})

test('approveMask invokes updateMaskFn, mask reload API/loader, and onMaskChange callback', async () => {
  let updateCalls = 0
  let reloadMasksCalls = 0
  let loaderCalls = 0
  let onReloadCalls = 0
  let onMaskChangeCalls = 0

  const fakeUpdateMask = async (projectId, maskId, patch) => {
    updateCalls++
    assert.equal(projectId, 'proj-abc')
    assert.equal(maskId, 'mask-xyz')
    assert.deepEqual(patch, { status: 'APPROVED' })
    return { id: maskId, status: 'APPROVED' }
  }

  const fakeReloadMasks = async () => {
    reloadMasksCalls++
    return [{ id: 'mask-xyz', status: 'APPROVED' }]
  }

  const fakeLoader = async () => {
    loaderCalls++
  }

  const fakeOnReload = () => {
    onReloadCalls++
  }

  const fakeOnMaskChange = () => {
    onMaskChangeCalls++
  }

  const result = await approveMask({
    projectId: 'proj-abc',
    maskId: 'mask-xyz',
    updateMaskFn: fakeUpdateMask,
    reloadMasksFn: fakeReloadMasks,
    loader: fakeLoader,
    onReload: fakeOnReload,
    onMaskChange: fakeOnMaskChange,
  })

  assert.equal(updateCalls, 1)
  assert.equal(reloadMasksCalls, 1, 'reloadMasksFn (API reload) must be invoked after approve')
  assert.equal(loaderCalls, 1, 'loader callback from props must be invoked')
  assert.equal(onReloadCalls, 1, 'onReload callback from props must be invoked')
  assert.equal(onMaskChangeCalls, 1, 'onMaskChange callback from props must be invoked')
  assert.deepEqual(result, { id: 'mask-xyz', status: 'APPROVED' })
})

test('approveMask does not invoke reload callbacks if API update fails', async () => {
  let reloadMasksCalls = 0
  let loaderCalls = 0
  let onMaskChangeCalls = 0

  const failingUpdate = async () => {
    throw new Error('400 Bad Request: mask is read-only')
  }

  await assert.rejects(
    () => approveMask({
      projectId: 'proj-1',
      maskId: 'mask-1',
      updateMaskFn: failingUpdate,
      reloadMasksFn: async () => { reloadMasksCalls++ },
      loader: async () => { loaderCalls++ },
      onMaskChange: () => { onMaskChangeCalls++ },
    }),
    /400 Bad Request/
  )

  assert.equal(reloadMasksCalls, 0)
  assert.equal(loaderCalls, 0)
  assert.equal(onMaskChangeCalls, 0)
})

test('source code clearly distinguishes UI copy between preview on original video and rendered output', () => {
  const code = fs.readFileSync(srcPath, 'utf8')
  assert.ok(code.includes('bản xem trước trên video gốc'), 'Must contain copy: bản xem trước trên video gốc')
  assert.ok(code.includes('đã render vào video sau Chạy lại'), 'Must contain copy: đã render vào video sau Chạy lại')
})
