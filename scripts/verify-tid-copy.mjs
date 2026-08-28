import fs from 'node:fs';

const root=new URL('../',import.meta.url);
const app=fs.readFileSync(new URL('app.js',root),'utf8');
const css=fs.readFileSync(new URL('styles.css',root),'utf8');
const failures=[];
const expect=(condition,message)=>{if(!condition)failures.push(message)};

function functionSource(name){
  const start=app.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if(start<0)return '';
  const open=app.indexOf('{',start);
  let depth=0,quote='',escaped=false;
  for(let i=open;i<app.length;i++){
    const char=app[i];
    if(quote){
      if(escaped){escaped=false;continue}
      if(char==='\\'){escaped=true;continue}
      if(char===quote)quote='';
      continue;
    }
    if(char==='\''||char==='"'||char==='`'){quote=char;continue}
    if(char==='{')depth++;
    if(char==='}'&&--depth===0)return app.slice(start,i+1);
  }
  return '';
}

const cell=functionSource('identityCell');
const copy=functionSource('copyTid');
const bind=functionSource('bindManualMatches');
expect(cell.includes('tid-value')&&cell.includes('tid-copy'),'TID cell must keep selectable text and a dedicated copy button');
expect(cell.includes('identity-edit-compact'),'Editable quality TIDs must keep a separate administrator edit button');
expect(/field===['"]tid['"]/.test(cell),'Only the TID branch should use the copy treatment');
expect(copy.includes('navigator.clipboard')&&copy.includes("document.execCommand('copy')"),'Copying must support Clipboard API and a compatibility fallback');
expect(copy.includes('stopPropagation'),'Copy action must never bubble into the administrator edit action');
expect(bind.includes("querySelectorAll('.tid-copy')")&&bind.includes("querySelectorAll('.identity-edit')"),'Copy and edit actions must have independent event bindings');
expect(css.includes('user-select:text')&&css.includes('.tid-copy'),'TID text must remain selectable and the copy action must be styled');

if(failures.length){
  console.error(`TID copy verification failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('TID copy verification passed: selectable text, one-click copy, fallback support, and separate admin edit are present.');
