import { z } from 'zod';
const short=z.string().min(1).max(16000);
export const understandingSchema=z.object({title:short,question:short,content:short,canProceed:z.boolean(),nextStepLabel:short,allStepsLabel:short,solutionLabel:short}).strict();
export const planSchema=z.object({title:short,steps:z.array(z.object({number:z.number().int().min(1),title:short,content:short}).strict()).min(1).max(30),finalTitle:short,finalAnswer:short,quickCheck:z.string().max(16000)}).strict().refine(value=>value.steps.every((s,i)=>s.number===i+1),'Step numbers must be consecutive.');
const str={type:'string'};
export const understandingFormat={type:'json_schema',name:'question_understanding',strict:true,schema:{type:'object',additionalProperties:false,properties:{title:str,question:str,content:str,canProceed:{type:'boolean'},nextStepLabel:str,allStepsLabel:str,solutionLabel:str},required:['title','question','content','canProceed','nextStepLabel','allStepsLabel','solutionLabel']}};
export const planFormat={type:'json_schema',name:'solution_plan',strict:true,schema:{type:'object',additionalProperties:false,properties:{title:str,steps:{type:'array',items:{type:'object',additionalProperties:false,properties:{number:{type:'integer'},title:str,content:str},required:['number','title','content']}},finalTitle:str,finalAnswer:str,quickCheck:str},required:['title','steps','finalTitle','finalAnswer','quickCheck']}};
export const understandingPrompt=`CURRENT OPERATION: LET'S UNDERSTAND ONLY.
This operation overrides the main tutor's full-solution response format. Return the required JSON object.
Explain what the question is asking and the underlying concept in a brief, age-appropriate paragraph. Do NOT solve it, give working, list numbered steps, or reveal the numerical/final answer yet. For a theory question introduce the idea without giving the complete explanation. The student must choose the next action first.
title is "Let's understand" in English, translated into the student's language otherwise. question is a concise restatement. content is Markdown with valid LaTeX. canProceed is false if the question needs clarification, is off-topic, is an active-exam request, or needs a supportive distress response; explain that in content and do not invent a question. Otherwise canProceed is true.
For English use nextStepLabel="Give me a Step", allStepsLabel="Give me All Steps", solutionLabel="Give me the solution". Translate these labels into the student's language. Every human-readable JSON value must follow the current student's language; keep field keys unchanged.`;
export const planPrompt=`CURRENT OPERATION: PREPARE THE REQUESTED SOLUTION AS STRUCTURED JSON.
The student has already seen the question-understanding card and has now requested help. Return the required JSON object containing a complete consistent solution plan. The application will reveal only the requested steps or final answer.
Use consecutive integer step numbers beginning at 1. Each step has a short localized title and Markdown/LaTeX content. Explain why before how, show intermediate work and units at the student's level. title means "Solution Steps"; finalTitle means "Final answer", translated as appropriate. finalAnswer must state the result and units (option letter for MCQs). quickCheck is a brief check or empty when not useful. Match the student's language for all human-readable values. No extra JSON fields.`;
export const actionSchema=z.object({questionId:z.string().uuid()});
export function parseGuided(text,kind){try{return (kind==='understanding'?understandingSchema:planSchema).parse(JSON.parse(text));}catch{throw new Error('The tutor returned an invalid structured response. Please retry.');}}
export const demoUnderstanding={title:"Let's understand",question:'Demo: solve $x^2-5x+6=0$.',content:'**Demo only.** A quadratic equation has an $x^2$ term. We will use factoring to find values that make the expression zero. Choose how you would like to continue.',canProceed:true,nextStepLabel:'Give me a Step',allStepsLabel:'Give me All Steps',solutionLabel:'Give me the solution'};
export const demoPlan={title:'Solution Steps',steps:[{number:1,title:'Identify the factors',content:'Find two numbers with product $6$ and sum $-5$: $-2$ and $-3$.'},{number:2,title:'Factor the expression',content:'$$\n(x-2)(x-3)=0\n$$'},{number:3,title:'Solve each factor',content:'Set each factor equal to zero: $x-2=0$ or $x-3=0$.'}],finalTitle:'Final answer',finalAnswer:'$$\n\\boxed{x=2 \\text{ or } x=3}\n$$',quickCheck:'Substituting either root gives zero.'};
export function reveal(flow,kind,requestId){
  const p=flow.plan;let data,stage,event,content;
  if(kind==='next-step'){
    const step=p.steps[flow.revealed];if(step)flow.revealed++;
    stage='step';event='query-step-solution';data={title:p.title,step:step||null,totalSteps:p.steps.length,hasMoreSteps:flow.revealed<p.steps.length};
    content=step?`### ${step.title}\n\n${step.content}`:'';
  }else if(kind==='all-steps'){
    flow.revealed=p.steps.length;stage='all-steps';event='query-all-steps-solution';data={title:p.title,steps:p.steps,totalSteps:p.steps.length,hasMoreSteps:false};content=p.steps.map(s=>`### ${s.title}\n\n${s.content}`).join('\n\n');
  }else{stage='final-answer';event='query-final-solution';data={title:p.finalTitle,finalAnswer:p.finalAnswer,quickCheck:p.quickCheck};content=`**${p.finalTitle}**\n\n${p.finalAnswer}${p.quickCheck?`\n\n${p.quickCheck}`:''}`;}
  return {event,payload:{schemaVersion:2,error:false,done:true,requestId,questionId:flow.questionId,kind,stage,content,data}};
}
