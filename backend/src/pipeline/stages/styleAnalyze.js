import { detectScenes, colorStats, probe } from '../../media/mediaService.js'
import { requireSourceFile, clamp, round2 } from '../context.js'

export async function styleAnalyze(ctx) {
  const { project, setProgress } = ctx
  const src = requireSourceFile(project.template_video_key, 'Video mẫu (template)')
  setProgress(10)

  const info = await probe(src)
  if (!info.durationSec) throw new Error('Không đọc được thời lượng video mẫu')

  const cuts = await detectScenes(src, { threshold: 0.35, minSceneSec: 0.8 })
  const shotLens = cuts.map((c) => c.endSec - c.startSec).filter((d) => d > 0)
  const avgShotLen = shotLens.length
    ? round2(shotLens.reduce((a, b) => a + b, 0) / shotLens.length)
    : round2(info.durationSec)
  setProgress(55)

  const stats = await colorStats(src, Math.max(2, Math.round(info.durationSec / 12)))
  const saturation = stats.saturationAvg != null ? round2(clamp(stats.saturationAvg / 100 + 0.9, 0.85, 1.35)) : 1.1
  const contrast = stats.brightAvg != null ? (stats.brightAvg < 110 ? 1.15 : 1.03) : 1.05
  const bpm = clamp(Math.round(60 / Math.max(0.5, avgShotLen)), 70, 180)

  const styleProfile = {
    aspectRatio: project.aspect_ratio || '9:16',
    transitions: {
      default: avgShotLen < 2 ? 'slide' : 'cross',
      durationSec: 0.35,
      pattern: 'ABAB',
    },
    pacing: { avgShotLen: clamp(avgShotLen, 0.6, 6), beatSync: false, bpm },
    color: { lut: null, contrast, saturation },
    motion: { kenBurns: true, zoomRange: [1.0, 1.12], pan: 'slow' },
    text: { font: null, position: 'bottom', animation: 'fade-up', size: 48 },
    audio: { musicBed: true, ducking: -12 },
  }
  setProgress(95)

  return { styleProfile, shotsDetected: cuts.length, templateDurationSec: round2(info.durationSec) }
}

export default styleAnalyze
