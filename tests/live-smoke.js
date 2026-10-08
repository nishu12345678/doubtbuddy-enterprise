// Explicitly opt-in: uses the configured OpenAI account for one short live request.
// Run: node --env-file=.env tests/live-smoke.js
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const base = `http://127.0.0.1:${process.env.PORT || 3001}`;
const auth = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
let partnerId, socket;
try {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ready, true, 'AI provider is not configured.');
  assert.equal(health.demo, false, 'Live test requires demo mode to be disabled.');
  const response = await fetch(`${base}/api/admin/partners`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'Live integration verification', dailyLimit: 2, rpm: 2 })
  });
  assert.equal(response.status, 201, 'Could not create the verification partner.');
  const partner = await response.json(); partnerId = partner.partner.id;
  const exchange = await fetch(`${base}/api/session`, { method: 'POST', headers: { Authorization: `Bearer ${partner.apiKey}` } });
  assert.equal(exchange.status, 200, 'Could not exchange the partner key.');
  const { token } = await exchange.json();
  socket = io(`${base}/doubtBuddyLLM`, { transports: ['polling', 'websocket'], auth: { token }, autoConnect: false, reconnection: false });
  await new Promise((resolve,reject)=>{socket.once('login-success',resolve);socket.once('connect_error',reject);socket.connect();});
  function query(event,payload){return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Live request timeout')),125000);
    socket.once('query-response-solution',r=>{clearTimeout(timer);r.error?reject(Error(r.content)):resolve(r);});socket.emit(event,payload);
  });}
  const understanding=await query('text-query',JSON.stringify({textQuestion:'Solve 7x + 3 = 38.'}));
  assert.equal(understanding.stage,'understanding');assert.equal(understanding.data.canProceed,true);
  assert.ok(!understanding.content.includes('\\boxed'));
  const payload={questionId:understanding.questionId};
  const first=await query('next-step-query',payload);assert.equal(first.data.step.number,1);
  const all=await query('all-steps-query',payload);assert.ok(all.data.steps.length>=2);
  const final=await query('solution-query',payload);assert.equal(final.stage,'final-answer');assert.match(final.data.finalAnswer,/5/);
  console.log(JSON.stringify({liveOpenAI:'passed',partnerAuthentication:'passed',browserSession:'passed',understandingFirst:'passed',oneStep:'passed',allSteps:'passed',finalAnswer:final.data.finalAnswer}));

} catch (error) {
  console.error(`Live verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  socket?.disconnect();
  if (partnerId) {
    const cleanup = await fetch(`${base}/api/admin/partners/${partnerId}`, { method: 'DELETE', headers: auth });
    if (!cleanup.ok) { console.error('Verification partner cleanup failed. Revoke it from the admin console.'); process.exitCode = 1; }
    else console.log('Temporary verification key revoked.');
  }
}
