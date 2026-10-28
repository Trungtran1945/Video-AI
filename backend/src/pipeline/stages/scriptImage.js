import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, run } from '../../db/query.js'
import { listProvidersForCapability } from '../../providers/registry.js'
import { withProviderFailover } from '../../lib/providerFailover.js'
import { isBmpFile } from '../../lib/bmp.js'
import { sha256Hex } from '../../services/scriptService.js'
import { isPathInside } from '../../lib/safePath.js'
import {
  projectDir,
  ensureDir,
  resolveStorageKey,
  toStorageKey,
  parseJsonSafe,
} from '../context.js'

function slideDims(aspectRatio) {
  return String(aspectRatio) === '9:16'
    ? { width: 540, height: 960 }
    : { width: 960, height: 540 }
}

function imageDir(projectId, seg) {
  return ensureDir(path.join(projectDir(projectId), 'segments', `${seg.index_num}_${seg.id}`))
}

async function removeOldAsset(projectId, asset) {
  if (!asset) return
  const meta = parseJsonSafe(asset.meta, {}) || {}
  for (const key of [asset.storage_key, meta.previewKey]) {
    const abs = resolveStorageKey(key)
    if (abs && isPathInside(projectDir(projectId), abs)) {
      try { fs.unlinkSync(abs) } catch (_) {}
    }
  }
  await run('DELETE FROM assets WHERE id = ? AND project_id = ?', [asset.id, projectId])
}

// script.image — deterministic local slide images (never AI image generation).
// Prompt hash covers narration + visual prompt + aspect; a retry reuses the
// exact bitmap when nothing changed and regenerates when the prompt changed.
export async function scriptImage(ctx) {
  const { project, setProgress, signal } = ctx
  const segments = await query(
    'SELECT * FROM script_segments WHERE project_id = ? ORDER BY index_num ASC',
    [project.id]
  )
  if (!segments.length) throw new Error('Chưa có đoạn kịch bản — hãy retry từ stage script.analyze')

  const params = parseJsonSafe(project.params, {}) || {}
  const settings = ctx.settings || {}
  const imageProvider = String(params.imageProvider || settings.active_image_provider || 'slide')
  const candidates = await listProvidersForCapability(project.user_id, 'image', { id: imageProvider })
  if (!candidates.length) {
    throw new Error(`SCRIPT_IMAGE_PROVIDER_UNSUPPORTED: không có image provider '${imageProvider}' (chỉ hỗ trợ slide/mock)`)
  }
  const { width, height } = slideDims(project.aspect_ratio)
  const aspectRatio = String(project.aspect_ratio || '16:9')

  const failed = []
  const total = segments.length
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new Error('Cancelled')
    const seg = segments[i]
    try {
      const visualPrompt = String(seg.visual_prompt || '')
      const promptHash = sha256Hex(`${visualPrompt}\n${seg.narration || ''}\n${aspectRatio}`)
      const seed = sha256Hex(`${seg.id}${promptHash}`)
      const dir = imageDir(project.id, seg)
      const fullPath = path.join(dir, `image_${promptHash.slice(0, 16)}.bmp`)
      const previewPath = path.join(dir, `preview_${promptHash.slice(0, 16)}.bmp`)

      const existing = seg.image_asset_id
        ? await queryOne('SELECT * FROM assets WHERE id = ? AND project_id = ?', [seg.image_asset_id, project.id])
        : null
      const existingMeta = existing ? (parseJsonSafe(existing.meta, {}) || {}) : {}
      if (existing && existingMeta.promptHash === promptHash) {
        const fullAbs = resolveStorageKey(existing.storage_key)
        const previewAbs = resolveStorageKey(existingMeta.previewKey)
        if (fullAbs && previewAbs && fs.existsSync(fullAbs) && fs.existsSync(previewAbs)) {
          setProgress(2 + Math.round(((i + 1) / total) * 90))
          continue
        }
      }

      await removeOldAsset(project.id, existing)
      const { result, provider } = await withProviderFailover(
        { capability: 'IMAGE', candidates, maxAttempts: Math.min(4, candidates.length) },
        async (cand) => {
          const generated = await cand.provider.generate({
            prompt: visualPrompt,
            text: seg.narration || '',
            width,
            height,
            outPath: fullPath,
            previewPath,
            seed,
          })
          return {
            provider: cand.id,
            width: Number(generated?.width) || width,
            height: Number(generated?.height) || height,
            mime: generated?.mime || 'image/bmp',
          }
        }
      )
      if (!isBmpFile(fullPath) || !isBmpFile(previewPath)) {
        throw new Error('SCRIPT_IMAGE_INVALID: provider không tạo BMP hợp lệ')
      }

      const assetId = uuidv4()
      await run(
        `INSERT INTO assets (id, project_id, kind, storage_key, meta, duration_sec) VALUES (?, ?, 'image', ?, ?, NULL)`,
        [
          assetId,
          project.id,
          toStorageKey(fullPath),
          JSON.stringify({
            width: result.width,
            height: result.height,
            mime: result.mime,
            previewKey: toStorageKey(previewPath),
            promptHash,
            provider: provider?.id || imageProvider,
            seed,
          }),
        ]
      )
      await run(
        `UPDATE script_segments
         SET image_asset_id = ?, status = 'image_ready', updated_at = ?
         WHERE id = ? AND project_id = ?`,
        [assetId, new Date().toISOString(), seg.id, project.id]
      )
    } catch (err) {
      if (err?.message === 'Cancelled') throw err
      failed.push(`#${seg.index_num}: ${String(err?.message || err).slice(0, 160)}`)
    }
    setProgress(2 + Math.round(((i + 1) / total) * 90))
  }

  if (failed.length) {
    throw new Error(`SCRIPT_IMAGE_PARTIAL: ${failed.length}/${total} đoạn lỗi: ${failed.slice(0, 5).join('; ')}`)
  }
  setProgress(98)
  return { imageCount: total, imageProvider, width, height }
}

export default scriptImage
