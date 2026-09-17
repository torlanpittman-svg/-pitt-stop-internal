/** Production smoke test: one clearly labeled fixture, no QB writes or emails, always cleaned up. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { neon } from '@neondatabase/serverless'
Object.assign(process.env, parseEnv(readFileSync('.env.local', 'utf8')))
const sql = neon(process.env.DATABASE_URL)
const password = readFileSync('.env.admin-password', 'utf8').trim()
const base = 'https://pitt-stop-internal.vercel.app'
const id = randomUUID()
const name = 'ZZ ESTIMATE RELEASE TEST'
const headers = { authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`, 'Content-Type': 'application/json' }
let vehicleId
let passed = 0
const check = (condition, message) => { if (!condition) throw new Error(message); passed++; console.log(`PASS: ${message}`) }
async function api(path, body) {
 const res = await fetch(base + path, { headers, ...(body ? { method:'POST', body:JSON.stringify(body) } : {}) })
 const data = await res.json()
 if (!res.ok) throw new Error(`${path}: HTTP ${res.status}: ${data.error || 'Request failed'}`)
 return data
}
try {
 const page = await fetch(base + '/estimates', { headers })
 check(page.ok && (await page.text()).includes('New estimate'), 'Live Estimates section loads')
 const unauthorized = await fetch(base + '/api/estimates', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
 check(unauthorized.status === 403 || unauthorized.status === 401, 'Anonymous users cannot create quotes')
 const input = { requestId:id, customerName:name, customerEmail:'', customerPhone:'', year:'2020',make:'Release',model:'Test Vehicle',vin:'',notes:'Temporary release verification. No actual work or customer.' }
 const created = await api('/api/estimates', input)
 check(created.id === id, 'Estimate intake saves')
 const duplicate = await api('/api/estimates', input)
 check(duplicate.id === id, 'Intake retry reuses the same record')
 const [order] = await sql`SELECT vehicle_id, status, arrived_at FROM service_orders WHERE id = ${id}`
 vehicleId = order.vehicle_id
 check(order.status === 'estimate' && order.arrived_at === null, 'Quote has not checked in')
 let board = await api('/api/workflow/orders')
 check(!board.orders.some(o => o.id === id), 'Quote is excluded from Work Board')
 const priced = await api(`/api/workflow/orders/${id}/estimate`, { action:'add_service', title:'Interior Detail', cents:10000 })
 check(priced.view.workTotalCents === 10000, 'Service and work price persist')
 const preview = await api(`/api/estimates/${id}`)
 check(preview.draft.workPriceCents === 10000 && preview.draft.totalCents >= 10000, 'Customer total includes configured fees')
 const conversion = await api(`/api/estimates/${id}`, {action:'convert', revision:preview.revision})
 check(conversion.converted, 'Approved quote moves to Work Board')
 const repeated = await api(`/api/estimates/${id}`, {action:'convert', revision:preview.revision})
 check(repeated.converted, 'Conversion retry succeeds without creating another job')
 board = await api('/api/workflow/orders')
 check(board.orders.filter(o => o.id === id).length === 1, 'Converted job appears exactly once on Work Board')
 const [final] = await sql`SELECT so.status, so.customer_name, so.services, so.arrived_at,
   e.status AS estimate_status, e.total_cents, e.qb_invoice_id,
   (SELECT count(*)::int FROM service_order_events WHERE service_order_id = so.id AND event_type = 'estimate_converted') AS conversions
   FROM service_orders so JOIN job_estimates e ON e.service_order_id = so.id WHERE so.id = ${id}`
 check(final.status === 'arrived' && !!final.arrived_at && final.estimate_status === 'converted', 'Normal workflow begins at Arrived')
 check(final.customer_name === name && final.services.includes('Interior Detail') && final.total_cents === preview.draft.totalCents, 'Customer, services, and exact quote total are preserved')
 check(final.conversions === 1 && !final.qb_invoice_id, 'One conversion event; no invoice created by conversion')
 console.log(`PASS: ${passed} live checks; no QuickBooks writes or emails performed.`)
} finally {
 const rows = await sql`SELECT vehicle_id FROM service_orders WHERE id = ${id} AND customer_name = ${name}`
 vehicleId = rows[0]?.vehicle_id ?? vehicleId
 if (rows.length) await sql.transaction([
   sql`DELETE FROM quick_entry_jobs WHERE service_order_id = ${id} AND customer_name = ${name}`,
   sql`DELETE FROM service_orders WHERE id = ${id} AND customer_name = ${name}`,
   sql`DELETE FROM vehicles WHERE id = ${vehicleId} AND make = 'Release' AND model = 'Test Vehicle'`,
 ])
 const remaining = await sql`SELECT id FROM service_orders WHERE id = ${id}`
 if (remaining.length) throw new Error('Release fixture cleanup did not complete')
 console.log('Temporary release fixture removed.')
}
