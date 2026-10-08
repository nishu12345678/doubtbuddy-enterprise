// One minimal billable request; prints only non-secret diagnostic metadata.
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
try {
  await client.responses.create({ model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', input: 'Return only the number 2.', max_output_tokens: 16, store: false });
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, status: error.status, code: error.code, type: error.type, param: error.param }));
  process.exitCode = 1;
}
