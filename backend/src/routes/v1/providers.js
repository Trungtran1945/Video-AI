import { Router } from 'express'
import { authMiddleware, requireRole } from '../../middleware/auth.js'

const router = Router()
router.use(authMiddleware)

// GET /api/v1/providers
router.get('/', (req, res) => {
  const available = req.user.role === 'admin' || true // all users see available providers
  res.json({
    llm: [
      { id: 'gemini', name: 'Google Gemini', available },
      { id: 'openai', name: 'OpenAI', available },
      { id: 'anthropic', name: 'Anthropic', available },
      { id: 'huggingface', name: 'HuggingFace', available },
    ],
    asr: [
      { id: 'whisper', name: 'Whisper', available },
      { id: 'faster_whisper', name: 'Faster Whisper', available },
      { id: 'openai_whisper', name: 'OpenAI Whisper', available },
    ],
    tts: [
      { id: 'elevenlabs', name: 'ElevenLabs', available },
      { id: 'google_tts', name: 'Google TTS', available },
      { id: 'azure_speech', name: 'Azure Speech', available },
      { id: 'openai_tts', name: 'OpenAI TTS', available },
    ],
    vision: [
      { id: 'gemini', name: 'Google Gemini Vision', available },
      { id: 'clip', name: 'CLIP', available },
    ],
    video: [
      { id: 'kling', name: 'Kling', available: false },
      { id: 'hailuo', name: 'Hailuo', available: false },
      { id: 'pixverse', name: 'PixVerse', available: false },
      { id: 'runway', name: 'Runway', available: false },
      { id: 'luma', name: 'Luma', available: false },
    ],
  })
})

export default router
