import cloudbase from '@cloudbase/js-sdk';
class CloudBaseProvider{
 constructor(config){
  this.mode='cloud';this.config=config;this.namespace='cloud:'+config.cloudbase.envId;
  this.app=cloudbase.init({env:config.cloudbase.envId,region:config.cloudbase.region||'ap-shanghai'});this.auth=this.app.auth({persistence:'local'});this.challenge=null;this.identityKey='shiye.cloud-identity:'+config.cloudbase.envId;
 }
 check(r){if(r?.error){const e=new Error(r.error.message||'登录暂时不可用。');e.code='AUTH';throw e;}return r?.data||{};}
 async identity(){const user=await this.auth.getCurrentUser(),me=await this.rpc('me');const identity={...me,username:user?.email||user?.username||user?.name||'我的账号'};try{localStorage.setItem(this.identityKey,JSON.stringify(identity));}catch{}return identity;}
 async resume(){try{const saved=JSON.parse(localStorage.getItem(this.identityKey));if(saved?.ownerId&&saved?.metaId)return saved;}catch{}const user=await this.auth.getCurrentUser();return user?this.identity():null;}
 async login(identifier,password,register=false){
  if(register){
   if(!identifier.includes('@'))throw new Error('云端注册请使用邮箱；已有用户名可以直接登录。');
   const data=this.check(await this.auth.signUp({email:identifier,password}));
   if(data.verifyOtp){this.challenge={kind:'signup',verify:data.verifyOtp};return {verification:true};}
  }else this.check(await this.auth.signInWithPassword({...identifier.includes('@')?{email:identifier}:{username:identifier},password}));
  return this.identity();
 }
 async otp(email){const data=this.check(await this.auth.signInWithOtp({email,options:{shouldCreateUser:true}}));if(!data.verifyOtp)throw new Error('验证码入口未启用，请检查云端身份认证配置。');this.challenge={kind:'otp',verify:data.verifyOtp};return {verification:true};}
 async reset(email){const data=this.check(await this.auth.resetPasswordForEmail(email));if(!data.updateUser)throw new Error('密码重置入口未启用，请检查云端身份认证配置。');this.challenge={kind:'reset',verify:data.updateUser};return {verification:true};}
 async verify(token,password){if(!this.challenge)throw new Error('请先获取验证码。');const c=this.challenge;this.check(await c.verify(c.kind==='reset'?{nonce:token,password}:{token}));this.challenge=null;return this.identity();}
 async logout(){this.check(await this.auth.signOut());try{localStorage.removeItem(this.identityKey);}catch{}}
 async rpc(action,payload={}){
  const result=await this.app.callFunction({name:this.config.cloudbase.functionName||'journal',data:{action,payload}});
  const value=typeof result.result==='string'?JSON.parse(result.result):result.result;
  return window.JournalProviders.unpack(value);
 }
 subscribe(callback,metaId){
  if(!metaId)return {close(){}};
  // PostgreSQL realtime availability varies; visibility/focus/online and 30s polling perform authoritative pulls.
  return {close(){}};
 }
}
window.CloudBaseProvider=CloudBaseProvider;
