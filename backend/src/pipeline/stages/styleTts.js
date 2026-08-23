import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { getProvider } from '../../providers/registry.js'
import { tracked } from '../../providers/tracked.js'
import { projectDir, ensureDir, parseJsonSafe, toStorageKey, round2, insertMany } from '../context.js'

export async function styleTts(ctx) {
  const { project, job, setProgress } = ctx
  const params = parseJsonSafe(project.params, {}) || {}
  const narration = String(params.narration || '').trim()
  if (!narration) {
    return { skipped: true }
  }

  const tts = await getProvider(project.user_id, 'tts')
  const audioDir = ensureDir(path.join(projectDir(project.id), 'audio'))
  setProgress(20)

  const synth = await tracked(
    { projectId: project.id, jobId: job.id, provider: tts.id, type: 'tts' },
    () => tts.provider.synthesize({ text: narration, outPath: path.join(audioDir, 'narration.mp3') })
  )

  const audioRow = {
    id: uuidv4(),
    project_id: project.id,
    kind: 'voice',
    storage_key: toStorageKey(synth.audioPath),
    duration_sec: round2(synth.durationSec),
    provider: tts.id,
  }
  await insertMany('audios', [audioRow])
  setProgress(95)

  return {
    audioId: audioRow.id,
    audioKey: audioRow.storage_key,
    durationSec: round2(synth.durationSec),
    chars: narration.length,
  }
}

export default styleTts
