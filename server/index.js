import { Store } from './store.js';
import { createProvider } from './provider.js';
import { createApp } from './app.js';
const store=new Store(process.env.DATABASE_PATH||'./data/doubtbuddy.sqlite');
const provider=createProvider({apiKey:process.env.OPENAI_API_KEY,model:process.env.OPENAI_MODEL||'gpt-4.1-mini',reasoningModel:process.env.OPENAI_REASONING_MODEL??'gpt-5-mini',demo:process.env.DEMO_MODE==='true'});
const server=createApp({store,provider,adminToken:process.env.ADMIN_TOKEN,publicUrl:process.env.PUBLIC_URL||'http://localhost:5173',allowedOrigins:(process.env.ALLOWED_ORIGINS||'').split(',').filter(Boolean)});
const port=Number(process.env.PORT||3001);
server.httpServer.listen(port,'0.0.0.0',()=>console.log(`Doubtbuddy listening on port ${port}. Provider: ${provider.demo?'DEMO (fixed example)':provider.ready?'OpenAI':'not configured'}`));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await server.close();store.close();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
