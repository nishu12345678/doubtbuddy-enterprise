import React from 'react';
import { Lightbulb, Puzzle } from 'lucide-react';
import { MathMarkdown } from './MathMarkdown.jsx';
export function GuidedAnswer({message,onAction,onAskStep,disabled,activeQuestion}){
  const {stage,data}=message;
  if(stage==='understanding')return <><section className="understanding-card"><h2><Lightbulb size={28}/><MathMarkdown inline>{data.title}</MathMarkdown></h2><MathMarkdown>{data.content}</MathMarkdown></section>{data.canProceed&&<div className="guided-actions"><button disabled={disabled||activeQuestion!==message.questionId} onClick={()=>onAction('next-step-query',message)}>{data.nextStepLabel}</button><button disabled={disabled||activeQuestion!==message.questionId} onClick={()=>onAction('all-steps-query',message)}>{data.allStepsLabel}</button><button disabled={disabled||activeQuestion!==message.questionId} onClick={()=>onAction('solution-query',message)}>{data.solutionLabel}</button></div>}</>;
  if(stage==='step'||stage==='all-steps'){
    const steps=data.steps||(data.step?[data.step]:[]);
    return <section className="solution-card"><h2><Puzzle size={23}/><MathMarkdown inline>{data.title}</MathMarkdown></h2>{steps.map(step=><section key={step.number} className="solution-step"><div><span className="step-number">{step.number}</span><h3><MathMarkdown inline>{step.title}</MathMarkdown></h3><button className="ask-step" disabled={disabled} aria-label={`Ask about this step: ${step.number}`} onClick={()=>onAskStep({step_number:String(step.number),step_title:step.title},message)}>Ask about this step</button></div><MathMarkdown>{step.content}</MathMarkdown></section>)}{!steps.length&&<p className="muted">All steps have been shown.</p>}</section>;
  }
  return <section className="solution-card final-card"><h2><MathMarkdown inline>{data.title}</MathMarkdown></h2><MathMarkdown>{data.finalAnswer}</MathMarkdown>{data.quickCheck&&<MathMarkdown>{data.quickCheck}</MathMarkdown>}</section>;
}
