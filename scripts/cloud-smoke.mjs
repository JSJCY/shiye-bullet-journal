import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {deploymentConfig} from './deployment-config.mjs';
const require=createRequire(import.meta.url),Core=require('../journal-core.js'),Model=require('../sync-model.js');
const run=promisify(execFile);
let deployment={};try{deployment=JSON.parse(await fs.readFile('.runtime/cloud-deployment.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const {envId:env}=deploymentConfig({args:process.argv.slice(3),env:process.env,state:deployment});
const base='https://'+env+'.api.tcloudbasegateway.com';
await fs.mkdir('.runtime',{recursive:true});
const cli=process.env.JOURNAL_CLI_BIN,fixtureFile='.runtime/cloud-qa.json',reportFile='.runtime/cloud-smoke-report.json';
const stage=process.argv[2];
if(!cli||!['create','smoke','cleanup'].includes(stage))throw new Error('Set JOURNAL_CLI_BIN and use create, smoke or cleanup.');
async function call(args){
 try{
  const {stdout}=await run(process.execPath,[cli,...args,'-e',env,'--json'],{encoding:'utf8',env:{...process.env,CLOUDBASE_CI:'1'},timeout:60000,windowsHide:true});
  const p=JSON.parse(stdout.slice(stdout.indexOf('{'),stdout.lastIndexOf('}')+1));if(p.error)throw new Error(p.error.code);return p.data||p;
 }catch(e){
  // Do not expose credential-bearing arguments or CLI output in errors.
  let code=e.message==='CLI_ERROR'?'CLI_ERROR':'CLI_FAILED';
  try{const out=String(e.stdout||'');code=JSON.parse(out.slice(out.indexOf('{'),out.lastIndexOf('}')+1)).error?.code||code;}catch{}
  throw new Error(args.slice(0,2).join(' ')+' failed: '+code);
 }
}
async function saveUsers(users){await fs.writeFile(fixtureFile,JSON.stringify(users),{mode:0o600});}
let users;try{users=JSON.parse(await fs.readFile(fixtureFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(users?.some(u=>u.envId!==env))throw new Error('Temporary account environment mismatch.');
if(stage==='create'){
 if(!users){
  const suffix=crypto.randomBytes(4).toString('hex');
  users=['a','b'].map(letter=>({username:'shiye-qa-'+suffix+'-'+letter,uid:'shiye_qa_'+suffix+'_'+letter,envId:env,password:'Qa!'+crypto.randomBytes(18).toString('base64url'),created:false}));
  await saveUsers(users);
 }
 for(const u of users){
  if(u.created)continue;
  await call(['user','create',u.username,'--uid',u.uid,'--password',u.password,'--type','externalUser','--description','Temporary authorized deployment verification; no personal notes']);
  u.created=true;await saveUsers(users);
 }
 console.log('Two isolated deployment test accounts prepared; no emails sent.');
}else if(stage==='cleanup'){
 if(!users){console.log('No temporary test fixture remains.');process.exit(0);}
 const created=users.filter(u=>u.created);
 if(created.some(u=>!/^shiye_qa_[a-f0-9]{8}_[ab]$/.test(u.uid)))throw new Error('Refusing cleanup of an unexpected identity.');
 if(created.length){
  const quoted=created.map(u=>"'"+u.uid+"'").join(',');
  await call(['api','tcb','ExecutePGSql','--body',JSON.stringify({EnvId:env,Sql:'DELETE FROM public.shiye_documents WHERE owner_id IN ('+quoted+')'})]);
  for(const u of created){await call(['user','delete',u.uid]);u.created=false;u.deleted=true;await saveUsers(users);}
  const rows=await call(['api','tcb','ExecutePGSql','--body',JSON.stringify({EnvId:env,Sql:'SELECT COUNT(*) AS count FROM public.shiye_documents WHERE owner_id IN ('+quoted+')'})]);
  if(rows.Rows?.[0]!==JSON.stringify(['0']))throw new Error('Test document cleanup is incomplete.');
  console.log('Test document count after cleanup: 0.');
  for(const u of created){
   const response=await fetch(base+'/auth/v1/signin',{method:'POST',headers:{'Content-Type':'application/json','X-Device-Id':'shiye-qa-deleted-check'},body:JSON.stringify({username:u.username,password:u.password}),signal:AbortSignal.timeout(20000)});
   const result=await response.json();if(result.access_token||![400,401,404].includes(response.status))throw new Error('Deleted account rejection not confirmed: '+response.status);
  }
  let report={};try{report=JSON.parse(await fs.readFile(reportFile,'utf8'));}catch{}
  report.cleanedAt=new Date().toISOString();report.deletedAccountsRejected=true;report.testDocumentsRemaining=0;await fs.writeFile(reportFile,JSON.stringify(report,null,2));
  console.log('Both removed test accounts reject normal login.');
 }
 await fs.rm(fixtureFile);
 console.log('Only agent-created test accounts and their documents removed; temporary credentials deleted.');
}else{
 if(!users||users.length!==2||users.some(u=>!u.created))throw new Error('Create both isolated test accounts first.');
 const checks=[];const mark=name=>{checks.push(name);console.log('PASS '+name);};
 async function login(u,device){
  const response=await fetch(base+'/auth/v1/signin',{method:'POST',headers:{'Content-Type':'application/json','X-Device-Id':device},body:JSON.stringify({username:u.username,password:u.password}),signal:AbortSignal.timeout(20000)});
  const r=await response.json();if(!r.access_token)throw new Error('Login failed '+response.status+' '+(r.error_description||r.error||'missing token'));
  return r.access_token;
 }
 async function invoke(token,action,payload={}){
  const response=await fetch(base+'/v1/functions/journal',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action,payload}),signal:AbortSignal.timeout(30000)});
  let r=await response.json();for(let i=0;i<3&&typeof r==='string';i++)r=JSON.parse(r);
  if(r.result!==undefined)r=typeof r.result==='string'?JSON.parse(r.result):r.result;
  if(!r.ok){const e=new Error('RPC '+action+' failed '+response.status+' '+(r.error?.message||r.message||r.code||'unknown response')+' keys='+Object.keys(r).join(','));e.code=r.error?.code||r.code;throw e;}
  return r.data;
 }
 let widgetTokenId,pc;
 try{
  pc=await login(users[0],'shiye-qa-pc');const phone=await login(users[0],'shiye-qa-phone'),other=await login(users[1],'shiye-qa-other');mark('login');
  const me=await invoke(pc,'me');if(me.ownerId!==users[0].uid)throw new Error('Unexpected fixture owner.');mark('trustedOwner');
  const entry=Core.makeEntry({type:'task',text:'Cloud deployment QA task',location:'daily',date:Core.getToday()});
  const operation=Model.diff([], [entry], 'PC')[0];
  const first=await invoke(pc,'apply',{operation,expectedOwner:me.ownerId});const retry=await invoke(pc,'apply',{operation,expectedOwner:me.ownerId});
  if(first.version!==retry.version)throw new Error('Duplicate operation was applied twice.');mark('idempotency');
  const pulled=await invoke(phone,'pull',{cursor:0,expectedOwner:me.ownerId});const group=pulled.groups.find(g=>g.key===operation.key);
  if(!group||group.entries[0].text!==entry.text)throw new Error('Other session did not receive the task.');mark('crossSessionCreate');
  const completed=Core.changeTask(group.entries,entry.id,'complete');
  await invoke(phone,'apply',{operation:Model.diff(group.entries,completed,'iPhone')[0],expectedOwner:me.ownerId});
  const after=await invoke(pc,'pull',{cursor:pulled.cursor,expectedOwner:me.ownerId});
  const active=Core.activeTasks(after.groups.find(g=>g.key===operation.key)?.entries||[])[0];
  if(active?.taskState!=='completed')throw new Error('Completion did not sync.');mark('completion');
  if(active.completedAt!==Core.activeTasks(completed)[0].completedAt||!active.completedAt)throw new Error('Completion time changed across sessions.');mark('completionTime');
  try{await invoke(pc,'apply',{operation:{...operation,opId:Model.uid()},expectedOwner:me.ownerId});throw new Error('Stale operation accepted.');}catch(e){if(e.code!=='CONFLICT')throw e;}mark('conflict');
  if((await invoke(other,'pull')).groups.length)throw new Error('Account isolation failed.');mark('accountIsolation');
  try{await invoke(other,'pull',{expectedOwner:me.ownerId});throw new Error('Spoofed owner accepted.');}catch(e){if(e.code!=='AUTH')throw e;}mark('ownerSpoofRejected');
  const {token,id}=await invoke(pc,'createToken',{expectedOwner:me.ownerId,label:'deployment QA'});widgetTokenId=id;
  const url=JSON.parse(await fs.readFile('.runtime/cloud-deployment.json','utf8')).widgetUrl;
  const widget=await fetch(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
  const data=await widget.json();if(widget.status!==200||data.completed<1)throw new Error('Widget read failed '+widget.status);mark('widgetRead');
  const post=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});if(post.status!==405)throw new Error('Widget method boundary failed '+post.status);mark('readOnly');
  const unauthorized=await fetch(base+'/v1/functions/journal',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action:'pull'}),signal:AbortSignal.timeout(20000)});
  if(![401,403].includes(unauthorized.status))throw new Error('Widget token accepted by sync endpoint '+unauthorized.status);mark('separateCredential');
  await invoke(pc,'revokeToken',{id,expectedOwner:me.ownerId});widgetTokenId=null;
  const revoked=await fetch(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});if(revoked.status!==401)throw new Error('Widget revoke failed '+revoked.status);mark('revoke');
  await fs.writeFile(reportFile,JSON.stringify({at:new Date().toISOString(),envId:env,passed:true,checks},null,2));
 }catch(e){
  if(pc&&widgetTokenId)try{await invoke(pc,'revokeToken',{id:widgetTokenId,expectedOwner:users[0].uid});}catch{}
  await fs.writeFile(reportFile,JSON.stringify({at:new Date().toISOString(),envId:env,passed:false,checks,failure:e.message},null,2));
  console.error(e.message);process.exitCode=1;
 }
}
