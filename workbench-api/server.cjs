'use strict';

const http=require('node:http');
const {DatabaseSync,backup:sqliteBackup}=require('node:sqlite');
const {randomBytes,createHash,timingSafeEqual}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {ApiError,check,object,profileInput,normalizeDelta}=require('./rules.cjs');
const API='/group-workbench-api/';
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`:JSON.stringify(value);
function equalSecret(a,b){return timingSafeEqual(Buffer.from(sha(String(a??''))),Buffer.from(sha(String(b??''))));}

function createService(options={}){
  const directory=path.resolve(options.directory||process.env.DATA_DIR||'./workbench-data');
  const groupPin=options.groupPin||process.env.GROUP_PIN,adminPin=options.adminPin||process.env.ADMIN_PIN;
  if(!groupPin||!adminPin)throw new Error('GROUP_PIN and ADMIN_PIN must be configured by the server operator.');
  const existingDatabaseOnly=options.existingDatabaseOnly??process.env.EXISTING_DATABASE_ONLY==='1';
  const skipStartupBackup=options.skipStartupBackup??process.env.SKIP_STARTUP_BACKUP==='1';
  const backupIntervalMs=Number(options.backupIntervalMs??process.env.BACKUP_INTERVAL_MS??0);
  const backupDelegated=skipStartupBackup&&backupIntervalMs===0;
  const deleteGatePath=options.importDeleteGatePath||process.env.IMPORT_DELETE_GATE_PATH||'';
  function importDeleteEnabled(){if(options.importDeleteEnabled===true)return true;if(!deleteGatePath)return false;try{return fs.statSync(deleteGatePath).isFile();}catch{return false;}}
  const dbPath=path.join(directory,'workbench.sqlite');
  if(existingDatabaseOnly){if(!fs.existsSync(dbPath)||!fs.statSync(dbPath).isFile())throw new Error('Existing workbench database is required; no database was created.');}
  else fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const db=new DatabaseSync(dbPath);
  try{
  if(existingDatabaseOnly){
    const expected={metadata:['key','value'],records:['id','kind','revision','ordinal','json'],transactions:['id','revision','payload_hash','profile','created_at','result'],sessions:['token_hash','profile','created_at','expires_at']};
    for(const [table,columns]of Object.entries(expected)){const names=db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name);if(columns.some(name=>!names.includes(name)))throw new Error('Existing workbench database schema is incomplete: '+table);}
    for(const [name,table,action]of [['immutable_records_update','records','UPDATE'],['immutable_records_delete','records','DELETE'],['immutable_transactions_update','transactions','UPDATE'],['immutable_transactions_delete','transactions','DELETE']]){const sql=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)?.sql||'';if(!sql.toUpperCase().includes(`BEFORE ${action} ON ${table.toUpperCase()}`)||!sql.includes('RAISE(ABORT'))throw new Error('Existing append-only protection is missing: '+name);}
    const revision=db.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value,createdAt=db.prepare("SELECT value FROM metadata WHERE key='createdAt'").get()?.value;
    if(!/^\d+$/.test(revision||'')||!Number.isSafeInteger(Number(revision))||!Number.isFinite(Date.parse(createdAt)))throw new Error('Existing database metadata is invalid.');
    if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal')throw new Error('Existing database must already use WAL.');
  }else{
  fs.chmodSync(dbPath,0o600);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('tasks','events','batches')),revision INTEGER NOT NULL,ordinal INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_revision ON records(revision,ordinal);
    CREATE INDEX IF NOT EXISTS records_kind ON records(kind,revision,ordinal);
    CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,payload_hash TEXT NOT NULL,profile TEXT NOT NULL,created_at TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,profile TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS immutable_records_update BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT,'records are append only'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_records_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT,'records are append only'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_transactions_update BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT,'transactions are append only'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_transactions_delete BEFORE DELETE ON transactions BEGIN SELECT RAISE(ABORT,'transactions are append only'); END;`);
  db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run('createdAt',new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run('revision','0');
  }
  db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;');
  }catch(error){db.close();throw error;}
  const getRevision=()=>Number(db.prepare('SELECT value FROM metadata WHERE key=?').get('revision').value);
  const creation=db.prepare('SELECT value FROM metadata WHERE key=?').get('createdAt').value;
  function collect(after){const out={tasks:[],events:[],batches:[]};for(const row of db.prepare('SELECT kind,json FROM records WHERE revision>? ORDER BY revision,ordinal').all(after))out[row.kind].push(JSON.parse(row.json));return out;}
  function state(){return{version:3,createdAt:creation,...collect(-1),preferences:{}};}
  function legacyState(raw){
    const deleted=new Set(raw.events.filter(event=>event.type==='task_deleted').map(event=>event.taskId));
    const tasks=raw.tasks.filter(task=>!deleted.has(task.id)),active=new Set(tasks.map(task=>task.id));
    return{...raw,tasks,events:raw.events.filter(event=>!deleted.has(event.taskId)),batches:raw.batches.filter(batch=>batch.taskIds?.some(key=>active.has(key)))};
  }
  function hasDeletedTasks(){return !!db.prepare("SELECT 1 FROM records WHERE kind='events' AND json_extract(json,'$.type')='task_deleted' LIMIT 1").get();}
  function checkPin(pin,kind){check(equalSecret(pin,kind==='admin'?adminPin:groupPin),'密码不正确','PIN_INVALID',403);}
  function authenticate(token){check(typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token),'请先登记作业身份','SESSION_REQUIRED',401);const session=db.prepare('SELECT profile,expires_at FROM sessions WHERE token_hash=?').get(sha(token));check(session&&session.expires_at>Date.now(),'作业身份已过期，请重新登记','SESSION_EXPIRED',401);return JSON.parse(session.profile);}
  const attempts=new Map();
  function login(body,key='local'){
    check(object(body),'请求格式无效');key+=body.profile?.role==='admin'?':admin':['qc','acceptance'].includes(body.profile?.role)?':group':':registration';const window=Math.floor(Date.now()/600000),record=attempts.get(key);if(record&&record.window===window)check(record.count<30,'尝试次数较多，请稍后再试','RATE_LIMITED',429);
    try{const profile=profileInput(body.profile);if(profile.role!=='annotation')checkPin(body.pin,profile.role==='admin'?'admin':'group');const token=randomBytes(32).toString('base64url'),at=Date.now();db.prepare('INSERT INTO sessions(token_hash,profile,created_at,expires_at) VALUES(?,?,?,?)').run(sha(token),JSON.stringify(profile),at,at+7*86400000);attempts.delete(key);return{token,profile,expiresAt:new Date(at+7*86400000).toISOString()};}
    catch(error){attempts.set(key,{window,count:record?.window===window?record.count+1:1});if(attempts.size>5000){for(const[k,v]of attempts)if(v.window!==window)attempts.delete(k);}throw error;}
  }
  function transact(body,profile){
    check(object(body)&&typeof body.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id),'事务 ID 无效');check(Number.isSafeInteger(body.revision)&&body.revision>=0,'版本号无效');check(object(body.delta),'缺少操作内容');
    // PIN is validated separately and never persisted in the payload hash or audit.
    const payloadHash=sha(canonical({revision:body.revision,delta:body.delta,profile}));
    const prior=db.prepare('SELECT payload_hash,result FROM transactions WHERE id=?').get(body.id);if(prior){check(prior.payload_hash===payloadHash,'同一请求 ID 不能用于其他操作','IDEMPOTENCY_MISMATCH',409);return JSON.parse(prior.result);}
    db.exec('BEGIN IMMEDIATE');
    try{
      const concurrent=db.prepare('SELECT payload_hash,result FROM transactions WHERE id=?').get(body.id);if(concurrent){check(concurrent.payload_hash===payloadHash,'同一请求 ID 不能用于其他操作','IDEMPOTENCY_MISMATCH',409);db.exec('COMMIT');return JSON.parse(concurrent.result);}
      const revision=getRevision();check(body.revision===revision,'共享数据已有更新，请同步后重试','REVISION_CONFLICT',409);
      const delta=normalizeDelta(state(),body.delta,profile,{pin:body.pin,checkPin,now:new Date().toISOString(),checkDeleteEnabled:()=>check(importDeleteEnabled(),'删除功能尚未开放，请稍后重试','IMPORT_DELETE_DISABLED',503)});
      check(delta.tasks.length+delta.events.length+delta.batches.length>0,'没有需要保存的操作','EMPTY_TRANSACTION');
      const next=revision+1,result={revision:next,delta},at=new Date().toISOString();let ordinal=0;const insert=db.prepare('INSERT INTO records(id,kind,revision,ordinal,json) VALUES(?,?,?,?,?)');
      for(const kind of ['tasks','batches','events'])for(const value of delta[kind])insert.run(value.id,kind,next,ordinal++,JSON.stringify(value));
      db.prepare('INSERT INTO transactions(id,revision,payload_hash,profile,created_at,result) VALUES(?,?,?,?,?,?)').run(body.id,next,payloadHash,JSON.stringify(profile),at,JSON.stringify(result));
      db.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(next),'revision');db.exec('COMMIT');return result;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function exportBackup(){
    db.exec('BEGIN');try{const revision=getRevision(),value={format:'r2v-workbench-shared-backup',version:1,exportedAt:new Date().toISOString(),revision,state:state(),transactions:db.prepare('SELECT id,revision,profile,created_at,result FROM transactions ORDER BY revision').all().map(row=>({id:row.id,revision:row.revision,profile:JSON.parse(row.profile),createdAt:row.created_at,result:JSON.parse(row.result)}))};db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}
  }
  async function onlineBackup(destination){const file=path.resolve(destination);check(file!==dbPath&&!fs.existsSync(file),'备份目标必须为新文件');await sqliteBackup(db,file);fs.chmodSync(file,0o600);const verify=new DatabaseSync(file);try{verify.exec('PRAGMA journal_mode=DELETE');check(verify.prepare('PRAGMA integrity_check').get().integrity_check==='ok','备份完整性校验失败');return{file,revision:Number(verify.prepare("SELECT value FROM metadata WHERE key='revision'").get().value)};}finally{verify.close();}}
  let backupActive=false;const backupState={lastSucceededAt:null,lastRevision:null,lastError:null};
  async function rollingBackup(){if(backupActive)return;backupActive=true;try{const folder=path.join(directory,'backups');fs.mkdirSync(folder,{recursive:true,mode:0o700});const stamp=new Date().toISOString().replace(/[:.]/g,'-'),target=path.join(folder,`workbench-${stamp}.sqlite`);const result=await onlineBackup(target);backupState.lastSucceededAt=new Date().toISOString();backupState.lastRevision=result.revision;backupState.lastError=null;const files=fs.readdirSync(folder).filter(name=>/^workbench-\d{4}-\d{2}-\d{2}T[0-9Z-]+\.sqlite$/.test(name)).sort().reverse();for(const name of files.slice(0).filter((name,index)=>index>=336)){const candidate=path.join(folder,name);if(fs.lstatSync(candidate).isFile()&&!fs.lstatSync(candidate).isSymbolicLink())fs.unlinkSync(candidate);}}catch(error){backupState.lastError=error.message;process.stderr.write(JSON.stringify({event:'workbench_backup_failed',message:error.message})+'\n');}finally{backupActive=false;}}
  const allowedOrigins=new Set(options.allowedOrigins||String(process.env.ALLOWED_ORIGINS||'https://quality.shangyidada.site').split(',').map(x=>x.trim()).filter(Boolean));
  function respond(response,status,value){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));}
  async function bodyOf(request){let length=0,chunks=[];for await(const chunk of request){length+=chunk.length;check(length<=6*1024*1024,'请求过大，请分批处理','TOO_LARGE',413);chunks.push(chunk);}check(/^application\/json(?:;|$)/i.test(String(request.headers['content-type']||'')),'需要 JSON 请求','INVALID_CONTENT_TYPE',415);try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'INVALID_JSON','请求格式无效');}}
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://localhost');check(url.pathname.startsWith(API),'未找到接口','NOT_FOUND',404);const endpoint=url.pathname.slice(API.length);
      if(request.headers.origin)check(allowedOrigins.has(request.headers.origin),'请求来源不允许','ORIGIN_FORBIDDEN',403);
      if(endpoint==='health'&&request.method==='GET')return respond(response,200,{ok:true,service:'r2v-group-workbench',schemaVersion:1,revision:getRevision(),capabilities:{importDelete:{supported:true,enabled:importDeleteEnabled()}},backup:{...backupState,mode:backupDelegated?'delegated':'local',delegated:backupDelegated}});
      if(endpoint==='session'&&request.method==='POST'){const source=String(request.headers['x-forwarded-for']||request.socket.remoteAddress||'unknown').split(',').at(-1).trim();return respond(response,200,login(await bodyOf(request),source));}
      const token=request.headers['x-workbench-session'],profile=authenticate(token);
      if(endpoint==='session'&&request.method==='GET')return respond(response,200,{profile});
      if(endpoint==='session'&&request.method==='DELETE'){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));return respond(response,200,{ok:true});}
      if(endpoint==='state'&&request.method==='GET'){const after=url.searchParams.get('after');db.exec('BEGIN');try{const revision=getRevision();if(after!==null)check(/^\d+$/.test(after)&&Number.isSafeInteger(Number(after))&&Number(after)<=revision,'增量版本无效','INVALID_REVISION',400);const legacy=request.headers['x-workbench-client']!=='import-delete-v1'&&hasDeletedTasks();const result=legacy?{revision,state:legacyState(state())}:after===null?{revision,state:state()}:{revision,delta:collect(Number(after))};db.exec('COMMIT');return respond(response,200,result);}catch(error){db.exec('ROLLBACK');throw error;}}
      if(endpoint==='transactions'&&request.method==='POST')return respond(response,200,transact(await bodyOf(request),profile));
      if(endpoint==='backup'&&request.method==='GET')return respond(response,200,exportBackup());
      throw new ApiError(404,'NOT_FOUND','未找到接口');
    }catch(error){if(!response.headersSent){if(!(error instanceof ApiError))process.stderr.write(JSON.stringify({event:'workbench_request_error',message:String(error.message).slice(0,500)})+'\n');respond(response,error.status||500,{error:{code:error.code||'INTERNAL_ERROR',message:error instanceof ApiError?error.message:'保存服务暂时不可用，填写内容请保留后重试'}});}else response.end();}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  let timer=null;if(backupIntervalMs>0){timer=setInterval(rollingBackup,backupIntervalMs);timer.unref();}
  async function close(){if(timer)clearInterval(timer);if(server.listening)await new Promise(resolve=>server.close(resolve));while(backupActive)await new Promise(resolve=>setTimeout(resolve,20));db.close();}
  return{server,dbPath,db,state,getRevision,login,authenticate,transact,exportBackup,onlineBackup,rollingBackup,close,skipStartupBackup,importDeleteEnabled};
}
if(require.main===module){
  const service=createService({backupIntervalMs:Number(process.env.BACKUP_INTERVAL_MS||3600000)});const port=Number(process.env.PORT||3014);service.server.listen(port,process.env.HOST||'0.0.0.0',()=>{process.stdout.write(JSON.stringify({event:'workbench_listening',port})+'\n');if(!service.skipStartupBackup)service.rollingBackup();});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await service.close();process.exit(0);});
}
module.exports={createService,API,canonical};
