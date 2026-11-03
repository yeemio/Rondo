import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RondoClient } from '../../modules/contracts/public/client';
import type { CommandReceipt } from '../../modules/contracts/public/receipts';
import { restorePendingRetention, saveReviewedRetention } from '../../apps/web/src/client/retention-flow';
import type { PendingRetention, RetentionIntent, RetentionState } from '../../apps/web/src/client/retention-flow';
const intent: RetentionIntent={mode:'ROLLING_DAYS',rollingDays:30,previewVersion:'reviewed-preview'};
const applied: CommandReceipt={protocolVersion:'rondo.v1',commandId:'cmd-retention',idempotencyKey:'idem-retention',kind:'family.setRetention',status:'APPLIED',effectRefs:[],changedKinds:['guardian.retentionPolicy']};
const state: RetentionState={kind:'guardian.retentionPolicy',policy:{...intent,setAt:100},lastCleanup:null};
function memory(){const holder={pending:null as PendingRetention|null};return {holder,remember:(p:PendingRetention|null)=>{holder.pending=p;}};}

test('retention save echoes the exact reviewed identity and only reads actual policy after APPLIED; never fetches a new preview',async()=>{
 const m=memory();const commands:unknown[]=[];const queries:unknown[]=[];
 const client={command:async(e:unknown)=>{commands.push(e);return applied;},query:async(q:unknown)=>{queries.push(q);return state;}} as unknown as RondoClient;
 assert.deepEqual(await saveReviewedRetention(client,intent,null,m.remember),state);
 assert.equal((commands[0] as {payload:{confirmedPreviewVersion:string}}).payload.confirmedPreviewVersion,'reviewed-preview');
 assert.deepEqual(queries,[{kind:'guardian.retentionPolicy'}]);assert.equal(m.holder.pending,null);
});

test('retention rejection cannot report saved or substitute a fresh scope',async()=>{
 const m=memory();let reads=0;
 const client={command:async()=>({...applied,status:'REJECTED',errorCode:'INVALID_OPERATION'}),query:async()=>{reads++;return state;}} as unknown as RondoClient;
 await assert.rejects(saveReviewedRetention(client,intent,null,m.remember),/政策未保存/);assert.equal(reads,0);assert.equal(m.holder.pending,null);
});

for(const code of ['UNAUTHENTICATED','FORBIDDEN','PERSISTENCE_FAILED','HOST_RECOVERING'])test(`retention explicit ${code} denial clears unsent state and permits normal save after unlock`,async()=>{
 const m=memory();let calls=0;
 const client={command:async()=>{if(++calls===1)throw {code};return applied;},query:async()=>state,receipt:async()=>{throw Error('must not lookup unsent denial');}} as unknown as RondoClient;
 await assert.rejects(saveReviewedRetention(client,intent,null,m.remember));assert.equal(m.holder.pending,null);
 assert.deepEqual(await saveReviewedRetention(client,intent,m.holder.pending,m.remember),state);assert.equal(calls,2);
});

test('retention delivery unknown survives reload, missing receipt and receipt auth denial; original key recovery never resends',async()=>{
 const m=memory();let writes=0;let mode='missing';const keys:string[]=[];
 const client={command:async()=>{writes++;throw {code:'HOST_RECOVERING',transport:'RECEIPT_UNKNOWN'};},query:async()=>state,
 receipt:async(q:{idempotencyKey:string})=>{keys.push(q.idempotencyKey);if(mode==='denied')throw {code:'UNAUTHENTICATED'};return mode==='missing'?{status:'NOT_FOUND'}:{status:'CONFIRMED',receipt:applied};}} as unknown as RondoClient;
 await assert.rejects(saveReviewedRetention(client,intent,null,m.remember));const original=restorePendingRetention(JSON.stringify(m.holder.pending));assert.ok(original);
 await assert.rejects(saveReviewedRetention(client,intent,original,m.remember));assert.equal(m.holder.pending?.key,original.key);
 mode='denied';await assert.rejects(saveReviewedRetention(client,intent,original,m.remember));assert.equal(m.holder.pending?.key,original.key);
 mode='confirmed';assert.deepEqual(await saveReviewedRetention(client,intent,original,m.remember),state);
 assert.equal(writes,1);assert.deepEqual(keys,[original.key,original.key,original.key]);assert.equal(m.holder.pending,null);
});

test('retention APPLIED with lost readback keeps original key; later recovery verifies facts and never writes again',async()=>{
 const m=memory();let reads=0;let writes=0;
 const client={command:async()=>{writes++;return applied;},query:async()=>{if(++reads===1)throw Error('disconnected');return state;},receipt:async()=>({status:'CONFIRMED',receipt:applied})} as unknown as RondoClient;
 await assert.rejects(saveReviewedRetention(client,intent,null,m.remember),/disconnected/);assert.ok(m.holder.pending);
 assert.deepEqual(await saveReviewedRetention(client,intent,m.holder.pending,m.remember),state);assert.equal(writes,1);assert.equal(m.holder.pending,null);
});

test('retention concurrent overwrite after APPLIED is not misreported as the current saved policy',async()=>{
 const m=memory();const client={command:async()=>applied,query:async()=>({...state,policy:{...state.policy!,previewVersion:'later-policy',rollingDays:60}})} as unknown as RondoClient;
 await assert.rejects(saveReviewedRetention(client,intent,null,m.remember),/当前政策已被再次修改/);assert.equal(m.holder.pending,null);
});
