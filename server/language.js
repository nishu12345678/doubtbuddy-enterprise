// A script hint is reliable for these scripts; the model still handles explicit
// language requests, transliteration and languages sharing a script.
export function languageHint(input) {
  const last=input.at(-1)?.content;
  const text=typeof last==='string'?last:Array.isArray(last)?last.filter(p=>p.type==='input_text').map(p=>p.text).join('\n'):'';
  // The actual student's question follows any quoted solution context.
  const current=text.includes('Student question:')?text.split('Student question:').at(-1):text;
  if(/[\u0d00-\u0d7f]/u.test(current))return 'The student is asking in Malayalam. Unless they explicitly request another language, write every prose word and heading in Malayalam. Use "ഘട്ടം" instead of "Step". Do not mix English, Hindi, Turkish, or other languages into Malayalam words.';
  if(/[\u0900-\u097f]/u.test(current))return 'The current question uses Devanagari. Match its language (Hindi unless the wording or profile indicates Marathi or another Devanagari language). Write all prose and headings in that language unless another language was explicitly requested. For Hindi use "चरण" instead of "Step" and avoid English prose.';
  if(/[\u0b80-\u0bff]/u.test(current))return 'Match the current Tamil question, including headings. Use "படி" instead of "Step", unless the student explicitly requests another language.';
  if(/[\u0c00-\u0c7f]/u.test(current))return 'Match the current Telugu question, including headings. Use "దశ" instead of "Step", unless the student explicitly requests another language.';
  return 'Match the language of the latest student question, not the language of previous answers. Translate every heading and closing question too. If it is English, answer entirely in English. Honor an explicit request for another language.';
}
