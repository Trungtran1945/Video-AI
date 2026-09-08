import { Worker } from 'bullmq'
import nodemailer from 'nodemailer'
import { connection } from '../connection.js'
import { config } from '../../config.js'

/**
 * NotifyWorker — Gửi email notification khi Project.status chuyển SUCCESS/FAILED.
 * Job không chặn pipeline chính, retry riêng tối đa 2 lần.
 */
let transporter = null

function getTransporter() {
  if (transporter) return transporter
  if (!config.smtp.host) {
    console.warn('[Notify] SMTP not configured, skipping email')
    return null
  }
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.password,
    },
  })
  return transporter
}

const worker = new Worker('notifications', async (job) => {
  const { projectId, projectTitle, userEmail, status, mode } = job.data

  const transport = getTransporter()
  if (!transport) {
    console.log(`[Notify] Skipping email for project ${projectId} (SMTP not configured)`)
    return { sent: false }
  }

  const statusText = status === 'success' ? 'thành công' : 'thất bại'
  const subject = `[AI Shorts Factory] Project "${projectTitle}" ${statusText}`
  const html = `
    <h2>Project ${statusText}</h2>
    <p>Project <strong>${projectTitle}</strong> (${mode}) đã ${statusText}.</p>
    <p>Bạn có thể xem kết quả tại: <a href="${config.frontendUrl || 'http://localhost:5173'}/projects/${projectId}">Xem project</a></p>
    <br>
    <p>Trân trọng,<br>AI Shorts Factory</p>
  `

  await transport.sendMail({
    from: config.notifyFromEmail || 'noreply@asf.local',
    to: userEmail,
    subject,
    html,
  })

  return { sent: true }
}, {
  connection,
  concurrency: 2,
})

worker.on('failed', (job, err) => {
  console.error('[Notify] Job failed:', err.message)
})

worker.on('completed', (job, result) => {
  console.log(`[Notify] Email sent for project ${job.data.projectId}: ${result.sent}`)
})

export default worker
