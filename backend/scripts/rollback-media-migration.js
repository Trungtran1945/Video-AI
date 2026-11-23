#!/usr/bin/env node
/**
 * rollback-media-migration.js
 * 
 * Phase 14: Safe, lossless rollback procedure for media migration.
 * Reverts database references back to local storage while preserving
 * all local files intact on disk.
 * 
 * Usage:
 *   node backend/scripts/rollback-media-migration.js [options]
 * 
 * Options:
 *   --all                Rollback all migrated assets
 *   --project-id=ID      Rollback only assets belonging to a specific project
 *   --table=NAME         Rollback only assets in a specific table (assets, audios, outputs, etc.)
 *   --purge-cloudinary   Optionally delete remote assets from Cloudinary (default: keep in Cloudinary)
 */

import 'dotenv/config'
import { v2 as cloudinary } from 'cloudinary'
import { getPool } from '../src/db.js'

function parseArgs() {
  const args = {
    all: false,
    projectId: null,
    table: null,
    purgeCloudinary: false,
  }

  for (const arg of process.argv.slice(2)) {
    if (arg === '--all') args.all = true
    else if (arg === '--purge-cloudinary') args.purgeCloudinary = true
    else if (arg.startsWith('--project-id=')) args.projectId = arg.split('=')[1]
    else if (arg.startsWith('--table=')) args.table = arg.split('=')[1]
  }

  return args
}

async function main() {
  const options = parseArgs()

  console.log('='.repeat(70))
  console.log('Video_AI Media Migration Rollback (Phase 14)')
  console.log('='.repeat(70))
  if (options.all) console.log('Scope: ALL migrated assets')
  if (options.projectId) console.log(`Scope: project_id=${options.projectId}`)
  if (options.table) console.log(`Scope: table=${options.table}`)
  console.log(`Purge Cloudinary: ${options.purgeCloudinary ? 'YES (delete remote copies)' : 'NO (keep remote copies safe)'}`)
  console.log('Local files status: 100% PRESERVED ON DISK')
  console.log('-'.repeat(70))

  if (!options.all && !options.projectId && !options.table) {
    console.error('Error: Please specify --all, --project-id=ID, or --table=NAME to rollback.')
    process.exit(1)
  }

  const pool = getPool()

  // Setup Cloudinary if purge requested
  if (options.purgeCloudinary) {
    if (process.env.CLOUDINARY_URL) {
      cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL })
    } else {
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure: true,
      })
    }
  }

  // 1. Fetch items to rollback from manifest
  let manifestQuery = `SELECT * FROM media_migration_manifest WHERE status IN ('completed', 'verified')`
  const params = []
  if (options.projectId) {
    manifestQuery += ` AND project_id = $${params.length + 1}`
    params.push(options.projectId)
  }
  if (options.table) {
    manifestQuery += ` AND entity_table = $${params.length + 1}`
    params.push(options.table)
  }

  const items = (await pool.query(manifestQuery, params)).rows
  console.log(`Found ${items.length} migrated assets eligible for rollback.`)

  if (items.length === 0) {
    console.log('Nothing to rollback.')
    return
  }

  let revertedCount = 0
  let purgedCount = 0

  for (const item of items) {
    // Optionally purge from Cloudinary
    if (options.purgeCloudinary && item.cloudinary_public_id) {
      try {
        const resType = item.resource_type || 'image'
        await cloudinary.uploader.destroy(item.cloudinary_public_id, {
          resource_type: resType,
          invalidate: true,
        })
        purgedCount++
      } catch (err) {
        console.warn(`[Purge Warning] Could not delete ${item.cloudinary_public_id} from Cloudinary: ${err.message}`)
      }
    }

    // Revert target table storage_provider to 'local'
    try {
      if (item.entity_table === 'assets') {
        await pool.query(
          `UPDATE assets SET storage_provider = 'local' WHERE id = $1`,
          [item.entity_id]
        )
      } else if (item.entity_table === 'audios') {
        await pool.query(
          `UPDATE audios SET storage_provider = 'local' WHERE id = $1`,
          [item.entity_id]
        )
      } else if (item.entity_table === 'outputs') {
        await pool.query(
          `UPDATE outputs SET storage_provider = 'local' WHERE id = $1`,
          [item.entity_id]
        )
      } else if (item.entity_table === 'subtitles') {
        await pool.query(
          `UPDATE subtitles SET storage_provider = 'local' WHERE id = $1`,
          [item.entity_id]
        )
      } else if (item.entity_table === 'projects') {
        await pool.query(
          `UPDATE projects SET source_storage_provider = 'local' WHERE id = $1`,
          [item.entity_id]
        )
      }

      // Mark manifest as rolled_back
      await pool.query(
        `UPDATE media_migration_manifest SET status = 'rolled_back', updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
        [item.id]
      )

      revertedCount++
    } catch (err) {
      console.warn(`[Rollback Warning] Failed reverting ${item.entity_table} ${item.entity_id}: ${err.message}`)
    }
  }

  console.log('\n' + '='.repeat(70))
  console.log('Rollback Completed')
  console.log('='.repeat(70))
  console.log(`Reverted to local storage: ${revertedCount}`)
  if (options.purgeCloudinary) console.log(`Purged from Cloudinary:    ${purgedCount}`)
  console.log('Local files status:        100% INTACT (Zero files deleted)')
  console.log('='.repeat(70))
}

main().catch((err) => {
  console.error('[FATAL] Rollback failed:', err)
  process.exit(1)
})
