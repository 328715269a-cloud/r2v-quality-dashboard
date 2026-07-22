import fs from 'node:fs';

const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const required=[
  "p2Cases=state.cases.filter(c=>c.kind==='quality'&&!c.invalid&&c.severity==='P2'",
  'p2Cases.forEach(c=>get(c.annotator).p2++)',
  'a.p2Cases.forEach(c=>',
  'a.p2Cases.length',
  'g.p2++',
];
for(const rule of required)if(!source.includes(rule))throw new Error(`P2 reporting safeguard is missing: ${rule}`);
if(/qCases\.forEach[\s\S]{0,300}severity==='P2'/.test(source))throw new Error('P2 reporting was coupled back to quality-round accuracy cases');
console.log('Verified independent P2 reporting for overview and daily personnel statistics.');
