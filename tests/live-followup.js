// Opt-in: six live OpenAI calls through the running enterprise WebSocket server.
// node --env-file=.env tests/live-followup.js
import { chromium } from '@playwright/test';
import { io } from 'socket.io-client';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { solutionSteps } from '../shared/steps.js';
const base=`http://127.0.0.1:${process.env.PORT||3001}`;
const headers={Authorization:`Bearer ${process.env.ADMIN_TOKEN}`,'Content-Type':'application/json'};
let partnerId,socket,browser;
mkdirSync('test-results',{recursive:true});
function query(event,payload){return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{socket.off('query-response-solution',receive);reject(new Error('Request timeout'));},125000);
  function receive(result){clearTimeout(timer);if(result.error)reject(new Error(result.content));else resolve(result);}
  socket.once('query-response-solution',receive);socket.emit(event,payload);
});}
function record(name,result){writeFileSync(`test-results/live-${name}.md`,result.content);console.log(`${name}: completed`);}
try{
  const created=await fetch(`${base}/api/admin/partners`,{method:'POST',headers,body:JSON.stringify({name:'Follow-up integration verification',dailyLimit:10,rpm:10})});
  assert.equal(created.status,201);const p=await created.json();partnerId=p.partner.id;
  socket=io(`${base}/doubtBuddyLLM`,{transports:['websocket'],auth:{apiKey:p.apiKey},autoConnect:false,reconnection:false});
  await new Promise((resolve,reject)=>{socket.once('login-success',resolve);socket.once('connect_error',()=>reject(Error('Socket authentication failed')));socket.connect();});
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:900,height:450}});
  await page.setContent('<body style="font:28px Arial;padding:35px;background:white;color:black"><h2>Class 8 mathematics</h2><p>Q1. Find the perimeter of a square of side 6 cm.</p><p>Q2. Solve: 7x + 3 = 38.</p></body>');
  const image=await page.screenshot();await browser.close();browser=null;
  const imageInput={fileContent:`data:image/png;base64,${image.toString('base64')}`,fileName:'worksheet.png',textQuestion:'Solve Q2 only.',profile:{classLevel:'Class 8',language:'English',difficulty:'standard'}};
  const extraction=await query('image-extract',imageInput);record('extraction',extraction);
  for(const field of ['QUESTION_TEXT','OPTIONS','DIAGRAM_DESCRIPTION','SUBJECT_GUESS','LEVEL_GUESS','MULTIPLE_QUESTIONS','UNCLEAR_PARTS'])assert.ok(extraction.content.includes(field));
  const solution=await query('image-query',{...imageInput,extractedText:extraction.content});record('image-understanding',solution);assert.equal(solution.stage,'understanding');
  const revealed=await query('all-steps-query',{questionId:solution.questionId});
  const final=await query('solution-query',{questionId:solution.questionId});assert.match(final.content,/5/);
  const steps=revealed.data.steps.map(s=>({step_number:String(s.number),step_title:s.title,step:s.content}));assert.ok(steps.length);const step=steps[0];
  const hindi=await query('followup-query',{question:'मुझे यह चरण समझ नहीं आया। इसे एक छोटे उदाहरण से समझाइए।',...step,answer_id:revealed.requestId});record('hindi-followup',hindi);
  assert.match(hindi.content,/[\u0900-\u097f]/);assert.ok(!hindi.content.includes('**Concept used**'));assert.ok(!/^###\s*Step/im.test(hindi.content));assert.ok(hindi.content.length<3000);
  const malayalam=await query('followup-query',{question:'സമവാക്യത്തിന്റെ ഇരുവശത്തും ഒരേ സംഖ്യ കുറയ്ക്കുന്നത് എന്തുകൊണ്ടാണ്? ഇത് മാത്രം ലളിതമായി വിശദീകരിക്കൂ.'});record('malayalam-followup',malayalam);assert.match(malayalam.content,/[\u0d00-\u0d7f]/);assert.ok(!malayalam.content.includes('**Concept used**'));assert.ok(!/^###\s*Step/im.test(malayalam.content));
  const english=await query('followup-query',{question:'Why must we do the same operation on both sides? Please use one short analogy.'});record('english-followup',english);assert.ok(!/[\u0900-\u097f\u0d00-\u0d7f]/.test(english.content));
  const advanced=await query('text-query',{textQuestion:'Solve x squared minus 5x plus 6 equals zero. Keep the explanation brief.',profile:{examTarget:'JEE Advanced',difficulty:'advanced',language:'English'}});assert.equal(advanced.stage,'understanding');const result=await query('solution-query',{questionId:advanced.questionId});record('reasoning-route',result);assert.match(result.content,/2/);assert.match(result.content,/3/);
  console.log('Live checks passed: image extraction/review, image solution, step follow-up, Hindi, Malayalam, English switch, reasoning-model route.');
}catch(error){console.error(`Live follow-up verification failed: ${error.message}`);process.exitCode=1;}
finally{socket?.disconnect();await browser?.close();if(partnerId){await fetch(`${base}/api/admin/partners/${partnerId}`,{method:'DELETE',headers});console.log('Temporary verification key revoked.');}}
