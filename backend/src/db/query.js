import { getDb, save } from '../db.js'

// sql.js returns [{ columns: [...], values: [[...]] }]
function rowsToObjects(result) {
  if (!result || result.length === 0) return []
  const { columns, values } = result[0]
  return values.map((row) => {
    const obj = {}
    columns.forEach((c, i) => {
      obj[c] = row[i]
    })
    return obj
  })
}

export async function query(sql, params = []) {
  const db = await getDb()
  return rowsToObjects(db.exec(sql, params))
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params)
  return rows[0] || null
}

export async function run(sql, params = []) {
  const db = await getDb()
  db.run(sql, params)
  save()
  return true
}

// Insert an object; keys map to columns. Returns the inserted row (with id).
export async function insert(table, obj) {
  const cols = Object.keys(obj)
  const placeholders = cols.map(() => '?').join(', ')
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`
  await run(sql, cols.map((c) => obj[c]))
  const idCol = obj.id ? 'id' : 'id'
  const id = obj.id || null
  if (id) return queryOne(`SELECT * FROM ${table} WHERE id = ?`, [id])
  // fallback: last row (for autoincrement)
  return queryOne(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 1`)
}

export async function updateById(table, id, obj) {
  const cols = Object.keys(obj)
  const sets = cols.map((c) => `${c} = ?`).join(', ')
  const sql = `UPDATE ${table} SET ${sets} WHERE id = ?`
  await run(sql, [...cols.map((c) => obj[c]), id])
  return queryOne(`SELECT * FROM ${table} WHERE id = ?`, [id])
}

export async function findById(table, id) {
  return queryOne(`SELECT * FROM ${table} WHERE id = ?`, [id])
}

export default { query, queryOne, run, insert, updateById, findById }
