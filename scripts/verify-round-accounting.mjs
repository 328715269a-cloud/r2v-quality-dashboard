import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const pick=name=>{
  const match=source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  if(!match)throw new Error(`未找到 ${name}`);
  return match[0];
};
const context={FIRST_PASS_QUALITY_START:'2026-08-01',state:{sopSettings:{enabled:true,startDate:'2026-07-23'}},day:value=>String(value||'').slice(0,10)};
vm.createContext(context);
vm.runInContext(`${pick('qualityRoundIncluded')};this.qualityRoundIncluded=qualityRoundIncluded;`,context);

const rounds=[
  {key:'A:1',tid:'A',round:1,date:'2026-07-21T10:00:00',first:true},
  {key:'A:2',tid:'A',round:2,date:'2026-07-23T10:00:00',first:false},
  {key:'A:3',tid:'A',round:3,date:'2026-07-25T10:00:00',first:false},
  {key:'B:1',tid:'B',round:1,date:'2026-07-25T11:00:00',first:true},
  {key:'B:2',tid:'B',round:2,date:'2026-07-25T12:00:00',first:false},
  {key:'C:1',tid:'C',round:1,date:'2026-08-05T10:00:00',first:true,firstValid:true},
  {key:'C:2',tid:'C',round:2,date:'2026-08-07T10:00:00',first:false,firstValid:false},
];
const included=rounds.filter(context.qualityRoundIncluded).map(r=>r.key);
const expected=['A:1','A:2','A:3','B:1','B:2','C:1'];
if(JSON.stringify(included)!==JSON.stringify(expected)){
  throw new Error(`轮次纳入错误：${JSON.stringify(included)}`);
}
context.state.sopSettings={enabled:false,startDate:''};
const legacy=rounds.filter(context.qualityRoundIncluded).map(r=>r.key);
if(JSON.stringify(legacy)!==JSON.stringify(['A:1','B:1','C:1'])){
  throw new Error(`旧口径保护错误：${JSON.stringify(legacy)}`);
}
console.log('轮次统计校验通过：8 月 1 日起仅首次有效质检结论计入，验收口径不受影响。');
