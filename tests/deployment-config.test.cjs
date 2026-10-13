const test=require('node:test'),assert=require('node:assert/strict');
test('a fresh checkout requires an explicit CloudBase environment',async()=>{
 const {deploymentConfig}=await import('../scripts/deployment-config.mjs');
 assert.throws(()=>deploymentConfig(),/environment ID/);
 assert.equal(deploymentConfig({env:{JOURNAL_ENV_ID:'my-cloud-env'}}).envId,'my-cloud-env');
});
test('deployment refuses to reuse another environment state',async()=>{
 const {deploymentConfig}=await import('../scripts/deployment-config.mjs');
 assert.throws(()=>deploymentConfig({env:{JOURNAL_ENV_ID:'new-env'},state:{envId:'old-env',ownedFunctions:['journal']}}),/mismatch/);
 assert.equal(deploymentConfig({state:{envId:'old-env'}}).envId,'old-env');
});
test('credentials and unsupported website paths are rejected before deployment',async()=>{
 const {deploymentConfig}=await import('../scripts/deployment-config.mjs');
 for(const appUrl of ['http://example.com/','https://user:secret@example.com/','https://example.com/subpath/','https://example.com/?token=secret']){
  assert.throws(()=>deploymentConfig({env:{JOURNAL_ENV_ID:'my-env',JOURNAL_APP_URL:appUrl}}));
 }
 const config=deploymentConfig({env:{JOURNAL_ENV_ID:'my-env',JOURNAL_APP_URL:'https://example.com',JOURNAL_WIDGET_URL:'https://api.example.com/api/widget/today'}});
 assert.equal(config.appUrl,'https://example.com/');
 assert.equal(config.widgetUrl,'https://api.example.com/api/widget/today');
});
test('explicit options override defaults and missing option values fail',async()=>{
 const {deploymentConfig}=await import('../scripts/deployment-config.mjs');
 assert.equal(deploymentConfig({args:['--env','chosen-env'],env:{JOURNAL_ENV_ID:'default-env'}}).envId,'chosen-env');
 assert.throws(()=>deploymentConfig({args:['--env','--region','ap-shanghai']}),/Missing/);
});
