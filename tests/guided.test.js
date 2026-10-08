import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { createProvider } from '../server/provider.js';
import { Conversation } from '../server/conversation.js';

test('compaction preserves revealed mathematics verbatim without exposing unrevealed steps',()=>{
  const c=new Conversation();c.messages=[{role:'user',content:'Original image question'},{role:'assistant',content:'Understanding'}];
  c.rememberReveal({step:{number:1,title:'Subtract',content:'$7x=35$'}});
  for(let i=0;i<12;i++)c.messages.push({role:'user',content:`Doubt ${i}`},{role:'assistant',content:`Explanation ${i}`});
  c.compact('Earlier explanations');
  const context=c.context();assert.equal(context[0].content,'Original image question');assert.ok(context.some(m=>m.content.includes('$7x=35$')));
  assert.ok(!JSON.stringify(context).includes('x=5'));c.reset();assert.equal(c.revealedContent.size,0);
});

function once(s,event){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Timeout: ${event}`)),5000);s.once(event,v=>{clearTimeout(timer);resolve(v);});});}
async function setup(t,transport='websocket'){
  const store=new Store(':memory:'),calls=[];const baseProvider=createProvider({demo:true});
  const provider={ready:true,demo:true,async *stream(input,options){calls.push(options.mode);yield* baseProvider.stream(input,options);}};
  const app=createApp({store,provider,adminToken:'test-administrator-token-with-32-characters'});await new Promise(r=>app.httpServer.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.httpServer.address().port}`;
  const {partner,apiKey}=store.create({name:'Partner',dailyLimit:50,rpm:30,origins:[]});const clients=[];
  const connect=async()=>{const s=io(`${base}/doubtBuddyLLM`,{transports:[transport],auth:{apiKey},autoConnect:false,reconnection:false});clients.push(s);const done=once(s,'login-success');s.connect();await done;return s;};
  const s=await connect();t.after(async()=>{clients.forEach(s=>s.disconnect());await app.close();store.close();});
  const send=async(event,payload,client=s)=>{const result=once(client,'query-response-solution');client.emit(event,payload);return result;};
  return{base,s,connect,send,calls,store,partner};
}
for(const transport of ['polling','websocket'])test(`${transport}: understanding first, then explicit one/all/final actions; no hidden answer leakage`,async t=>{
  const f=await setup(t,transport);const updates=[];f.s.on('query-update-solution',p=>updates.push(p));
  const understood=once(f.s,'query-understanding');const first=await f.send('text-query',JSON.stringify({textQuestion:'Solve a quadratic'}));
  assert.equal(first.stage,'understanding');assert.deepEqual(await understood,first);assert.equal(first.data.title,"Let's understand");assert.ok(!('steps' in first.data));assert.ok(!('finalAnswer' in first.data));
  assert.ok(updates.every(p=>p.stage==='understanding'&&!p.chunk.startsWith('{')));const payload={questionId:first.questionId};
  const one=await f.send('next-step-query',payload);assert.equal(one.data.step.number,1);assert.equal(one.data.hasMoreSteps,true);assert.ok(!('finalAnswer' in one.data));
  const two=await f.send('next-step-query',payload);assert.equal(two.data.step.number,2);
  const all=await f.send('all-steps-query',payload);assert.equal(all.data.steps.length,3);assert.equal(all.data.hasMoreSteps,false);
  const final=await f.send('solution-query',payload);assert.equal(final.stage,'final-answer');assert.match(final.data.finalAnswer,/boxed/);assert.ok(!('steps' in final.data));
  const end=await f.send('next-step-query',payload);assert.equal(end.data.step,null);assert.equal(end.data.hasMoreSteps,false);
  assert.deepEqual(f.calls,['understanding','plan']);assert.equal(f.store.publicPartner(f.store.get(f.partner.id)).requests,2);
});
test('unknown question IDs and cross-client IDs cannot reveal another conversation',async t=>{
  const f=await setup(t);const first=await f.send('text-query',{textQuestion:'My question'});const other=await f.connect();
  const denied=await f.send('all-steps-query',{questionId:first.questionId},other);assert.equal(denied.error,true);assert.equal(f.calls.length,1);
});
test('malformed JSON returns an application error without breaking the transport',async t=>{
  const f=await setup(t,'polling');const error=await f.send('text-query','{broken');assert.equal(error.error,true);assert.match(error.content,/Invalid JSON/);assert.equal(f.s.connected,true);
  assert.equal((await f.send('text-query',{textQuestion:'Valid question'})).stage,'understanding');
});
test('Engine.IO polling handshake returns a fresh SID; a stale SID returns code 1',async t=>{
  const f=await setup(t);const good=await fetch(`${f.base}/socket.io/?EIO=4&transport=polling`);assert.equal(good.status,200);const packet=await good.text();assert.equal(packet[0],'0');assert.ok(JSON.parse(packet.slice(1)).sid);
  const stale=await fetch(`${f.base}/socket.io/?EIO=4&transport=polling&sid=stale-example-id`);assert.equal(stale.status,400);assert.equal((await stale.json()).code,1);
});
