import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, insert } from './query.js'

// Seed per docs/02 §4: default admin user + default settings row.
// Credentials come from env; dev fallbacks only when env is absent.
export async function seed() {
  const email = process.env.ADMIN_EMAIL || 'admin@asf.local'
  const password = process.env.ADMIN_PASSWORD || 'admin1234'

  let admin = await queryOne('SELECT id FROM users WHERE email = ?', [email])
  if (!admin) {
    const hashed = await bcrypt.hash(password, 10)
    admin = await insert('users', {
      id: uuidv4(),
      email,
      password: hashed,
      role: 'admin',
      name: 'Admin',
      credits: 0,
    })
    console.log(`[DB] Seeded admin user: ${email}`)
  }

  const settings = await queryOne('SELECT user_id FROM settings WHERE user_id = ?', [admin.id])
  if (!settings) {
    await insert('settings', { user_id: admin.id })
    console.log('[DB] Seeded default settings for admin')
  }
}

export default { seed }
