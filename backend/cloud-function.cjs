'use strict';
const cloudbase=require('@cloudbase/node-sdk');
const {PgStore}=require('./pg-store.cjs');
const {createService,ApiError}=require('./service.cjs');
let service;
exports.main=async(event={},context={})=>{
 try{
  const app=cloudbase.init({env:cloudbase.SYMBOL_CURRENT_ENV,context});
  const info=app.auth().getUserInfo();
  if(!info.uid||info.isAnonymous)throw new ApiError('AUTH','请使用正式账号登录。');
  service||=createService(new PgStore({envId:process.env.JOURNAL_ENV_ID,apiKey:process.env.CLOUDBASE_API_KEY}));
  return {ok:true,data:await service.rpc(info.uid,event.action,event.payload||{})};
 }catch(e){return {ok:false,error:{code:e.code||'SERVER',message:e instanceof ApiError?e.message:'服务暂时不可用，请稍后重试。',...(e.current?{current:e.current}:{})}};}
};
