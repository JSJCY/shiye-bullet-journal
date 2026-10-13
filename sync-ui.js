(function(root){
'use strict';
const $=s=>document.querySelector(s),escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
class SyncUI{
 constructor(engine,config,notify){this.engine=engine;this.config=config;this.notify=notify;this.account=null;this.provider=null;this.subscription=null;this.dialog=$('#sync-dialog');$('#sync-toggle').onclick=()=>this.open();this.timer=setInterval(()=>{if(this.engine.owner&&document.visibilityState==='visible')void this.engine.flush();},30000);}
 status(s=this.engine.status()){
  let label=s.error?'同步待重试':s.conflicts?'有 '+s.conflicts+' 项冲突':s.pending?'待同步 '+s.pending+' 项':s.syncing?'正在同步…':s.owner?(s.mode==='cloud'?'已同步到云端':'本地测试已同步'):'已保存在此设备';
  if(!s.online)label=s.pending?'离线 · 待同步 '+s.pending+' 项':'离线 · 已保存到此设备';
  $('#save-label').textContent=label;$('#sync-toggle').textContent=s.conflicts?'处理冲突':s.owner?(!s.online?'离线 ':'同步 ')+(s.pending||'✓'):'账号与同步';
  $('#sync-toggle').classList.toggle('has-conflicts',s.conflicts>0);
  const node=this.dialog.querySelector('[data-sync-status]');if(node)node.textContent=label+(s.error?' · '+s.error:'');
 }
 async init(){
  this.provider=await root.JournalProviders.make(this.config);
  try{const identity=await this.provider.resume();if(identity)await this.attach(identity,{deferSync:true});}catch(e){this.engine.problem(e);}
  this.status();
 }
 async attach(identity,options){
  if(identity.verification)return;
  this.loginRequested=false;this.account=identity;await this.engine.connect(this.provider,identity,options);this.subscription?.close?.();
  this.subscription=this.provider.subscribe(()=>void this.engine.flush(),identity.metaId);this.status();
 }
 message(error){if(/Failed to fetch|NetworkError|timeout/i.test(error.message||''))error={message:'暂时无法连接，请联网后重试；笔记仍保存在此设备。'};const box=this.dialog.querySelector('[data-sync-error]');if(box){box.hidden=false;box.textContent=error.message||String(error);}}
 async open(){if(!this.provider){try{await this.init();}catch(e){this.notify(e.message);return;}}await this.render();if(!this.dialog.open)this.dialog.showModal();}
 async render(){
  const local=this.provider.mode==='local',signed=!!this.engine.owner&&!this.loginRequested,s=this.engine.status();
  this.dialog.innerHTML='<form method="dialog" class="sync-close"><button class="icon-button" aria-label="关闭同步面板">×</button></form><div class="dialog-eyebrow">YOUR JOURNAL, EVERYWHERE</div><h2 class="dialog-title">同步与小组件</h2><p class="sync-intro">'+(local?'当前是本机同步测试。跨设备使用需要部署到 CloudBase。':'同一账号登录电脑与 iPhone，笔记、符号与时间一起同步。')+'</p><div class="sync-state" data-sync-status></div><p class="dialog-error" data-sync-error hidden></p>'+(signed?this.signedMarkup():this.loginMarkup(local));
  this.status(s);
  if(signed)this.bindSigned();else{this.bindLogin(local);if(this.loginRequested){const b=document.createElement('button');b.type='button';b.className='text-button';b.textContent='返回当前账号';b.onclick=()=>{this.loginRequested=false;void this.render();};this.dialog.append(b);}}
 }
 loginMarkup(local){const emailEnabled=local||this.config.auth?.emailEnabled!==false;return '<form id="sync-login"><label class="dialog-field" for="sync-identifier">'+(local?'测试账号（英文、数字或邮箱）':emailEnabled?'用户名 / 邮箱':'用户名')+'</label><input id="sync-identifier" class="dialog-input" autocomplete="username" required><label class="dialog-field" for="sync-password">密码</label><input id="sync-password" class="dialog-input" type="password" autocomplete="current-password" minlength="8"><div class="sync-login-actions"><button class="primary-button" type="submit">登录</button>'+(emailEnabled?'<button class="secondary-button" type="button" data-signup>注册'+(local?'测试账号':'邮箱账号')+'</button>':'')+(!local&&emailEnabled?'<button class="secondary-button" type="button" data-otp>邮箱验证码</button><button class="text-button" type="button" data-reset>忘记密码</button>':'')+'</div></form><form id="sync-verify" hidden><label class="dialog-field" for="sync-code">邮箱验证码</label><input id="sync-code" class="dialog-input" autocomplete="one-time-code" inputmode="numeric"><div id="sync-reset-password" hidden><label class="dialog-field" for="sync-new-password">新密码（至少 8 位）</label><input id="sync-new-password" class="dialog-input" type="password" minlength="8" autocomplete="new-password"></div><button class="primary-button" type="submit">验证并继续</button></form><p class="dialog-tip">登录后会打开该账号的笔记。本设备原有笔记仍保留，可由你选择合并。</p>';}
 bindLogin(local){
  const emailEnabled=local||this.config.auth?.emailEnabled!==false;
  const login=this.dialog.querySelector('#sync-login'),identifier=()=>$('#sync-identifier').value.trim(),password=()=>$('#sync-password').value;
  const attempt=async work=>{login.querySelectorAll('button').forEach(b=>b.disabled=true);try{const identity=await work();if(identity.verification){$('#sync-verify').hidden=false;this.notify('请查看邮箱中的验证码。');}else{await this.attach(identity);await this.render();this.notify('账号已连接，原有笔记仍保留。');}}catch(e){this.message(e);}finally{if(login.isConnected)login.querySelectorAll('button').forEach(b=>b.disabled=false);}};
  login.onsubmit=e=>{e.preventDefault();void attempt(()=>this.provider.login(identifier(),password()));};
  const signup=login.querySelector('[data-signup]');if(signup)signup.onclick=()=>void attempt(()=>this.provider.login(identifier(),password(),true));
  if(!local&&emailEnabled){
   login.querySelector('[data-otp]').onclick=()=>void attempt(()=>this.provider.otp(identifier()));
   login.querySelector('[data-reset]').onclick=()=>{ $('#sync-reset-password').hidden=false;void attempt(()=>this.provider.reset(identifier()));};
  }
  $('#sync-verify').onsubmit=async e=>{e.preventDefault();try{const identity=await this.provider.verify($('#sync-code').value.trim(),$('#sync-new-password').value);await this.attach(identity);await this.render();}catch(err){this.message(err);}};
 }
 signedMarkup(){
  const conflicts=this.engine.state.conflicts;
  return '<div class="sync-account"><strong>'+escape(this.account?.username||'我的账号')+'</strong><span><button class="text-button" id="sync-reauth">重新登录</button><button class="text-button" id="sync-logout">退出账号</button></span></div><div class="sync-actions"><button class="primary-button" id="sync-now">立即同步</button><button class="secondary-button" id="sync-import-guest">合并此设备旧笔记</button><button class="secondary-button" id="sync-drafts">下载冲突草稿</button></div>'+(this.engine.state.outbox.length?'<p class="dialog-tip">未上传内容留在此设备和当前账号中，退出账号后不会删除。</p>':'')+(conflicts.length?'<section class="sync-section"><h3>需要处理的冲突</h3>'+conflicts.map(c=>'<article class="conflict-card"><strong>'+escape(c.local.find(e=>!['migrated','scheduled'].includes(e.status))?.text||c.local[0]?.text)+'</strong><p>'+escape(c.message)+'</p><div><button class="secondary-button" data-resolve="cloud" data-key="'+escape(c.key)+'">采用云端版本</button><button class="secondary-button" data-resolve="note" data-key="'+escape(c.key)+'">将草稿另存为笔记</button></div></article>').join('')+'<p class="dialog-tip">处理前后的完整草稿都保存在本地，可随时下载。</p></section>':'')+'<section class="sync-section"><h3>iPhone 小组件</h3><p class="dialog-tip">显示今日完成数、待办、事件与逾期情况。刷新由 iOS 调度；点击进入网页。</p><div class="sync-actions"><button class="secondary-button" id="widget-create-token">生成只读凭据</button><button class="secondary-button" id="widget-download">下载 Scriptable 脚本</button></div><div id="widget-issued"></div><div id="widget-token-list"></div></section>';
 }
 bindSigned(){
  const action=async work=>{try{await work();}catch(e){this.message(e);}};
  $('#sync-reauth').onclick=()=>{this.loginRequested=true;void this.render();};
  $('#sync-now').onclick=()=>void action(async()=>{await this.engine.flush();await this.render();});
  $('#sync-import-guest').onclick=()=>void action(async()=>{const r=await this.engine.importGuest();this.notify('已合并 '+r.added+' 项，跳过 '+r.skipped+' 项已有记录。');await this.render();});
  $('#sync-logout').onclick=()=>void action(async()=>{await this.provider.logout();this.subscription?.close?.();this.account=null;await this.engine.disconnect();await this.render();});
  $('#sync-drafts').onclick=()=>void this.engine.backup().then(data=>this.download(JSON.stringify({conflicts:data.conflicts,drafts:data.drafts},null,2),'拾页-冲突草稿.json','application/json'));
  this.dialog.querySelectorAll('[data-resolve]').forEach(b=>b.onclick=()=>void action(async()=>{await this.engine.resolve(b.dataset.key,b.dataset.resolve);await this.render();}));
  $('#widget-create-token').onclick=()=>void action(async()=>{
   const result=await this.provider.rpc('createToken',{expectedOwner:this.engine.owner,label:'iPhone 小组件'});
   $('#widget-issued').innerHTML='<label class="dialog-field">只读凭据（只显示这一次）</label><input class="dialog-input" id="widget-secret" type="password" readonly><button class="secondary-button" id="widget-copy">复制凭据</button><p class="dialog-tip">在 Scriptable 首次运行时粘贴此凭据，脚本会保存到 iPhone Keychain。</p>';
   $('#widget-secret').value=result.token;
   $('#widget-copy').onclick=async()=>{try{await navigator.clipboard.writeText(result.token);this.notify('已复制只读凭据。');}catch{$('#widget-secret').type='text';$('#widget-secret').select();this.notify('请复制已选中的凭据。');}};
   await this.renderTokens();
  });
  $('#widget-download').onclick=()=>void action(async()=>{
   const response=await fetch('./scriptable/拾页.js');if(!response.ok)throw new Error('脚本尚未构建。');
   let script=await response.text();script=script.replace("const DEFAULT_API_URL = '';","const DEFAULT_API_URL = "+JSON.stringify(this.config.widgetApiUrl||'')+";").replace("const DEFAULT_WEB_URL = '';","const DEFAULT_WEB_URL = "+JSON.stringify(this.config.appUrl||(location.protocol==='https:'?location.origin+'/':''))+";");
   this.download(script,'拾页.js','text/javascript;charset=utf-8');this.notify('已下载；在 Scriptable 中导入并运行一次配置。');
  });
  void this.renderTokens();
 }
 async renderTokens(){
  if(!this.engine.online()){const node=$('#widget-token-list');if(node)node.innerHTML='<p class="dialog-tip">联网后可管理小组件凭据。</p>';return;}
  try{const r=await this.provider.rpc('tokens',{expectedOwner:this.engine.owner}),node=$('#widget-token-list');if(!node)return;
   node.innerHTML=r.tokens.length?'<p class="dialog-field">已授权的小组件</p>'+r.tokens.map(t=>'<div class="token-row"><span>'+escape(t.label)+'</span><button class="text-button" data-revoke="'+escape(t.id)+'">撤销</button></div>').join(''):'<p class="dialog-tip">尚未生成小组件凭据。</p>';
   node.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=async()=>{try{await this.provider.rpc('revokeToken',{expectedOwner:this.engine.owner,id:b.dataset.revoke});await this.renderTokens();this.notify('已撤销，下次请求将被拒绝。');}catch(e){this.message(e);}});
  }catch(e){this.message(e);}
 }
 download(text,name,type){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
root.JournalSyncUI=SyncUI;
})(globalThis);
