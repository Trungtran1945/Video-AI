import { v4 as uuidv4 } from 'uuid'
import { detectScenes } from '../../media/mediaService.js'
import { requireSourceFile, insertMany, round2 } from '../context.js'

const MAX_SCENES = 600

export async function summarySceneDetect(ctx) {
  const { project, setProgress } = ctx
  const src = requireSourceFile(project.source_video_key, 'Video nguồn (phim)')

  let threshold = Number(process.env.SCENE_THRESHOLD) || 0.4
  let scenes = await detectScenes(src, { threshold, minSceneSec: 2 })
  while (scenes.length > MAX_SCENES && threshold < 0.65) {
    threshold += 0.05
    scenes = await detectScenes(src, { threshold, minSceneSec: 2 })
    setProgress(30)
  }
  if (scenes.length > MAX_SCENES) {
    const stride = Math.ceil(scenes.length / MAX_SCENES)
    const kept = []
    for (let i = 0; i < scenes.length; i += stride) {
      kept.push({ startSec: scenes[i].startSec })
    }
    for (let i = 0; i < kept.length; i++) {
      kept[i].endSec = i + 1 < kept.length ? kept[i + 1].startSec : scenes[scenes.length - 1].endSec
    }
    scenes = kept.filter((s) => s.endSec - s.startSec >= 1)
  }

  setProgress(55)
  const rows = scenes.map((sc) => ({
    id: uuidv4(),
    project_id: project.id,
    source_video_id: project.source_video_id || null,
    start_sec: round2(sc.startSec),
    end_sec: round2(sc.endSec),
    thumbnail_key: null,
    description: null,
    embedding: null,
  }))
  await insertMany('scenes', rows)
  setProgress(95)

  return { sceneCount: rows.length, threshold }
}

export default summarySceneDetect
