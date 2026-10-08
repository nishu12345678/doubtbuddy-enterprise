import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { demoUnderstanding, demoPlan } from '../server/guided.js';
import { createProvider } from '../server/provider.js';
const store=new Store(':memory:');
const adminToken='browser-test-only-token-32-characters-long';
const demoProvider=createProvider({demo:true});
let receivedImageInstructions;
let receivedFollowup;
const provider={ready:true,demo:true,async *stream(input,options){
  if(Array.isArray(input.at(-1).content))receivedImageInstructions=input.at(-1).content[0].text;
  if(options.followup)receivedFollowup=options.followup;
  if(input.at(-1).content==='Render math regression fixture'){
    const fixture=String.raw`Inline \(\frac{1}{2}\) and a matrix:

\[\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}\]

$$
\int_0^1 x^2\,dx=\frac{1}{3}
$$

<img src="x" onerror="window.injected=true">

[unsafe](javascript:window.injected=true)

| Quantity | Value |
| --- | --- |
| Root | $\sqrt{2}$ |
`;yield {delta:JSON.stringify({...demoUnderstanding,content:fixture})};return;
  }
  if(options.mode==='plan'){
    yield {delta:JSON.stringify({...demoPlan,steps:demoPlan.steps.map(step=>step.number===2?{...step,title:String.raw`Find \( \sin \theta \) and \( \cos \theta \)`}:step.number===3?{...step,title:String.raw`Find $\cos \phi$ and $\sin \phi$`}:step)})};return;
  }
  yield* demoProvider.stream(input,options);
}};
const server=createApp({store,provider,adminToken,publicUrl:'http://127.0.0.1:3109'});
await new Promise(r=>server.httpServer.listen(3109,'127.0.0.1',r));
let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1050}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
  await page.goto('http://127.0.0.1:3109/admin');
  await page.getByLabel('Administrator token').fill(adminToken);await page.getByRole('button',{name:'Open partner console'}).click();
  await page.getByLabel('Partner name').fill('Infinity Learn');await page.getByRole('button',{name:'Generate partner key'}).click();
  await page.getByText('Access key created').waitFor();const url=await page.getByRole('link',{name:'Open learning studio',exact:true}).getAttribute('href');
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/admin.png',fullPage:true});
  await page.goto(url);await page.getByText('Demo mode: responses show a fixed example. Live AI is not enabled.').waitFor();
  assert.ok(!page.url().includes('key='));
  await page.screenshot({path:'test-results/studio.png',fullPage:true});
  await page.getByRole('button',{name:/Make sense of quadratics/}).click();await page.getByRole('button',{name:'Solve my doubt'}).click();
  await page.getByRole('button',{name:'Explore related questions'}).waitFor();assert.ok(await page.locator('.katex').count()>0);assert.equal(await page.locator('.katex-error').count(),0);
  await page.getByRole('button',{name:'Give me a Step',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Ask about this step: 2',exact:true}).count(),0);
  await page.screenshot({path:'test-results/understanding.png',fullPage:true});
  await page.getByRole('button',{name:'Give me All Steps',exact:true}).click();
  await page.getByRole('button',{name:'Ask about this step: 2',exact:true}).waitFor();
  assert.equal(await page.locator('.solution-step h3 .katex').count(),4);
  assert.equal(await page.locator('.solution-step h3 .katex-error').count(),0);
  await page.screenshot({path:'test-results/solution.png',fullPage:true});
  await page.getByRole('button',{name:'Ask about this step: 2',exact:true}).click();
  assert.equal(await page.locator('.selected-step .katex').count(),2);
  await page.getByRole('textbox',{name:'Your question'}).fill('Why do these two numbers work?');await page.getByRole('button',{name:'Solve my doubt'}).click();await page.getByRole('button',{name:'Explore related questions'}).waitFor();
  assert.equal(receivedFollowup[0].step_number,'2');assert.equal(receivedFollowup[0].step_title,String.raw`Find \( \sin \theta \) and \( \cos \theta \)`);
  await page.getByRole('button',{name:'Explore related questions'}).click();await page.getByRole('button',{name:'How can I check these roots?'}).click();
  await page.getByRole('button',{name:'Explore related questions'}).waitFor();assert.equal(await page.locator('.message.assistant').count(),4);
  await page.getByRole('button',{name:'New question',exact:true}).click();await page.getByRole('button',{name:'Upload an image',exact:true}).click();
  await page.locator('input[type=file]').setInputFiles({name:'question.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=','base64')});
  await page.getByAltText('Selected question').waitFor();await page.getByRole('textbox',{name:'Image instructions'}).fill('Solve Q4 for Class 8.');
  await page.getByRole('button',{name:'Read image before solving'}).click();await page.getByRole('textbox',{name:'Extracted question'}).waitFor();
  await page.getByRole('textbox',{name:'Extracted question'}).fill('QUESTION_TEXT: Corrected question 4');
  await page.getByRole('button',{name:'Solve my doubt'}).click();await page.getByRole('button',{name:'Explore related questions'}).waitFor();
  assert.ok(receivedImageInstructions.startsWith('Solve Q4 for Class 8.'));assert.ok(receivedImageInstructions.includes('Corrected question 4'));await page.getByText('Solve Q4 for Class 8.',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.getByRole('button',{name:'New question',exact:true}).click();await page.getByRole('button',{name:'Type a question',exact:true}).click();
  await page.getByRole('textbox',{name:'Your question'}).fill('Render math regression fixture');await page.getByRole('button',{name:'Solve my doubt'}).click();await page.getByRole('button',{name:'Explore related questions'}).waitFor();
  assert.ok(await page.locator('.katex').count()>=4);assert.equal(await page.locator('.katex-error').count(),0);
  assert.equal(await page.locator('.markdown table').count(),1);assert.equal(await page.locator('.markdown img').count(),0);assert.equal(await page.evaluate(()=>!!window.injected),false);
  assert.equal(await page.locator('a[href^="javascript:"]').count(),0);
  await page.screenshot({path:'test-results/math-rendering.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('Browser checks passed: admin creation, URL login, text streaming, KaTeX fractions/matrices/integrals, suggestions, follow-up, image upload, mobile layout, HTML/script sanitization, no browser errors.');
}finally{await browser?.close();await server.close();store.close();}
