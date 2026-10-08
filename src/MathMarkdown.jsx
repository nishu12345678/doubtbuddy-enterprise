import React from 'react';
import Markdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import { parseStep } from '../shared/steps.js';

export function normalizeMath(text) {
  // Preserve fenced code; accept both common LaTeX delimiter conventions.
  return text.split(/(```[\s\S]*?```)/g).map((part,i)=>i%2?part:part
    .replace(/\\\[([\s\S]*?)\\\]/g,(_,body)=>`\n\n$$\n${body}\n$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g,(_,body)=>`$${body}$`)).join('');
}
function plainText(children){return React.Children.toArray(children).map(child=>typeof child==='string'||typeof child==='number'?String(child):React.isValidElement(child)?plainText(child.props.children):'').join('');}
export function MathMarkdown({ children='', onAskStep, disabled=false, inline=false }) {
  const Wrapper=inline?'span':'div';
  return <Wrapper className={inline?'math-inline':'markdown'}><Markdown remarkPlugins={[remarkGfm,remarkMath]} rehypePlugins={[[rehypeKatex,{throwOnError:false,strict:false,trust:false,maxExpand:1000}]]} components={{
    ...(inline?{p:({children})=><span>{children}</span>}:{}),
    a:({children,href})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    h3:({children})=>{const step=parseStep(plainText(children));return <div className="step-heading"><h3>{children}</h3>{step&&onAskStep&&<button className="ask-step" disabled={disabled} onClick={()=>onAskStep(step)} aria-label={`Ask about this step: ${step.step_number}`}>Ask about this step</button>}</div>;}
  }}>{normalizeMath(children)}</Markdown></Wrapper>;
}
