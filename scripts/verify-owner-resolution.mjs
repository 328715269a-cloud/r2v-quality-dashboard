import fs from 'node:fs';

const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const resolverSource=source.match(/function resolveAnnotationOwner[\s\S]*?(?=\nfunction originalAnnotator)/)?.[0];
if(!resolverSource)throw new Error('resolveAnnotationOwner is missing from app.js');

const isAnnotationEvent=e=>['\u6807\u6ce8','\u6807\u6ce8\u6d3e\u5355'].includes(e?.event_name);
const normalizeName=(value='')=>String(value).trim();
const resolveAnnotationOwner=Function('isAnnotationEvent','normalizeName',`${resolverSource};return resolveAnnotationOwner;`)(isAnnotationEvent,normalizeName);
const submit='\u6807\u6ce8',assign='\u6807\u6ce8\u6d3e\u5355';
const event=(event_time,event_name,operator_name)=>({event_time,event_name,operator_name});
const scenarios=[
  ['unsubmitted reassignment keeps the first assignment',[event('2026-01-01',assign,'A'),event('2026-01-02',assign,'B')],{},'A'],
  ['the first real submitter beats assignments',[event('2026-01-01',assign,'A'),event('2026-01-02',assign,'B'),event('2026-01-03',submit,'B')],{},'B'],
  ['historical feedback keeps the first submitted owner',[event('2026-01-01',assign,'A'),event('2026-01-02',submit,'A'),event('2026-01-03',assign,'B'),event('2026-01-04',submit,'B')],{},'A'],
  ['a later quality round uses its latest submitted version',[event('2026-01-01',assign,'A'),event('2026-01-02',submit,'A'),event('2026-01-03',assign,'B'),event('2026-01-04',submit,'B')],{before:'2026-01-05',submission:'last'},'B'],
];

for(const [name,events,options,expected] of scenarios){
  const actual=resolveAnnotationOwner(events,options);
  if(actual!==expected)throw new Error(`${name}: expected ${expected}, received ${actual}`);
}

if(!source.includes('manual.manualAnnotator||tidManual.manualAnnotator||roundAnnotator||datedAnnotator'))throw new Error('manual annotator priority changed');
console.log(`Verified ${scenarios.length} annotation ownership scenarios and manual override priority.`);
