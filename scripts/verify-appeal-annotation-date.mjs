import fs from 'node:fs';

const root=new URL('../',import.meta.url);
const app=fs.readFileSync(new URL('app.js',root),'utf8');
const html=fs.readFileSync(new URL('index.html',root),'utf8');
const failures=[];
const expect=(condition,message)=>{if(!condition)failures.push(message)};

function functionSource(source,name){
  const start=source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if(start<0)return '';
  const paramsOpen=source.indexOf('(',start);
  let paramsDepth=0,paramsQuote='',paramsEscaped=false,paramsClose=-1;
  for(let i=paramsOpen;i<source.length;i++){
    const char=source[i];
    if(paramsQuote){if(paramsEscaped){paramsEscaped=false;continue}if(char==='\\'){paramsEscaped=true;continue}if(char===paramsQuote)paramsQuote='';continue}
    if(char==='\''||char==='"'||char==='`'){paramsQuote=char;continue}
    if(char==='(')paramsDepth++;
    if(char===')'&&--paramsDepth===0){paramsClose=i;break}
  }
  const open=source.indexOf('{',paramsClose);
  let depth=0,quote='',escaped=false;
  for(let i=open;i<source.length;i++){
    const char=source[i];
    if(quote){if(escaped){escaped=false;continue}if(char==='\\'){escaped=true;continue}if(char===quote)quote='';continue}
    if(char==='\''||char==='"'||char==='`'){quote=char;continue}
    if(char==='{')depth++;
    if(char==='}'&&--depth===0)return source.slice(start,i+1);
  }
  return '';
}

const ownerSource=functionSource(app,'resolveAnnotationOwner');
const submissionSource=functionSource(app,'resolveAnnotationSubmission');
expect(Boolean(ownerSource),'resolveAnnotationOwner is required');
expect(Boolean(submissionSource),'resolveAnnotationSubmission is required');

const normalizeName=(value='')=>String(value??'').trim();
const resolveAnnotationOwner=Function('normalizeName',`${ownerSource};return resolveAnnotationOwner;`)(normalizeName);
const resolveAnnotationSubmission=Function('normalizeName','resolveAnnotationOwner',`${submissionSource};return resolveAnnotationSubmission;`)(normalizeName,resolveAnnotationOwner);
const event=(event_time,event_name,operator_name)=>({event_time,event_name,operator_name});
const submit='标注',assign='标注派单';

const scenarios=[
  ['assignment alone has no annotation date',[event('2026-08-01T09:00:00+08:00',assign,'甲')],{before:'2026-08-01T12:00:00+08:00',submission:'last',annotator:'甲'},null],
  ['matched submitter uses the real submit time',[event('2026-08-01T09:00:00+08:00',submit,'甲')],{before:'2026-08-01T12:00:00+08:00',submission:'last',annotator:'甲'},'2026-08-01T09:00:00+08:00'],
  ['an unsubmitted reassignment cannot replace the submitter',[event('2026-08-01T09:00:00+08:00',submit,'甲'),event('2026-08-01T10:00:00+08:00',assign,'乙')],{before:'2026-08-01T12:00:00+08:00',submission:'last',annotator:'甲'},'2026-08-01T09:00:00+08:00'],
  ['a later real resubmission owns the later round',[event('2026-08-01T09:00:00+08:00',submit,'甲'),event('2026-08-02T10:00:00+08:00',submit,'乙')],{before:'2026-08-02T12:00:00+08:00',submission:'last',annotator:'乙'},'2026-08-02T10:00:00+08:00'],
  ['a same-day submission after quality cannot be pulled backwards',[event('2026-08-02T13:00:00+08:00',submit,'乙')],{before:'2026-08-02T12:00:00+08:00',submission:'last',annotator:'乙'},null],
  ['a manual annotator without a matching submission remains blank',[event('2026-08-01T09:00:00+08:00',submit,'甲')],{before:'2026-08-02T12:00:00+08:00',submission:'last',annotator:'乙'},null],
];
for(const [name,events,options,expected] of scenarios){
  const actual=resolveAnnotationSubmission(events,options)?.event_time||null;
  expect(actual===expected,`${name}: expected ${expected}, received ${actual}`);
}

expect(html.includes('id="appealAnnotationDateFilter"'),'Appeal center must expose an annotation-date filter');
expect(html.includes('<th>标注日期</th>'),'Appeal center must show the annotation-date heading');
expect(/annotation_date\s*:/.test(app),'Rebuilt quality Cases must persist the in-memory annotation date');
expect(functionSource(app,'populateAppealFilters').includes('appealAnnotationDateFilter'),'Annotation date must be available as a filter option');
expect(functionSource(app,'filteredAppeals').includes('appealAnnotationDateFilter'),'Annotation date filter must affect appeal rows');
expect(functionSource(app,'renderAppeals').includes('appealAnnotationDate(c)'),'Appeal rows must render the matched annotation date');
expect(functionSource(app,'exportAppeals').includes("'标注日期':appealAnnotationDate(c)"),'Appeal Excel export must include the annotation date');
expect(functionSource(app,'clearAppealFilters').includes('appealAnnotationDateFilter'),'Clear filters must reset the annotation-date filter');
expect(app.includes("annotationDate:'标注日期'")&&app.includes("'标注日期':'annotationDate'"),'Column settings must recognize the annotation-date column');
expect(!submissionSource.includes('.from(')&&!submissionSource.includes('db.'),'Annotation-date resolution must not add a database request');

if(failures.length){
  console.error(`Appeal annotation-date verification failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`Appeal annotation-date verification passed: ${scenarios.length} ownership/date scenarios plus UI, filter, export, and no-extra-query safeguards.`);
