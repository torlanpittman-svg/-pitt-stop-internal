import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { randomUUID } from 'node:crypto'
import { getValidAccessToken } from '@/apps/quickbooks/connection'
import { qbApiRequest, queryQBO } from '@/apps/quickbooks/client'
import { estimateBody, matchesEstimateContent, assertEstimateIdentity } from '@/apps/estimates/quickbooks'
Object.assign(process.env, parseEnv(readFileSync('.env.local','utf8')))
process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox'
async function main() {
 const token = await getValidAccessToken()
 if (token.environment !== 'sandbox') throw new Error('Refusing to test against production QuickBooks')
 const customers = await queryQBO<{Customer?:{Id:string}[]}>("SELECT * FROM Customer WHERE Active = true MAXRESULTS 1")
 const items = await queryQBO<{Item?:{Id:string}[]}>("SELECT * FROM Item WHERE Type = 'Service' AND Active = true MAXRESULTS 1")
 const customerId = customers.Customer?.[0]?.Id
 const itemId = items.Item?.[0]?.Id
 if (!customerId || !itemId) throw new Error('Sandbox needs a test customer and service item')
 const estimateId = randomUUID()
 const doc = `PS-TEST-${estimateId.slice(0,8)}`
 const body = estimateBody({lines:[{itemId,description:'Temporary estimate integration test',amountCents:100}],customerMemo:'Test vehicle — release validation',privateNote:`PSID:${estimateId}`,totalCents:100}, customerId, '')
 // No recipient and no email call: this only tests create/update/read/delete in sandbox.
 const createBody: Record<string,unknown> = {...body,DocNumber:doc}
 delete createBody.BillEmail
 let created: {Id:string;SyncToken:string} | undefined
 try {
  const result = await qbApiRequest<{Estimate:typeof created & {TotalAmt:number}}>({method:'POST',path:'/estimate',body:createBody,query:{requestid:estimateId}})
  created = result.Estimate
  if (!created || result.Estimate.TotalAmt !== 1) throw new Error('Sandbox estimate creation failed the total check')
  assertEstimateIdentity(result.Estimate, created.Id, estimateId, customerId)
  if (!matchesEstimateContent(result.Estimate,body)) throw new Error('Sandbox returned different estimate content')
  console.log('PASS: actual QuickBooks Estimate create, identity, line content, and exact total')
  const retry = await qbApiRequest<{Estimate:{Id:string}}>({method:'POST',path:'/estimate',body:createBody,query:{requestid:estimateId}})
  if (retry.Estimate.Id !== created.Id) throw new Error('Sandbox create retry did not preserve estimate ID')
  console.log('PASS: QuickBooks request ID deduplicates estimate creation')
  const updateBody={...result.Estimate,CustomerMemo:{value:'Updated release validation vehicle'},sparse:false}
  const updated = await qbApiRequest<{Estimate:{Id:string;SyncToken:string;TotalAmt:number;CustomerMemo?:{value:string}}}>({method:'POST',path:'/estimate',body:updateBody,query:{requestid:randomUUID()}})
  created = updated.Estimate
  if (updated.Estimate.CustomerMemo?.value !== updateBody.CustomerMemo.value || updated.Estimate.TotalAmt !== 1) throw new Error('Sandbox estimate update failed')
  console.log('PASS: QuickBooks estimate updates in place')
 } finally {
  if (!created) {
   const found = await queryQBO<{Estimate?:{Id:string;SyncToken:string}[]}>(`SELECT * FROM Estimate WHERE DocNumber = '${doc}'`)
   created=found.Estimate?.[0]
  }
  if (created) {
   await qbApiRequest({method:'POST',path:'/estimate',query:{operation:'delete',requestid:randomUUID()},body:{Id:created.Id,SyncToken:created.SyncToken}})
   console.log('Temporary sandbox estimate deleted. No email was sent.')
  }
 }
}
main().catch(e=>{console.error('Sandbox verification:', e.message);process.exitCode=1})
