const digits = ['०१२३४५६७८९','০১২৩৪৫৬৭৮৯','൦൧൨൩൪൫൬൭൮൯','௦௧௨௩௪௫௬௭௮௯','౦౧౨౩౪౫౬౭౮౯','೦೧೨೩೪೫೬೭೮೯','૦૧૨૩૪૫૬૭૮૯','੦੧੨੩੪੫੬੭੮੯'];
export function parseStep(text) {
  const normalized = [...text].map(c=>{for(const alphabet of digits){const i=alphabet.indexOf(c);if(i>=0)return String(i);}return c;}).join('');
  const match = /^(?:Step|चरण|कदम|ഘട്ടം|പടി|படி|దశ|ধাপ|ಹಂತ|ಹೆಜ್ಜೆ|પગલું|પગથિયું|ਪੜਾਅ|مرحلہ)\s*(\d+[a-z]?)\s*[:：.\-–—]?\s*(.*)$/iu.exec(normalized.trim());
  return match ? {step_number:match[1],step_title:match[2].trim()} : null;
}
export function solutionSteps(answer) {
  return answer.split('\n').filter(line=>/^###\s+/.test(line)).map(line=>parseStep(line.replace(/^###\s+/, '').replace(/\*\*/g,''))).filter(Boolean);
}
