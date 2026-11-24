import { z } from 'zod'

// --- Custom Reusable Types ---
export const idSchema = z
  .string({ required_error: 'ID is required' })
  .trim()
  .min(1, 'ID cannot be empty')
  .max(128, 'ID cannot exceed 128 characters')
  .regex(/^[A-Za-z0-9_-]+$/, 'ID must contain only alphanumeric characters, dashes, or underscores')

export const emailSchema = z
  .string({ required_error: 'Email is required' })
  .trim()
  .min(3, 'Email is required')
  .max(255, 'Email cannot exceed 255 characters')
  .email('Invalid email address')
  .toLowerCase()

export const passwordSchema = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password cannot exceed 72 bytes') // BCrypt max input length

// --- Auth Schemas ---
export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().trim().max(255).optional().default(''),
    otp: z.string().trim().regex(/^\d{6}$/, 'OTP must be 6 digits').optional(),
  })
  .passthrough()

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required').max(1000),
  })
  .passthrough()

export const forgotPasswordSchema = z
  .object({
    email: emailSchema,
  })
  .passthrough()

export const resetPasswordSchema = z
  .object({
    token: z.string({ required_error: 'Reset token is required' }).trim().min(1, 'Reset token is required').max(256),
    password: passwordSchema.optional(),
    newPassword: z.string().min(1).max(72).optional(),
  })
  .passthrough()
  .refine((data) => Boolean(data.password || data.newPassword), {
    message: 'Password or newPassword is required',
    path: ['newPassword'],
  })

export const verifyOtpSchema = z
  .object({
    email: emailSchema,
    otp: z.string({ required_error: 'OTP is required' }).trim().regex(/^\d{6}$/, 'OTP must be 6 digits'),
    password: passwordSchema.optional(),
    name: z.string().trim().max(255).optional(),
  })
  .passthrough()

// --- Project Schemas ---
// Canonical modes: SUMMARY, TRANSLATE_DUB, SCRIPT_TO_VIDEO, MEDIA_COMPOSER.
// AI_VIDEO is preserved as an intentional API alias normalized to SCRIPT_TO_VIDEO in projects.js.
export const PROJECT_MODES = [
  'SUMMARY',
  'TRANSLATE_DUB',
  'SCRIPT_TO_VIDEO',
  'MEDIA_COMPOSER',
  'AI_VIDEO',
]

export const createProjectSchema = z
  .object({
    title: z
      .string({ required_error: 'Title is required' })
      .trim()
      .min(1, 'Title cannot be empty')
      .max(255, 'Title cannot exceed 255 characters'),
    mode: z.enum(PROJECT_MODES, {
      errorMap: () => ({
        message: "Mode must be 'SUMMARY', 'TRANSLATE_DUB', 'SCRIPT_TO_VIDEO', 'MEDIA_COMPOSER', or 'AI_VIDEO'",
      }),
    }),
    target_language: z.string().trim().max(32).optional(),
    source_language: z.string().trim().max(32).optional(),
    description: z.string().trim().max(1000).optional(),
  })
  .passthrough()

export const updateProjectSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(1000).optional(),
    mode: z.enum(PROJECT_MODES).optional(),
    target_language: z.string().trim().max(32).optional(),
    status: z.enum(['pending', 'queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
  })
  .passthrough()

// --- Settings Schemas ---
export const settingsSchema = z
  .object({
    aspect_ratio: z.enum(['16:9', '9:16', '1:1', '4:5', '21:9', '4:3']).optional().nullable(),
    default_language: z.string().trim().max(1024).optional().nullable(),
    default_mode: z.enum(PROJECT_MODES).optional().nullable(),
    default_style: z.string().trim().max(1024).optional().nullable(),
    default_duration: z.number().int().min(1).optional().nullable(),
    max_retries: z.number().int().min(0).max(10).optional().nullable(),
    volume: z.number().min(0).max(100).optional().nullable(),
    speed: z.number().min(0.25).max(4.0).optional().nullable(),
    theme: z.enum(['dark', 'light', 'system']).optional().nullable(),
    auto_upload_youtube: z.boolean().optional(),
    notify_on_complete: z.boolean().optional(),
    active_llm_provider: z.string().max(1024).optional().nullable(),
    active_image_provider: z.string().max(1024).optional().nullable(),
    active_video_provider: z.string().max(1024).optional().nullable(),
    active_voice_provider: z.string().max(1024).optional().nullable(),
    active_subtitle_provider: z.string().max(1024).optional().nullable(),
    voice_provider: z.string().max(1024).optional().nullable(),
  })
  .passthrough()

export const updateSettingsSchema = settingsSchema

// --- API Keys Schemas ---
export const KNOWN_PROVIDERS = [
  'gemini',
  'openai',
  'anthropic',
  'huggingface',
  'whisper',
  'openai_whisper',
  'faster_whisper',
  'elevenlabs',
  'openai_tts',
  'voicestudio',
  'zerotts',
  'edge_tts',
  'google_tts',
  'azure_speech',
  'clip',
  'google_translate',
  'mock',
]

export const apiKeySchema = z
  .object({
    provider: z.enum(KNOWN_PROVIDERS, {
      errorMap: () => ({ message: 'Invalid or unsupported provider' }),
    }),
    key: z
      .string({ required_error: 'API key is required' })
      .trim()
      .min(1, 'API key is required')
      .max(4096, 'API key is too long'),
    label: z.string().trim().max(128).optional().default(''),
    tier: z.string().trim().max(64).optional(),
    priority: z.number().int().min(0).max(1000).optional().default(0),
  })
  .passthrough()

export const createApiKeySchema = apiKeySchema

// --- Route Parameter Schemas ---
export const idParamSchema = z.object({
  id: idSchema,
})

export const projectIdParamSchema = z.object({
  projectId: idSchema,
})

export const projectAndAssetIdParamSchema = z.object({
  projectId: idSchema,
  assetId: idSchema,
})

export default {
  idSchema,
  emailSchema,
  passwordSchema,
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyOtpSchema,
  PROJECT_MODES,
  createProjectSchema,
  updateProjectSchema,
  settingsSchema,
  updateSettingsSchema,
  KNOWN_PROVIDERS,
  apiKeySchema,
  createApiKeySchema,
  idParamSchema,
  projectIdParamSchema,
  projectAndAssetIdParamSchema,
}
