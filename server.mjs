import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {FileStore}=require('./backend/file-store.cjs');
const {createService,ApiError,hash}=require('./backend/service.cjs');
const root=path.dirname(fileURLToPath(import.meta.url)),port=Number(process.env.PORT||4173),host=process.env.HOST||'127.0.0.1';
const store=await new FileStore(process.env.JOURNAL_DATA_FILE||path.join(root,'.runtime','local-store.json')).init(),service=createService(store);
const assets=['index.html','styles.css','app.js','journal-core.js','sync-model.js','sync-engine.js','sync-ui.js','provider.js','config.js','service-worker.js','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','icons/apple-touch-icon.png','cloudbase-adapter.js','scriptable/拾页.js'];
const allowed=new Map(assets.map(f=>['/'+f,f]));allowed.set('/','index.html');
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.webmanifest':'application/manifest+json','.png':'image/png'};
const limits=new Map();
function json(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>850000)throw new ApiError('INVALID','请求内容过大。');}try{return text?JSON.parse(text):{};}catch{throw new ApiError('INVALID','请求格式无效。');}}
async function account(req,action,input){
  const name=String(input.username||'').trim().toLowerCase(),password=String(input.password||'');
  if(!/^[a-z0-9_.@+-]{3,100}$/.test(name)||password.length<8||password.length>128)throw new ApiError('INVALID','请输入有效账号及至少 8 位密码。');
  const ip=req.socket.remoteAddress,key=ip+'|'+name,attempt=limits.get(key)||{count:0,at:Date.now()};
  if(Date.now()-attempt.at>60000){attempt.count=0;attempt.at=Date.now();}attempt.count++;limits.set(key,attempt);if(attempt.count>15)throw new ApiError('INVALID','尝试过于频繁，请稍后再试。');
  const userId=hash(name),existing=await store.get('users',userId);
  let user=existing;
  if(action==='register'){
    if(existing)throw new ApiError('INVALID','无法注册此账号，请尝试登录。');
    const salt=crypto.randomBytes(16).toString('hex');user={ownerId:crypto.randomUUID(),username:name,salt,passwordHash:crypto.scryptSync(password,salt,64).toString('hex')};
    await store.atomic(async tx=>{if(await tx.get('users',userId))throw new ApiError('INVALID','无法注册此账号，请尝试登录。');await tx.set('users',userId,user);});
  }else if(!user||!crypto.timingSafeEqual(Buffer.from(user.passwordHash,'hex'),crypto.scryptSync(password,user.salt,64)))throw new ApiError('AUTH','账号或密码不正确。');
  const token='shiye_s_'+crypto.randomBytes(32).toString('base64url'),expiresAt=Date.now()+30*86400000;
  await store.atomic(tx=>tx.set('sessions',hash(token),{ownerId:user.ownerId,expiresAt}));
  return {ownerId:user.ownerId,username:name,token,expiresAt};
}
async function session(req){const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const x=await store.get('sessions',hash(token));if(!x||x.expiresAt<Date.now())throw new ApiError('AUTH','登录已过期，请重新登录。');return x.ownerId;}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/')){
    if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host)throw new ApiError('AUTH','来源不允许。');
    if(req.method==='POST'&&['/api/local/login','/api/local/register'].includes(url.pathname)){json(res,200,{ok:true,data:await account(req,url.pathname.endsWith('register')?'register':'login',await body(req))});return;}
    if(req.method==='POST'&&url.pathname==='/api/rpc'){const owner=await session(req),input=await body(req);json(res,200,{ok:true,data:await service.rpc(owner,input.action,input.payload)});return;}
    if(req.method==='GET'&&url.pathname==='/api/widget/today'){json(res,200,await service.today(String(req.headers.authorization||'').replace(/^Bearer\s+/i,'')));return;}
    throw new ApiError('NOT_FOUND','接口不存在。');
  }
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
  const file=allowed.get(decodeURIComponent(url.pathname));if(!file){res.writeHead(404);res.end('Not found');return;}
  const content=await readFile(path.join(root,file)),headers={'Content-Type':(types[path.extname(file)]||'application/octet-stream')+(file.endsWith('.png')?'':'; charset=utf-8'),'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'};
  if(file==='service-worker.js')headers['Service-Worker-Allowed']='/';
  res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:content);
 }catch(e){if(e.code==='ENOENT'){res.writeHead(404);res.end('Not built');return;}json(res,({AUTH:401,INVALID:400,CONFLICT:409,NOT_FOUND:404,RETRY:503}[e.code]||500),{ok:false,error:{code:e.code||'SERVER',message:e instanceof ApiError?e.message:'服务暂时不可用。',...(e.current?{current:e.current}:{})}});}
});
server.listen(port,host,()=>console.log('Local: http://'+host+':'+port+'/ (PWA + local sync test)'));
