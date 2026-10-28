import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { toAss } from '../src/pipeline/stages/scriptSubtitle.js'
import { STAGES, stagesForProject } from '../src/pipeline/runner.js'

console.log('=== SCRIPT_TO_VIDEO Pipeline Workflow Tests ===\n')

// 1. Stage list contract
{
  console.log('--- 1. STAGES.SCRIPT_TO_VIDEO contract ---')
  const expected = [
    'script.ingest',
    'script.analyze',
    'script.tts',
    'script.image',
    'script.align',
    'script.subtitle',
    'script.render',
  ]
  assert.deepEqual(STAGES.SCRIPT_TO_VIDEO, expected, 'SCRIPT_TO_VIDEO has exactly 7 stages in order')

  const stages = stagesForProject('SCRIPT_TO_VIDEO')
  assert.deepEqual(stages, expected, 'stagesForProject returns 7 stages for SCRIPT_TO_VIDEO')

  // Check alias handling if project object passed
  const aliasStages = stagesForProject({ mode: 'SCRIPT_TO_VIDEO' })
  assert.deepEqual(aliasStages, expected, 'stagesForProject accepts project object')
  console.log('PASS: STAGES.SCRIPT_TO_VIDEO configuration')
}

// 2. Subtitle toAss generation & escaping
{
  console.log('--- 2. toAss subtitle formatting ---')
  const cues = [
    { start: 0, end: 5.25, text: 'Dòng thứ nhất có dấu {ngoặc nhọn} và \\dấu gạch chéo\\' },
    { start: 5.25, end: 10.5, text: 'Dòng thứ hai\ncó xuống dòng' },
  ]
  const ass = toAss(cues, { width: 1920, height: 1080 })

  assert(ass.includes('[Script Info]'), 'Includes Script Info section')
  assert(ass.includes('[V4+ Styles]'), 'Includes V4+ Styles section')
  assert(ass.includes('[Events]'), 'Includes Events section')
  assert(ass.includes('PlayResX: 1920'), 'Sets PlayResX')
  assert(ass.includes('PlayResY: 1080'), 'Sets PlayResY')

  // Escaping verification
  assert(ass.includes('\\{ngoặc nhọn\\}'), 'Braces are escaped with backslash')
  assert(ass.includes('\\\\dấu gạch chéo\\\\'), 'Backslashes are escaped')
  assert(ass.includes('\\N'), 'Newlines are converted to ASS \\N')

  // Timestamp formatting
  assert(ass.includes('0:00:00.00'), 'Formats start timestamp')
  assert(ass.includes('0:00:05.25'), 'Formats end timestamp')
  console.log('PASS: toAss subtitle formatting and escaping')
}

// 3. Aspect ratio dimensions
{
  console.log('--- 3. Aspect ratio dimensions for subtitles ---')
  const cues = [{ start: 0, end: 3, text: 'Short' }]
  const ass169 = toAss(cues, { width: 1920, height: 1080 })
  assert(ass169.includes('PlayResX: 1920') && ass169.includes('PlayResY: 1080'))

  const ass916 = toAss(cues, { width: 1080, height: 1920 })
  assert(ass916.includes('PlayResX: 1080') && ass916.includes('PlayResY: 1920'))
  console.log('PASS: Aspect ratio support (16:9 and 9:16)')
}

console.log('\nALL SCRIPT_TO_VIDEO PIPELINE WORKFLOW TESTS PASS')
process.exit(0)
