import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import crypto from 'node:crypto';
import {deploymentConfig} from './deployment-config.mjs';
const run=promisify(execFile),root=process.cwd();
const cli=process.env.JOURNAL_CLI_BIN;
if(!cli)throw new Error('Set JOURNAL_CLI_BIN to the official @cloudbase/cli bin/tcb path.');
const runtime=path.join(root,'.runtime');await fs.mkdir(runtime,{recursive:true});
const stateFile=path.join(runtime,'cloud-deployment.json'),secretFile=path.join(runtime,'cloudbase-server-secret.json'),tempConfig=path.join(runtime,'deploy-cloudbaserc.json');
let state={ownedFunctions:[]};try{state=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
let buildInfo={};try{buildInfo=JSON.parse(await fs.readFile('dist/build-info.json','utf8'));}catch{}
const {envId,region,appUrl,widgetUrl}=deploymentConfig({args:process.argv.slice(3),env:process.env,state,build:buildInfo});
Object.assign(state,{envId,region});
function requireBuild(){if(buildInfo.envId!==envId)throw new Error('Build the selected CloudBase environment before deployment.');}
async function cliCall(args){
 try{
  const {stdout}=await run(process.execPath,[cli,...args,'-e',envId,'-r',region,'--json'],{cwd:root,encoding:'utf8',maxBuffer:12000000,timeout:300000,windowsHide:true,env:{...process.env,CLOUDBASE_CI:'1'}});
  const clean=stdout.replace(/\u001b\[[0-9;]*m/g,'');const start=clean.indexOf('{');const end=clean.lastIndexOf('}');
  const parsed=JSON.parse(clean.slice(start,end+1));if(parsed.error)throw new Error(parsed.error.code||'CLI_ERROR');return parsed.data??parsed;
 }catch(e){
  // Never dump CLI argv, stdout or stderr: secret-bearing commands may contain credentials.
  let code='CLI_FAILED';try{const out=String(e.stdout||e.stderr||'');const parsed=JSON.parse(out.slice(out.indexOf('{'),out.lastIndexOf('}')+1));code=parsed.error?.code||code;}catch{}
  throw new Error(args.slice(0,3).join(' ')+' failed: '+code);
 }
}
async function save(){await fs.writeFile(stateFile,JSON.stringify(state,null,2));}
async function api(action,body){return cliCall(['api','tcb',action,'--body',JSON.stringify({EnvId:envId,...body})]);}
const stage=process.argv[2];
if(stage==='backends'){
 requireBuild();
 if(state.backendsAt&&!process.env.CLOUDBASE_API_KEY)throw new Error('Backends already deployed. Use a code-only update; explicit key rotation is required to replace credentials.');
 console.log('Applying the reviewed journal migration...');
 const migration=await cliCall(['db','pg','migration','up']);state.migration=migration.taskId||'applied';await save();console.log('Migration submitted/applied.');
 if(state.backendsAt&&!process.env.CLOUDBASE_API_KEY)throw new Error('Backends already deployed. Use a code-only update; explicit key rotation is required to replace credentials.');
 let apiKey=process.env.CLOUDBASE_API_KEY;try{apiKey||=JSON.parse(await fs.readFile(secretFile,'utf8')).apiKey;}catch{}
 if(!apiKey){
  const created=await cliCall(['env','apikey','create','shiye-journal-server','--type','api_key']);
  apiKey=created.ApiKey;if(!apiKey)throw new Error('API Key creation did not return a token.');
  state.apiKeyId=created.KeyId;await save();await fs.writeFile(secretFile,JSON.stringify({apiKey}),{mode:0o600});
  console.log('Server credential created; token is not printed.');
 }
 const config=JSON.parse(await fs.readFile('cloudbaserc.json','utf8'));
 if(config.envId!==envId)throw new Error('CloudBase build configuration environment mismatch.');
 config.functionRoot='dist/functions';
 for(const fn of config.functions)fn.envVariables={JOURNAL_ENV_ID:envId,CLOUDBASE_API_KEY:apiKey};
 await fs.writeFile(tempConfig,JSON.stringify(config),{mode:0o600});
 try{
  const existing=(await cliCall(['fn','list'])).Functions||[];
  for(const name of ['journal','journal-widget']){
   const found=existing.find(x=>x.FunctionName===name);
   if(found&&!state.ownedFunctions.includes(name))throw new Error('Refusing to overwrite an untracked existing function: '+name);
   console.log('Deploying '+name+'...');
   await cliCall(['fn','deploy',name,'--config-file',tempConfig,'--yes',...(found?['--force']:[])]);
   if(!state.ownedFunctions.includes(name))state.ownedFunctions.push(name);await save();console.log(name+' deployed.');
  }
  await fs.rm(secretFile,{force:true});state.backendsAt=new Date().toISOString();await save();
 }finally{await fs.rm(tempConfig,{force:true});}
}else if(stage==='inspect'){
 const config=await api('DescribeLoginConfig',{});console.log(JSON.stringify({envId,usernameLogin:config.UserNameLogin,emailLogin:config.EmailLogin}));
 const providers=await api('GetProviders',{});console.log(JSON.stringify({providers:(providers.Data||providers.Providers||[]).map(p=>({id:p.Id,type:p.ProviderType||p.Type,status:p.On||p.Status,emailDelivery:p.EmailConfig?.On}))}));
 const functions=await cliCall(['fn','list']);console.log(JSON.stringify({functions:(functions.Functions||[]).map(p=>({name:p.FunctionName,status:p.Status,type:p.Type,runtime:p.Runtime}))}));
}else if(stage==='email'){
 const current=await api('DescribeLoginConfig',{});
 if(typeof current.PhoneNumberLogin!=='boolean')throw new Error('Cannot preserve the existing phone login setting.');
 await api('ModifyLoginConfig',{PhoneNumberLogin:current.PhoneNumberLogin,EmailLogin:true,...Object.fromEntries(['UserNameLogin','AnonymousLogin'].filter(key=>typeof current[key]==='boolean').map(key=>[key,current[key]]))});
 await api('ModifyProvider',{Id:'email',ProviderType:'EMAIL',On:'TRUE',EmailConfig:{On:'TRUE'}});
 state.emailEnabledAt=new Date().toISOString();await save();console.log('Email verification and built-in email delivery enabled.');
}else if(stage==='permissions'){
 // These changes are restricted to the two new project functions and the website domain.
 if(!appUrl)throw new Error('Set JOURNAL_APP_URL or --app-url to the deployed website URL.');
 const domain=new URL(appUrl).hostname;
 const domains=await cliCall(['cors','list']);if(!domains.some(d=>d.Domain===domain))await cliCall(['cors','add',domain]);console.log('Website safe domain configured.');
}else if(stage==='route'){
 if(state.widgetUrl){console.log('Widget route already recorded: '+state.widgetUrl);}else{const result=await cliCall(['service','create','--service-path','/api/widget/today','--function','journal-widget']);state.widgetUrl=result.url;await save();console.log('Widget route created: '+state.widgetUrl);}
}else if(stage==='hosting'){
 if(!state.backendsAt||!state.widgetUrl)throw new Error('Complete backend and route stages first.');
 requireBuild();
 if(!appUrl||buildInfo.appUrl!==appUrl)throw new Error('Build with the intended HTTPS website URL first.');
 if(widgetUrl&&buildInfo.widgetApiUrl!==widgetUrl)throw new Error('Build with the intended widget URL first.');
 console.log('Publishing verified PWA files...');
 await cliCall(['hosting','deploy','dist/web','--entry','index.html','--concurrency','4']);
 const base=appUrl;
 const files=[];async function walk(dir,prefix=''){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const rel=prefix+entry.name;if(entry.isDirectory())await walk(path.join(dir,entry.name),rel+'/');else files.push(rel);}}await walk('dist/web');
 for(let i=0;i<files.length;i+=4)await Promise.all(files.slice(i,i+4).map(async file=>{const response=await fetch(base+file.split('/').map(encodeURIComponent).join('/'),{signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('HTTPS asset unavailable: '+file+' '+response.status);const remote=Buffer.from(await response.arrayBuffer()),local=await fs.readFile(path.join('dist/web',file));if(crypto.createHash('sha256').update(remote).digest('hex')!==crypto.createHash('sha256').update(local).digest('hex'))throw new Error('HTTPS asset mismatch: '+file);}));console.log('HTTPS content hashes verified: '+files.length+' files.');
 state.appUrl=appUrl;state.widgetUrl=widgetUrl||state.widgetUrl;state.hostingAt=new Date().toISOString();await save();console.log('PWA uploaded: '+state.appUrl);
}else throw new Error('Use backends, inspect, email, permissions, route or hosting.');
