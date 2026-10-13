'use strict';
const http=require('node:http');
const {createService,ApiError}=require('./service.cjs');
const {PgStore}=require('./pg-store.cjs');
function createWidgetHandler(service){
 return async(req,res)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  const path=new URL(req.url,'http://widget.local').pathname;
  if(path==='/health'&&req.method==='GET'){res.end(JSON.stringify({ok:true,service:'shiye-widget'}));return;}
  if(req.method!=='GET'){res.statusCode=405;res.setHeader('Allow','GET');res.end(JSON.stringify({error:'Read-only endpoint.'}));return;}
  if(!['/','/today','/api/widget/today'].includes(path)){res.statusCode=404;res.end(JSON.stringify({error:'Not found.'}));return;}
  try{
   const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
   res.end(JSON.stringify(await service.today(token)));
  }catch(e){res.statusCode=e.code==='AUTH'?401:e.code==='RETRY'?503:500;res.end(JSON.stringify({ok:false,error:{code:e.code||'SERVER',message:e instanceof ApiError?e.message:'服务暂时不可用，请稍后重试。'}}));}
 };
}
function start(){
 const store=new PgStore({envId:process.env.JOURNAL_ENV_ID,apiKey:process.env.CLOUDBASE_API_KEY});
 const server=http.createServer(createWidgetHandler(createService(store)));
 server.listen(Number(process.env.PORT||9000),'0.0.0.0');return server;
}
if(require.main===module)start();
module.exports={createWidgetHandler,start};
