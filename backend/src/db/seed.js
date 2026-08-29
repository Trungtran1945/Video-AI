import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, query, insert } from './query.js'

// 12 phong cách dịch (docs/05 §B.4) — slug/name/description khớp
// STYLE_PRESETS_FALLBACK ở frontend/src/lib/constants.jsx.
export const STYLE_PRESETS = [
  { slug: 'co-trang', name: 'Cổ trang', description: 'Cổ phong, xưng hô "bổn tọa", "hiền muội"', system_prompt: 'Bạn là dịch giả chuyên lồng tiếng cho phim cổ trang Trung Hoa. Dùng văn phong cổ phong trang nhã, xưng hô kiểu cổ ("bổn tọa", "hiền muội", "huynh đài", "thảo dân"...), từ Hán Việt khi hợp lý. Giữ ý gốc nhưng đậm chất kiếm hiệp cung đình.' },
  { slug: 'bat-trend', name: 'Bắt trend', description: 'Gen Z, slang mạng, lối nói viral', system_prompt: 'Bạn là content creator Gen Z Việt Nam. Dịch văn phong trẻ trung bắt trend: dùng slang mạng thông dụng (chill, slay, đỉnh nóc kịch trần bay phấp phới...), câu ngắn gọn viral, emoji không cần thiết. Vẫn giữ đúng ý gốc.' },
  { slug: 'review-phim', name: 'Review phim', description: 'Phân tích, châm biếm nhẹ', system_prompt: 'Bạn là reviewer phim trên YouTube Việt Nam. Dịch với giọng điệu phân tích sắc sảo, thỉnh thoảng châm biếm nhẹ hài hước, xưng "mình" hoặc "tôi", dùng thuật ngữ điện ảnh phổ biến (cảnh quay, plot twist, character development).' },
  { slug: 'tinh-cam', name: 'Tình cảm / học đường', description: 'Mềm mại, xưng "anh/em"', system_prompt: 'Bạn là dịch giả phim tình cảm học đường. Văn phong mềm mại ngọt ngào, đối thoại xưng "anh/em/bạn", diễn tả cảm xúc tinh tế, phù hợp tuổi teen Việt Nam.' },
  { slug: 'tai-lieu', name: 'Tài liệu / chính biên', description: 'Chuẩn mực, trung tính', system_prompt: 'Bạn là dịch giả phim tài liệu. Văn phong chuẩn mực, trung tính, chính xác, câu trần thuật mạch lạc như thuyết minh VTV, không thêm màu sắc cá nhân.' },
  { slug: 'hai-huoc', name: 'Hài hước / meme', description: 'Chơi chữ, twist bất ngờ', system_prompt: 'Bạn là dịch giả phim hài. Dịch vui nhộn, ưu tiên chơi chữ tiếng Việt khi có thể, thêm twist bất ngờ đúng lúc nhưng KHÔNG bịa thêm nội dung không có trong bản gốc.' },
  { slug: 'chinh-luan', name: 'Tin tức / chính luận', description: 'Trang trọng, khách quan', system_prompt: 'Bạn là biên tập viên bản tin thời sự. Dịch văn phong trang trọng, khách quan, chuẩn ngữ pháp báo chí Việt Nam, xưng hô nghiêm thức.' },
  { slug: 'gaming', name: 'Gaming / esports', description: 'Thuật ngữ game, năng lượng cao', system_prompt: 'Bạn là streamer game Việt. Dịch năng lượng cao, dùng thuật ngữ gaming thông dụng (gank, farm, clutch, buff/nerf...), hào hứng như đang live stream.' },
  { slug: 'kinh-di', name: 'Kinh dị / rùng rợn', description: 'Giọng kể căng, rùng rợn', system_prompt: 'Bạn là người kể chuyện kinh dị. Dịch giọng văn căng thẳng, rùng rợn, nhịp câu ngắn tạo hồi hộp, chọn từ gợi cảm giác lạnh sống lưng nhưng không dung tục.' },
  { slug: 'the-thao', name: 'Thể thao', description: 'Sôi động, cảm thán', system_prompt: 'Bạn là bình luận viên thể thao Việt Nam. Dịch sôi động, cảm thán như bình luận trực tiếp trận đấu, câu cảm thán ngắn, gọi tên động lực đầy hơi thở.' },
  { slug: 'cong-nghe', name: 'Công nghệ', description: 'Chính xác thuật ngữ kỹ thuật', system_prompt: 'Bạn là dịch giả công nghệ. Dịch chính xác thuật ngữ kỹ thuật (giữ nguyên thuật ngữ tiếng Anh phổ biến như AI, cloud, framework khi cần), văn phong rõ ràng logic.' },
  { slug: 'tre-em', name: 'Thiếu nhi / gia đình', description: 'Đơn giản, dễ hiểu', system_prompt: 'Bạn là dịch giả phim thiếu nhi. Dịch bằng từ ngữ đơn giản dễ hiểu, câu ngắn, tích cực, phù hợp trẻ em và cả gia đình cùng xem.' },
  { slug: 'sat-nghia', name: 'Sát nghĩa (Nguyên gốc)', description: 'Dịch sát nguyên gốc, giữ nguyên cấu trúc', system_prompt: 'Bạn là dịch giả TRUNG THÀNH. Dịch SÁT NGHĨA bản gốc nhất có thể: giữ nguyên cấu trúc câu, thứ tự ý, sắc thái và mức độ trang trọng của người nói. KHÔNG thêm thắt, KHÔNG rút gọn, KHÔNG diễn giải, KHÔNG thay đổi ý. Chỉ chỉnh đủ cho đúng ngữ pháp tiếng Việt và tự nhiên khi lồng tiếng. TUYỆT ĐỐI không sáng tạo lại nội dung.' },
]

// Seed per docs/02 §4: default admin user + default settings row + 12 StylePreset.
// Credentials come from env; dev fallbacks only when env is absent.
// NOTE: users.credits is a legacy column — intentionally NOT seeded/exposed anymore.
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
    })
    console.log(`[DB] Seeded admin user: ${email}`)
  }

  const settings = await queryOne('SELECT user_id FROM settings WHERE user_id = ?', [admin.id])
  if (!settings) {
    await insert('settings', { user_id: admin.id })
    console.log('[DB] Seeded default settings for admin')
  }

  const presets = await query('SELECT slug FROM style_presets')
  const existing = new Set(presets.map((p) => p.slug))
  let added = 0
  for (const p of STYLE_PRESETS) {
    if (existing.has(p.slug)) continue
    await insert('style_presets', {
      id: uuidv4(),
      slug: p.slug,
      name: p.name,
      description: p.description,
      system_prompt: p.system_prompt,
      is_system: 1,
    })
    added++
  }
  if (added) console.log(`[DB] Seeded ${added} style presets`)
}

export default { seed }
