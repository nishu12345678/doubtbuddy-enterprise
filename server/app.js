import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Server } from 'socket.io';
import { hash } from './store.js';
import { textSchema, stepSchema, followupSchema, partnerSchema, imageContent, imageSchema } from './validation.js';
import { Conversation } from './conversation.js';
import { solutionSteps } from '../shared/steps.js';
import { parseGuided, actionSchema, reveal } from './guided.js';
const decodePayload=value=>{if(typeof value!=='string')return value;if(value.length>7200000)throw new Error('Request too large.');try{return JSON.parse(value);}catch{throw new Error('Invalid JSON payload. Emit a JSON object, not an incomplete JSON string.');}};

export function createApp({ store, provider, adminToken, publicUrl='http://localhost:5173', allowedOrigins=[], requestTimeout=120000 }) {
  if (!adminToken || adminToken.length < 32) throw new Error('ADMIN_TOKEN must contain at least 32 characters. Run npm run setup.');
  const app = express(), httpServer = createServer(app);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy:{ directives:{ 'connect-src':["'self'",'ws:','wss:'], 'img-src':["'self'",'data:','blob:'], 'style-src':["'self'","'unsafe-inline'"], 'upgrade-insecure-requests':null } }, referrerPolicy:{ policy:'no-referrer' } }));
  app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.use(express.json({limit:'16kb'}));
  const globalOrigins = new Set([...allowedOrigins,new URL(publicUrl).origin]);
  const partnerOrigin = (p, origin) => !origin || globalOrigins.has(origin) || JSON.parse(p.origins).includes(origin);
  const knownOrigin = origin => !origin || globalOrigins.has(origin) || store.list().some(p=>p.active && p.origins.includes(origin));
  app.use('/api',(req,res,next)=>{
    const origin=req.headers.origin;
    if (origin && !knownOrigin(origin)) return res.status(403).json({error:'Origin is not allowed.'});
    if (origin) {res.set('Access-Control-Allow-Origin',origin);res.vary('Origin');res.set('Access-Control-Allow-Headers','Authorization, Content-Type');res.set('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');}
    if(req.method==='OPTIONS')return res.sendStatus(204); next();
  });
  app.get('/api/health',(_req,res)=>res.json({status:'ok',ready:provider.ready,demo:provider.demo}));
  const authLimit=rateLimit({windowMs:60000,limit:20,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many authentication attempts. Try again in a minute.'}});
  app.post('/api/session',authLimit,(req,res)=>{
    const key=req.headers.authorization?.replace(/^Bearer /,'');
    const p=store.authenticate(key);
    if(!p || !partnerOrigin(p,req.headers.origin))return res.status(401).json({error:'Invalid, expired, or revoked partner key.'});
    const session=store.session(p.id);
    res.json({...session,partner:{id:p.id,name:p.name}});
  });
  app.use('/api/admin',authLimit,(req,res,next)=>{
    const token=req.headers.authorization?.replace(/^Bearer /,'')||'';
    if(!timingSafeEqual(Buffer.from(hash(token),'hex'),Buffer.from(hash(adminToken),'hex')))return res.status(401).json({error:'Invalid administrator token.'});
    next();
  });
  app.get('/api/admin/partners',(_req,res)=>res.json({partners:store.list(),ready:provider.ready,demo:provider.demo}));
  const withUrl=result=>({...result,url:`${publicUrl.replace(/\/$/,'')}/?key=${encodeURIComponent(result.apiKey)}`});
  app.post('/api/admin/partners',(req,res)=>{
    const parsed=partnerSchema.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Enter a partner name, positive limits, and valid origins (for example https://school.example).'});
    res.status(201).json(withUrl(store.create(parsed.data)));
  });
  app.post('/api/admin/partners/:id/rotate',(req,res)=>{
    if(!store.get(req.params.id))return res.status(404).json({error:'Partner not found.'});
    const result=store.rotate(req.params.id); disconnectPartner(req.params.id);
    res.json(withUrl(result));
  });
  app.delete('/api/admin/partners/:id',(req,res)=>{
    if(!store.get(req.params.id))return res.status(404).json({error:'Partner not found.'});
    store.revoke(req.params.id); disconnectPartner(req.params.id); res.json({ok:true});
  });
  const attempts=new Map();
  const sweep=setInterval(()=>{for(const [ip,v] of attempts)if(v.reset<Date.now())attempts.delete(ip);},60000);sweep.unref();
  function attempt(ip) {
    const now=Date.now();let state=attempts.get(ip);
    if(!state||state.reset<now){state={n:0,reset:now+60000};attempts.set(ip,state);}
    return ++state.n<=40;
  }
  const io = new Server(httpServer,{ transports:['polling','websocket'],maxHttpBufferSize:7200000,pingTimeout:20000,
    allowRequest:(req,callback)=>callback(null,knownOrigin(req.headers.origin) && attempt(req.socket.remoteAddress)),
    cors:{origin:(origin,cb)=>cb(null,knownOrigin(origin))}
  });
  const ns=io.of('/doubtBuddyLLM');
  function disconnectPartner(id) { ns.in(`partner:${id}`).disconnectSockets(true); }
  ns.use((socket,next)=>{
    if(ns.sockets.size>=1000)return next(new Error('Server connection limit reached.'));
    const {apiKey,token}=socket.handshake.auth||{};
    if(apiKey||token){
      const p=store.authenticate(token||apiKey,!!token);
      if(!p||!partnerOrigin(p,socket.handshake.headers.origin))return next(new Error('Invalid, expired, or revoked credentials.'));
      socket.data.secret=token||apiKey;socket.data.session=!!token;socket.data.partner=p;
    }
    next();
  });
  const activeByPartner=new Map(), jobs=new Set();
  ns.on('connection',socket=>{
    const conversation=new Conversation();
    let busy=false, controller=null, authTimer;
    const send=(event,payload)=>{ if(socket.connected)socket.emit(event,payload); };
    const error=(content,code='REQUEST_FAILED',requestId)=>send('query-response-solution',{schemaVersion:2,error:true,done:true,stage:'error',content,code,requestId});
    const loginSuccess=p=>{clearTimeout(authTimer);socket.join(`partner:${p.id}`);send('login-success',{status:true,aapiKey:`${p.prefix}…`,partner:{id:p.id,name:p.name},demo:provider.demo});};
    send('ack',{content:socket.id,socketId:socket.id});
    socket.on('ack',()=>send('ack',{content:socket.id,socketId:socket.id}));
    if(socket.data.partner)loginSuccess(socket.data.partner);
    else authTimer=setTimeout(()=>{send('login-error',{status:false,content:'Authentication timed out.'});socket.disconnect(true);},10000);
    socket.on('login',payload=>{
      try{payload=decodePayload(payload);}catch(e){send('login-error',{status:false,content:e.message});return;}
      if(socket.data.partner){send('login-error',{status:false,content:'Already authenticated. Reconnect to change credentials.'});return;}
      if(!attempt(socket.handshake.address)){socket.disconnect(true);return;}
      const p=store.authenticate(payload?.apiKey);
      if(!p||!partnerOrigin(p,socket.handshake.headers.origin)){send('login-error',{status:false,content:'Invalid, expired, or revoked partner key.'});return;}
      socket.data.secret=payload.apiKey;socket.data.session=false;socket.data.partner=p;loginSuccess(p);
    });
    const authorize=()=>{
      const p=store.authenticate(socket.data.secret,socket.data.session);
      if(!p)throw new Error('Authentication required. Reconnect with an active partner key.');
      return p;
    };
    function deliverAction(kind,requestId){
      const result=reveal(conversation.flow,kind,requestId);
      if(result.payload.content){
        conversation.rememberReveal(result.payload.data);
        conversation.messages.push({role:'user',content:`Requested ${kind}.`},{role:'assistant',content:result.payload.content});
        const steps=result.payload.data.steps||(result.payload.data.step?[result.payload.data.step]:[]);
        conversation.steps.set(requestId,steps.map(s=>({step_number:String(s.number),step_title:s.title})));
        if(conversation.steps.size>200)conversation.steps.delete([...conversation.steps.keys()][1]);
      }
      send(result.event,result.payload);send('query-response-solution',result.payload);
      send('processing-status',{status:'Complete',requestId,kind,questionId:conversation.flow.questionId});
    }
    async function run(kind, payload) {
      let requestId,p,usage={},timer,accepted=false;
      try {
        p=authorize();
        payload=decodePayload(payload);
        if(busy){error('A solution is already in progress.','BUSY');return;}
        if((activeByPartner.get(p.id)||0)>=5){error('This partner already has five requests in progress.','BUSY');return;}
        let content,followup,profile=conversation.profile;
        const isAction=['next-step','all-steps','final'].includes(kind);
        if(isAction){
          const {questionId}=actionSchema.parse(payload);
          if(!conversation.flow||conversation.flow.questionId!==questionId)throw new Error('Question not found on this connection. Send the question again after reconnecting.');
          if(!conversation.flow.understanding.canProceed)throw new Error('Clarify the question before requesting solution steps.');
          if(conversation.flow.plan){const id=randomUUID();send('processing-status',{status:'Processing...',requestId:id,kind,questionId});deliverAction(kind,id);return;}
          content='The student has chosen to see the solution. Prepare the solution plan for the original question, using all clarifications above. Keep the language of the understanding card.';
        }
        if(kind==='text'){const parsed=textSchema.parse(payload);content=parsed.textQuestion;profile=parsed.profile||{};}
        if(kind==='image'||kind==='extract'){const parsed=imageSchema.parse(payload);content=imageContent(parsed);profile=parsed.profile||{};}
        if(kind==='common')content=`Suggest three questions about this solution step:\n${stepSchema.parse(payload).step}`;
        if(kind==='followup'){
          const parsed=followupSchema.parse(payload);const items=Array.isArray(parsed)?parsed:[parsed];
          followup=items.map(item=>{
            if(!item.step_number)return {};
            if(item.answer_id){
              const saved=conversation.steps.get(item.answer_id)?.find(s=>String(s.step_number)===String(item.step_number));
              if(!saved)throw new Error('That solution step is no longer available. Ask a general follow-up instead.');
              return saved;
            }
            return {step_number:item.step_number,step_title:item.step_title||''};
          });
          profile={...profile,...items.at(-1).profile};
          content=items.map((v,i)=>`Solution step: ${followup[i].step_number?`Step ${followup[i].step_number}: ${followup[i].step_title}\n`:''}${v.step}\nStudent question: ${v.question}`).join('\n\n');
        }
        if(!provider.ready){error('The service needs an OpenAI API key. Contact your administrator.','NOT_CONFIGURED');return;}
        requestId=store.reserve(p,kind);busy=true;accepted=true;activeByPartner.set(p.id,(activeByPartner.get(p.id)||0)+1);
        controller=new AbortController();timer=setTimeout(()=>controller?.abort(),requestTimeout);
        send('processing-status',{status:'Processing...',requestId,kind});
        if(kind==='followup'){
          const items=Array.isArray(payload)?payload:[payload];send('followup-query-question',{question:items.map(v=>v.question).join('\n'),requestId});
        }
        const addUsage=value=>{usage.input_tokens=(usage.input_tokens||0)+(value?.input_tokens||0);usage.output_tokens=(usage.output_tokens||0)+(value?.output_tokens||0);};
        if((kind==='followup'||kind==='common')&&conversation.needsSummary()){
          send('processing-status',{status:'Summarizing earlier follow-ups...',requestId,kind});
          let summary='';
          for await(const event of provider.stream(conversation.summaryInput(),{signal:controller.signal,mode:'summary',profile})){
            authorize();if(controller.signal.aborted)throw new Error('Request cancelled.');
            if(event.usage)addUsage(event.usage);if(event.delta)summary+=event.delta;
            if(summary.length>24000)throw new Error('Conversation summary exceeded the limit.');
          }
          if(!summary.trim())throw new Error('Could not summarize the conversation. Please try again.');
          conversation.compact(summary);
        }
        const isNew=kind==='text'||kind==='image'||kind==='extract';
        const input=[...(isNew?[]:conversation.context()),{role:'user',content}];
        const clarifying=kind==='followup'&&conversation.flow&&!conversation.flow.understanding.canProceed;
        const guidedMode=kind==='text'||kind==='image'||clarifying?'understanding':isAction?'plan':null;
        let answer='';
        for await(const event of provider.stream(input,{signal:controller.signal,common:kind==='common',mode:guidedMode||(kind==='extract'?'extract':'solve'),followup:guidedMode?undefined:followup,profile})){
          if(controller.signal.aborted)throw new Error('Request cancelled.');
          authorize();
          if(event.usage)addUsage(event.usage);
          if(event.delta){
            answer+=event.delta;
            if(answer.length>(kind==='extract'?24000:100000))throw new Error('Response exceeded the output limit.');
            if(socket.conn.transport.writable===false && socket.conn.writeBuffer.length>200)throw new Error('Connection too slow.');
            if(kind!=='common'&&kind!=='extract'&&!guidedMode)send('query-update-solution',{chunk:event.delta,requestId,kind,stage:'followup'});
          }
        }
        if(!answer.trim())throw new Error('The model returned an empty answer.');
        if(guidedMode==='understanding'){
          const data=parseGuided(answer,'understanding');
          if(!clarifying)conversation.reset();conversation.profile=profile;
          const rendered=`**${data.title}**\n\n${data.content}`;
          conversation.messages.push({role:'user',content},{role:'assistant',content:rendered});
          conversation.flow={questionId:requestId,understanding:data,plan:null,revealed:0};
          const result={schemaVersion:2,error:false,done:true,requestId,questionId:requestId,kind,stage:'understanding',content:rendered,data};
          store.finish(requestId,'completed',usage);
          send('query-understanding',result);send('query-update-solution',{chunk:rendered,requestId,questionId:requestId,kind,stage:'understanding'});send('query-response-solution',result);
          send('processing-status',{status:'Complete',requestId,kind});return;
        }
        if(guidedMode==='plan'){
          conversation.flow.plan=parseGuided(answer,'plan');
          store.finish(requestId,'completed',usage);deliverAction(kind,requestId);return;
        }
        if(kind==='common'){
          let questions;
          try{questions=JSON.parse(answer);}catch{throw new Error('Could not generate suggested questions. Please try again.');}
          if(!Array.isArray(questions)||questions.length!==3||questions.some(q=>typeof q!=='string'||q.length>1000))throw new Error('Could not generate suggested questions. Please try again.');
          send('common-question-solution',{commonSolution:questions,requestId});
        }else if(kind==='extract'){
          send('image-extraction-result',{content:answer,requestId});
        }else{
          if(isNew)conversation.reset();
          conversation.profile=profile;
          conversation.messages.push({role:'user',content},{role:'assistant',content:answer});
          if(kind==='followup'&&conversation.flow){conversation.flow.plan=null;conversation.flow.revealed=0;}
          conversation.steps.set(requestId,solutionSteps(answer));
          if(conversation.steps.size>200)conversation.steps.delete([...conversation.steps.keys()][1]);
          if(kind==='followup')send('followup-query-bot',{bot:answer,requestId});
        }
        store.finish(requestId,'completed',usage);
        send('query-response-solution',{error:false,content:answer,done:true,requestId,kind});
        send('processing-status',{status:'Complete',requestId,kind});
      }catch(e){
        if(requestId)store.finish(requestId,controller?.signal.aborted?'cancelled':'failed',usage);
        const content=e.name==='ZodError'?'Invalid request. Check the required fields and length limits.':
          e.status?'The AI provider could not complete this request. Check configuration, quota, or try again shortly.':
          controller?.signal.aborted?'Request stopped or timed out. You can try again.':e.message;
        error(content,'REQUEST_FAILED',requestId);
      }finally{
        clearTimeout(timer);
        if(accepted){busy=false;controller=null;const count=(activeByPartner.get(p.id)||1)-1;if(count)activeByPartner.set(p.id,count);else activeByPartner.delete(p.id);}
      }
    }
    const launch=(kind,payload)=>{const job=run(kind,payload);jobs.add(job);job.finally(()=>jobs.delete(job));};
    socket.on('text-query',p=>launch('text',p));
    socket.on('image-query',p=>launch('image',p));
    socket.on('image-extract',p=>launch('extract',p));
    socket.on('next-step-query',p=>launch('next-step',p));
    socket.on('all-steps-query',p=>launch('all-steps',p));
    socket.on('solution-query',p=>launch('final',p));
    socket.on('common-question-query',p=>launch('common',p));
    socket.on('followup-query',p=>launch('followup',p));
    socket.on('cancel-query',()=>controller?.abort());
    socket.on('reset-conversation',()=>{if(!busy)conversation.reset();});
    socket.on('disconnect',()=>{clearTimeout(authTimer);controller?.abort();conversation.reset();});
  });
  // Bound pre-auth event traffic and authenticated event floods before parsing a query.
  ns.on('connection',socket=>{
    let count=0,reset=Date.now()+60000;
    socket.use((_packet,next)=>{if(Date.now()>reset){count=0;reset=Date.now()+60000;}if(++count>120){socket.disconnect(true);return;}next();});
  });
  const dist=resolve('dist');
  app.use('/api',(_req,res)=>res.status(404).json({error:'Endpoint not found.'}));
  if(existsSync(dist)){app.use(express.static(dist));app.get('/{*path}',(_req,res)=>res.sendFile(resolve(dist,'index.html')));}
  app.use((err,_req,res,_next)=>res.status(err.status===413?413:400).json({error:err.status===413?'Request too large.':'Invalid request.'}));
  return { app,httpServer,io,close:async()=>{clearInterval(sweep);await new Promise(r=>io.close(r));await Promise.allSettled([...jobs]);} };
}
