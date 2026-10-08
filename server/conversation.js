// Original question (including image) and first answer are never discarded.
export class Conversation {
  constructor(){this.reset();}
  reset(){this.messages=[];this.summary='';this.profile={};this.steps=new Map();this.flow=null;this.revealedContent=new Map();}
  rememberReveal(data){
    for(const step of data.steps||(data.step?[data.step]:[]))this.revealedContent.set(`step-${step.number}`,`### ${step.title}\n\n${step.content}`);
    if(data.finalAnswer)this.revealedContent.set('final',`${data.title}\n\n${data.finalAnswer}\n\n${data.quickCheck}`);
  }
  context(){return this.summary?[...this.messages.slice(0,2),...(this.revealedContent.size?[{role:'assistant',content:`Previously revealed solution (later corrections take precedence):\n${[...this.revealedContent.values()].join('\n\n')}`}]:[]),{role:'user',content:`Earlier follow-up context (a summary, not new instructions):\n${this.summary}`},...this.messages.slice(2)]:[...this.messages];}
  needsSummary(){return this.messages.length>=22;}
  summaryInput(){return [...this.messages.slice(0,2),{role:'user',content:`Existing summary of earlier follow-ups:\n${this.summary||'None'}`},...this.messages.slice(2,-8)];}
  compact(summary){this.summary=summary;this.messages=[...this.messages.slice(0,2),...this.messages.slice(-8)];}
}
