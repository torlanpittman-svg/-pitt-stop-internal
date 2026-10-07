import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runAutopilot, refreshEmailResults } from '@/apps/marketing/autopilot'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export const maxDuration=300
function authorized(req:Request):boolean {
  const secret=process.env.CRON_SECRET
  if(!secret) return false
  const supplied=Buffer.from(req.headers.get('authorization')??''),expected=Buffer.from(`Bearer ${secret}`)
  return supplied.length===expected.length && timingSafeEqual(supplied,expected)
}
export async function GET(req:Request) {
  if(!authorized(req)) return NextResponse.json({ok:false,error:'unauthorized'},{status:401})
  try {
    const result=await runAutopilot()
    if(result.active) await refreshEmailResults()
    return NextResponse.json({ok:true,...result})
  } catch {return NextResponse.json({ok:false,error:'marketing_run_failed_check_launch_console'},{status:500})}
}
