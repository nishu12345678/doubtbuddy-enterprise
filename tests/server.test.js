import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { createProvider } from '../server/provider.js';
import { parseStep } from '../shared/steps.js';
import { demoUnderstanding, demoPlan } from '../server/guided.js';
const adminToken='test-administrator-token-at-least-32-characters';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=';
function once(s,event){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{s.off(event,receive);reject(new Error(`Timed out: ${event}`));},5000);function receive(data){clearTimeout(timer);resolve(data);}s.once(event,receive);});}
async function fixture(t,{provider,timeout}={}){
  const calls=[];
  provider ||= {ready:true,demo:false,async *stream(input,{common,signal}){calls.push(input);yield {delta:common?'["Why?","How?","What next?"]':'The answer is $x=2$.'};if(signal.aborted)throw Error('aborted');yield {usage:{input_tokens:10,output_tokens:5}};}};
  // Older unit fixtures supply text; adapt only those fixture outputs to the new
  // structured provider contract. Staged-flow tests exercise the real demo adapter.
  const source=provider;
  provider={...source,async *stream(input,options){
    if(!['understanding','plan'].includes(options.mode)){yield* source.stream(input,options);return;}
    let text='';for await(const event of source.stream(input,options)){if(event.delta)text+=event.delta;else yield event;}
    const document=options.mode==='understanding'?{...demoUnderstanding,content:text}:{...demoPlan,steps:[{number:1,title:'Isolate x',content:text}],finalAnswer:text};
    yield{delta:JSON.stringify(document)};
  }};
  const store=new Store(':memory:');const server=createApp({store,provider,adminToken,publicUrl:'http://localhost:5173',requestTimeout:timeout||120000});
  await new Promise(r=>server.httpServer.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.httpServer.address().port}`;
  const clients=[];t.after(async()=>{clients.forEach(s=>s.disconnect());await server.close();store.close();});
  const partner=(options={})=>store.create({name:'Test School',dailyLimit:100,rpm:30,origins:[],...options});
  function connect(auth={}){const s=io(`${url}/doubtBuddyLLM`,{transports:['websocket'],auth,autoConnect:false,reconnection:false});clients.push(s);return s;}
  async function login(key){const s=connect({apiKey:key});const done=once(s,'login-success');s.connect();await done;return s;}
  async function request(path,method='GET',body,token=adminToken){return fetch(`${url}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
  return {store,server,url,partner,connect,login,request,calls};
}
test('admin creates a partner, reveals key once, and stores only its hash',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/api/admin/partners','GET',undefined,'bad')).status,401);
  const response=await f.request('/api/admin/partners','POST',{name:'Infinity Learn'});assert.equal(response.status,201);const data=await response.json();
  assert.match(data.apiKey,/^db_live_/);assert.ok(data.url.includes(encodeURIComponent(data.apiKey)));
  const stored=f.store.get(data.partner.id);assert.notEqual(stored.key_hash,data.apiKey);
  const list=await (await f.request('/api/admin/partners')).text();assert.ok(!list.includes(data.apiKey));assert.ok(!list.includes(stored.key_hash));
});
test('unauthenticated requests and invalid handshake credentials cannot invoke AI',async t=>{
  const f=await fixture(t);const s=f.connect();let done=once(s,'ack');s.connect();await done;
  done=once(s,'query-response-solution');s.emit('text-query',{textQuestion:'Hi'});assert.equal((await done).error,true);assert.equal(f.calls.length,0);
  const bad=f.connect({apiKey:'invalid'});done=once(bad,'connect_error');bad.connect();assert.match((await done).message,/Invalid/);
});
test('workbook login event and ack preserve compatibility without echoing a full key',async t=>{
  const f=await fixture(t);const p=f.partner();const s=f.connect();let done=once(s,'ack');s.connect();assert.ok((await done).socketId);
  done=once(s,'login-success');s.emit('login',{apiKey:p.apiKey});const result=await done;assert.equal(result.status,true);assert.notEqual(result.aapiKey,p.apiKey);
});
test('text streams in order and updates usage; follow-up retains only its own conversation',async t=>{
  const f=await fixture(t);const p=f.partner();const a=await f.login(p.apiKey);const b=await f.login(f.partner({name:'Other School'}).apiKey);
  const events=[];for(const event of ['processing-status','query-update-solution','query-response-solution'])a.on(event,payload=>events.push({event,payload}));
  let done=once(a,'query-response-solution');a.emit('text-query',{textQuestion:'tenant-a-private-question'});assert.equal((await done).error,false);
  assert.deepEqual(events.slice(0,3).map(x=>x.event),['processing-status','query-update-solution','query-response-solution']);
  done=once(b,'query-response-solution');b.emit('followup-query',[{step:'step',question:'tenant-b'}]);await done;
  assert.ok(!JSON.stringify(f.calls[1]).includes('tenant-a-private-question'));
  const bot=once(a,'followup-query-bot');done=once(a,'query-response-solution');a.emit('followup-query',[{step:'x=2',question:'Why?'}]);await done;assert.ok((await bot).bot);assert.ok(JSON.stringify(f.calls[2]).includes('tenant-a-private-question'));
  assert.equal(f.store.publicPartner(f.store.get(p.partner.id)).requests,2);assert.equal(f.store.publicPartner(f.store.get(p.partner.id)).tokens,30);
});
test('image input validates content; common questions use the specified output event',async t=>{
  const f=await fixture(t),s=await f.login(f.partner().apiKey);
  let done=once(s,'query-response-solution');s.emit('image-query',{fileContent:'data:image/png;base64,YWJj',fileName:'bad.png'});assert.equal((await done).error,true);assert.equal(f.calls.length,0);
  done=once(s,'query-response-solution');s.emit('image-query',{fileContent:image,fileName:'question.png'});assert.equal((await done).error,false);assert.equal(f.calls[0][0].content[1].type,'input_image');
  const questions=once(s,'common-question-solution');done=once(s,'query-response-solution');s.emit('common-question-query',{step:'Factor the equation.'});await done;assert.equal((await questions).commonSolution.length,3);
});
test('malformed payloads do not consume partner allowance',async t=>{
  const f=await fixture(t),p=f.partner(),s=await f.login(p.apiKey);
  for(const payload of [null,{}, {textQuestion:''},{textQuestion:'x'.repeat(12001)}]){const done=once(s,'query-response-solution');s.emit('text-query',payload);assert.equal((await done).error,true);}
  assert.equal(f.store.publicPartner(f.store.get(p.partner.id)).requests,0);
});
test('daily and minute limits are enforced across connections',async t=>{
  const f=await fixture(t);
  for(const options of [{dailyLimit:1},{rpm:1}]){
    const p=f.partner(options),a=await f.login(p.apiKey),b=await f.login(p.apiKey);
    let done=once(a,'query-response-solution');a.emit('text-query',{textQuestion:'First'});await done;
    done=once(b,'query-response-solution');b.emit('text-query',{textQuestion:'Second'});assert.equal((await done).error,true);
  }
  assert.equal(f.calls.length,2);
});
test('revocation disconnects clients and invalidates keys and browser sessions',async t=>{
  const f=await fixture(t),p=f.partner();const session=await (await f.request('/api/session','POST',undefined,p.apiKey)).json();
  const s=f.connect({token:session.token});const loggedIn=once(s,'login-success');s.connect();await loggedIn;
  const disconnected=once(s,'disconnect');await f.request(`/api/admin/partners/${p.partner.id}`,'DELETE');await disconnected;
  assert.equal(f.store.authenticate(p.apiKey),null);assert.equal(f.store.authenticate(session.token,true),null);
});
test('rotation and expiration invalidate old credentials',async t=>{
  const f=await fixture(t),p=f.partner();const session=f.store.session(p.partner.id);
  const rotated=await (await f.request(`/api/admin/partners/${p.partner.id}/rotate`,'POST')).json();assert.ok(f.store.authenticate(rotated.apiKey));assert.equal(f.store.authenticate(p.apiKey),null);assert.equal(f.store.authenticate(session.token,true),null);
  f.store.db.prepare('UPDATE partners SET expires_at=? WHERE id=?').run(Date.now()-1,p.partner.id);assert.equal(f.store.authenticate(rotated.apiKey),null);
});
test('unknown origins are denied and partners cannot use another partner origin',async t=>{
  const f=await fixture(t);const a=f.partner({origins:['https://a.example']}),b=f.partner({origins:['https://b.example']});
  const response=await fetch(`${f.url}/api/session`,{method:'POST',headers:{Authorization:`Bearer ${a.apiKey}`,Origin:'https://b.example'}});assert.equal(response.status,401);
  const bad=await fetch(`${f.url}/api/session`,{method:'POST',headers:{Authorization:`Bearer ${b.apiKey}`,Origin:'https://evil.example'}});assert.equal(bad.status,403);
});
test('cancel and timeout abort in-flight provider work',async t=>{
  let aborted=0;
  const provider={ready:true,demo:false,async *stream(_input,{signal}){await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted++;reject(Error('aborted'));},{once:true});});yield {delta:'never'};}};
  const f=await fixture(t,{provider,timeout:50}),s=await f.login(f.partner().apiKey);
  let done=once(s,'query-response-solution');let started=once(s,'processing-status');s.emit('text-query',{textQuestion:'Cancel me'});await started;s.emit('cancel-query');assert.equal((await done).error,true);
  done=once(s,'query-response-solution');s.emit('text-query',{textQuestion:'Timeout'});assert.equal((await done).error,true);assert.equal(aborted,2);
});
test('missing OpenAI configuration never returns a fake successful solution',async t=>{
  const f=await fixture(t,{provider:createProvider({demo:false})}),s=await f.login(f.partner().apiKey);
  const done=once(s,'query-response-solution');s.emit('text-query',{textQuestion:'Solve this'});assert.equal((await done).code,'NOT_CONFIGURED');
});
test('OpenAI adapter maps Responses SSE text and usage and disables storage',async()=>{
  let body;
  const provider=createProvider({apiKey:'test-not-real',model:'test-model',fetch:async(_url,options)=>{
    body=JSON.parse(options.body);
    return new Response('data: {"type":"response.output_text.delta","delta":"$x=2$"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }});
  const output=[];for await(const event of provider.stream([{role:'user',content:'Solve'}],{}))output.push(event);
  assert.equal(body.stream,true);assert.equal(body.store,false);assert.equal(output[0].delta,'$x=2$');assert.equal(output[1].usage.output_tokens,3);
  assert.match(body.instructions,/DoubtBuddy Tutor/);assert.match(body.instructions,/JEE \(Main & Advanced\)/);
  assert.match(body.instructions,/Concept used/);assert.match(body.instructions,/Hinglish/);
});
test('OpenAI adapter treats incomplete streams as a failure',async()=>{
  const provider=createProvider({apiKey:'test-not-real',model:'test',fetch:async()=>new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n',{headers:{'Content-Type':'text/event-stream'}})});
  await assert.rejects(async()=>{for await(const _ of provider.stream([{role:'user',content:'Solve'}],{})){}},/before completion/);
});
test('image instructions reach the model and clarification follow-ups retain the original image',async t=>{
  const f=await fixture(t),s=await f.login(f.partner().apiKey);
  let done=once(s,'query-response-solution');s.emit('image-query',{fileContent:image,fileName:'worksheet.png',textQuestion:'Solve Q4 for Class 8 in Hindi.'});await done;
  assert.equal(f.calls[0][0].content[0].text,'Solve Q4 for Class 8 in Hindi.');
  done=once(s,'query-response-solution');s.emit('followup-query',[{step:'Which question?',question:'The second one.'}]);await done;
  assert.equal(f.calls[1][0].content[1].image_url,image);
  done=once(s,'query-response-solution');s.emit('image-query',{fileContent:image,fileName:'worksheet.png',textQuestion:'x'.repeat(12001)});assert.equal((await done).error,true);
  assert.equal(f.calls.length,2);
});
test('suggestion operation forwards tutor language and level rules with a JSON-only override',async()=>{
  let body;
  const provider=createProvider({apiKey:'test-not-real',model:'test-model',fetch:async(_url,options)=>{
    body=JSON.parse(options.body);
    return new Response('data: {"type":"response.output_text.delta","delta":"[\\"Why?\\",\\"How?\\",\\"What next?\\"]"}\n\ndata: {"type":"response.completed","response":{"usage":{}}}\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }});
  for await(const _ of provider.stream([{role:'user',content:'Fractions for Class 4'}],{common:true})){}
  assert.match(body.instructions,/Class 1/);assert.match(body.instructions,/student's language/);
  assert.match(body.instructions,/replace the normal response format with ONLY a JSON array/);
});
test('follow-up developer mode is immediately before the current question with history intact',async()=>{
  let body;
  const provider=createProvider({apiKey:'test',model:'gpt-4.1-mini',fetch:async(_url,options)=>{body=JSON.parse(options.body);return new Response('data: {"type":"response.completed","response":{"usage":{}}}\n\n',{headers:{'Content-Type':'text/event-stream'}});}});
  const prior=[{role:'user',content:'Original question'},{role:'assistant',content:'### Step 3: Divide by two'},{role:'user',content:'Why divide?'}];
  for await(const _ of provider.stream(prior,{followup:[{step_number:3,step_title:'Divide by two'}],profile:{classLevel:'Class 9',language:'Malayalam'}})){}
  assert.equal(body.input.at(-2).role,'developer');assert.match(body.input.at(-2).content,/FOLLOW-UP MODE/);assert.match(body.input.at(-2).content,/Step 3: "Divide by two"/);
  assert.match(body.input.at(-2).content,/Do NOT re-solve/);assert.equal(body.input.at(-1).content,'Why divide?');assert.equal(body.input[1].content,'Original question');
  assert.equal(body.temperature,0.3);assert.match(body.instructions,/Hindi gets Hindi/);assert.match(body.instructions,/Malayalam gets Malayalam/);
  for await(const _ of provider.stream(prior,{followup:[{}]})){}
  assert.ok(!body.input.at(-2).content.includes('They are asking specifically'));
});
test('advanced solving uses the configured reasoning model without unsupported temperature',async()=>{
  const bodies=[];const provider=createProvider({apiKey:'test',model:'gpt-4.1-mini',reasoningModel:'gpt-5-mini',fetch:async(_url,options)=>{bodies.push(JSON.parse(options.body));return new Response('data: {"type":"response.completed","response":{"usage":{}}}\n\n',{headers:{'Content-Type':'text/event-stream'}});}});
  const input=[{role:'user',content:'Solve'}];
  for await(const _ of provider.stream(input,{profile:{examTarget:'JEE Advanced'}})){}
  assert.equal(bodies[0].model,'gpt-5-mini');assert.ok(!('temperature' in bodies[0]));assert.equal(bodies[0].reasoning.effort,'medium');
  for await(const _ of provider.stream(input,{common:true,profile:{examTarget:'JEE Advanced'}})){}
  assert.equal(bodies[1].model,'gpt-4.1-mini');
});
test('long image conversations retain original question and solution, summarizing only older follow-ups',async t=>{
  const calls=[];const provider={ready:true,demo:false,async *stream(input,options){calls.push({input,options});yield{delta:options.mode==='summary'?'Student needed fraction prerequisite. Corrected answer is 5.':'### Step 1: Isolate x\nAnswer 5.'};yield{usage:{input_tokens:1,output_tokens:1}};}};
  const f=await fixture(t,{provider}),p=f.partner(),s=await f.login(p.apiKey);
  let done=once(s,'query-response-solution');s.emit('image-query',{fileContent:image,fileName:'q.png',profile:{classLevel:'Class 9',language:'Hindi'}});const understanding=await done;
  done=once(s,'query-response-solution');s.emit('all-steps-query',{questionId:understanding.questionId});const original=await done;
  for(let i=0;i<12;i++){done=once(s,'query-response-solution');s.emit('followup-query',{question:`Earlier follow-up ${i}`,step_number:1,answer_id:original.requestId,step_title:'Client title must not override saved title'});assert.equal((await done).error,false);}
  const summaries=calls.filter(c=>c.options.mode==='summary');assert.equal(summaries.length,1);
  const latest=calls.at(-1);assert.equal(latest.input[0].content[1].image_url,image);assert.equal(latest.input[0].content[1].detail,'high');assert.match(latest.input[1].content,/Isolate x/);
  assert.ok(JSON.stringify(latest.input).includes('Student needed fraction prerequisite'));assert.equal(latest.options.followup[0].step_title,'Isolate x');assert.equal(latest.options.profile.language,'Hindi');
  assert.equal(f.store.publicPartner(f.store.get(p.partner.id)).tokens,30);
});
test('extraction is separate from solving and reviewed text accompanies the original image',async t=>{
  const calls=[];const provider={ready:true,demo:false,async *stream(input,options){calls.push({input,options});yield{delta:options.mode==='extract'?'QUESTION_TEXT: 2+2\nUNCLEAR_PARTS: none':'### Step 1: Add\n4'};}};
  const f=await fixture(t,{provider}),s=await f.login(f.partner().apiKey);
  let done=once(s,'query-response-solution');s.emit('text-query',{textQuestion:'Original typed question'});await done;
  const extracted=once(s,'image-extraction-result');done=once(s,'query-response-solution');s.emit('image-extract',{fileContent:image,fileName:'q.png'});await done;assert.match((await extracted).content,/QUESTION_TEXT/);
  done=once(s,'query-response-solution');s.emit('followup-query',{question:'Explain my original question'});await done;assert.equal(calls[2].input[0].content,'Original typed question');
  done=once(s,'query-response-solution');s.emit('image-query',{fileContent:image,fileName:'q.png',extractedText:'QUESTION_TEXT: 2+3 (corrected)'});await done;
  assert.match(calls[3].input[0].content[0].text,/2\+3 \(corrected\)/);assert.equal(calls[3].input[0].content[1].image_url,image);
});
test('step identifiers support substeps and localized Hindi and Malayalam headings',()=>{
  assert.deepEqual(parseStep('Step 3a: Divide'),{step_number:'3a',step_title:'Divide'});
  assert.deepEqual(parseStep('चरण ३: भाग देना'),{step_number:'3',step_title:'भाग देना'});
  assert.deepEqual(parseStep('ഘട്ടം ൨: വിശദീകരണം'),{step_number:'2',step_title:'വിശദീകരണം'});
  assert.equal(parseStep('Concept used'),null);
});
test('extraction uses a strict schema and formats all seven fields without leaking JSON chunks',async()=>{
  const fields={QUESTION_TEXT:'2+2',OPTIONS:'none',DIAGRAM_DESCRIPTION:'none',SUBJECT_GUESS:'Maths',LEVEL_GUESS:'Class 1',MULTIPLE_QUESTIONS:'no',UNCLEAR_PARTS:'none'};
  let body;const provider=createProvider({apiKey:'test',model:'gpt-4.1-mini',fetch:async(_url,options)=>{body=JSON.parse(options.body);return new Response(`data: ${JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify(fields)})}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":4}}}\n\n`,{headers:{'Content-Type':'text/event-stream'}});}});
  const events=[];for await(const event of provider.stream([{role:'user',content:'Read image'}],{mode:'extract'}))events.push(event);
  assert.equal(body.text.format.type,'json_schema');assert.equal(body.text.format.strict,true);assert.match(body.instructions,/Do not solve/);assert.ok(!body.instructions.includes('Step-by-step solution'));
  const deltas=events.filter(e=>e.delta);assert.equal(deltas.length,1);assert.match(deltas[0].delta,/QUESTION_TEXT: 2\+2/);assert.match(deltas[0].delta,/UNCLEAR_PARTS: none/);
});
