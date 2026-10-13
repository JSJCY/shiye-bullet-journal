export function option(args,name){
 const index=args.indexOf(name);
 if(index<0)return '';
 const value=args[index+1];
 if(!value||value.startsWith('--'))throw new Error('Missing deployment option value.');
 return value;
}
export function httpsUrl(value,{root=false}={}){
 if(!value)return '';
 let url;try{url=new URL(value);}catch{throw new Error('Deployment URL is invalid.');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Deployment URL must use HTTPS without credentials, query or fragment.');
 if(root&&url.pathname!=='/')throw new Error('The CloudBase website must be hosted at the domain root.');
 return url.href;
}
export function deploymentConfig({args=[],env={},state={},build={}}={}){
 const envId=option(args,'--env')||env.JOURNAL_ENV_ID||state.envId||'';
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,95}$/.test(envId))throw new Error('Set JOURNAL_ENV_ID or --env to your CloudBase environment ID.');
 if(state.envId&&state.envId!==envId)throw new Error('Deployment environment mismatch. Use a separate checkout for another environment.');
 const region=option(args,'--region')||env.JOURNAL_REGION||state.region||'ap-shanghai';
 const appUrl=httpsUrl(option(args,'--app-url')||env.JOURNAL_APP_URL||state.appUrl||build.appUrl||'',{root:true});
 const widgetUrl=httpsUrl(option(args,'--widget-url')||env.JOURNAL_WIDGET_URL||state.widgetUrl||build.widgetApiUrl||'');
 return {envId,region,appUrl,widgetUrl};
}
