import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) { console.log('.env already exists; no settings changed.'); }
else {
  writeFileSync('.env', `OPENAI_API_KEY=\nOPENAI_MODEL=gpt-4.1-mini\nADMIN_TOKEN=${randomBytes(32).toString('hex')}\nPORT=3001\nPUBLIC_URL=http://localhost:5173\nALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:3001,http://127.0.0.1:3001\nDATABASE_PATH=./data/doubtbuddy.sqlite\nDEMO_MODE=false\n`, { mode: 0o600 });
  console.log('Created .env with a random admin token. Set OPENAI_API_KEY locally, then run npm run dev.');
}
