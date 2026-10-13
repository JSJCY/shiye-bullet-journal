// 拾页 · 今日情况。首次在 Scriptable App 内运行，配置 HTTPS 接口和只读凭据。
// 不需要 Apple 开发者账号；小组件刷新频率由 iOS 控制。
const DEFAULT_API_URL = '';
const DEFAULT_WEB_URL = '';
const profile = String(args.widgetParameter || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
const prefix = 'shiye.widget.' + profile + '.';
const fm = FileManager.local();
const cacheFile = fm.joinPath(fm.documentsDirectory(), 'shiye-today-' + profile + '.json');
function get(key) { return Keychain.contains(prefix + key) ? Keychain.get(prefix + key) : ''; }
function https(value) { return /^https:\/\/[^/\s@]+(?:\/|$)/i.test(value); }
function showMessage(text) {
 const w = new ListWidget(); w.backgroundColor = new Color('#F6F7F9'); const t = w.addText(text); t.textColor = new Color('#202B36'); t.font = Font.systemFont(13); return w;
}
if (!config.runsInWidget) {
 const setup = new Alert(); setup.title = '拾页小组件配置'; setup.message = '从拾页网页生成只读凭据。此凭据只允许读取今日摘要，不是腾讯云管理密钥。';
 setup.addTextField('今日摘要 HTTPS 地址', get('api') || DEFAULT_API_URL);
 setup.addSecureTextField('只读凭据', get('token'));
 setup.addTextField('拾页网页 HTTPS 地址', get('web') || DEFAULT_WEB_URL);
 setup.addAction('保存'); setup.addCancelAction('取消');
 if (await setup.present() === 0) {
  const api = setup.textFieldValue(0).trim(), token = setup.textFieldValue(1).trim(), web = setup.textFieldValue(2).trim();
  if (!https(api) || !https(web) || !/^shiye_w_[A-Za-z0-9_-]{43}$/.test(token)) {
   const error = new Alert(); error.title = '配置未保存'; error.message = '请输入有效的 HTTPS 地址和从网页生成的只读凭据。'; error.addAction('知道了'); await error.present(); Script.complete(); return;
  }
  Keychain.set(prefix + 'api', api); Keychain.set(prefix + 'token', token); Keychain.set(prefix + 'web', web);
  if (fm.fileExists(cacheFile)) fm.remove(cacheFile);
 }
}
const api = get('api'), token = get('token');
let data, cached = false, refreshedAt;
if (!api || !token) {
 const widget = showMessage('请先在 Scriptable 中运行拾页脚本，配置今日摘要地址与只读凭据。'); Script.setWidget(widget); if (!config.runsInWidget) await widget.presentMedium(); Script.complete(); return;
}
try {
 const request = new Request(api); request.headers = {Authorization: 'Bearer ' + token}; request.timeoutInterval = 15;
 data = await request.loadJSON();
 if (request.response && request.response.statusCode === 401) { if (fm.fileExists(cacheFile)) fm.remove(cacheFile); throw new Error('凭据已失效，请重新配置。'); }
 if (!data || !data.date || !Array.isArray(data.pending)) throw new Error('摘要暂时不可用。');
 refreshedAt = new Date().toISOString(); fm.writeString(cacheFile, JSON.stringify({data, refreshedAt}));
} catch (error) {
 if (fm.fileExists(cacheFile)) { const saved = JSON.parse(fm.readString(cacheFile)); data = saved.data; refreshedAt = saved.refreshedAt; cached = true; }
 if (!data) { const widget = showMessage('无法更新拾页\n请检查网络或重新配置只读凭据。'); Script.setWidget(widget); if (!config.runsInWidget) await widget.presentMedium(); Script.complete(); return; }
}
const widget = new ListWidget(); widget.backgroundColor = new Color('#F6F7F9'); widget.setPadding(14,14,12,14); widget.url = get('web');
const title = widget.addText('拾页 · ' + data.date.slice(5).replace('-', '/')); title.font = Font.boldSystemFont(15); title.textColor = new Color('#202B36');
widget.addSpacer(7);
const progress = widget.addText(data.completed + ' / ' + data.total + ' 完成' + (data.overdue ? ' · ' + data.overdue + ' 逾期' : '')); progress.font = Font.systemFont(11); progress.textColor = new Color('#17665C');
widget.addSpacer(9);
const count = config.widgetFamily === 'small' ? 2 : config.widgetFamily === 'large' ? 7 : 4;
for (const item of data.pending.slice(0,count)) {
 const row = widget.addText((item.priority ? '* ' : '') + item.symbol + ' ' + item.text); row.font = Font.systemFont(12); row.textColor = new Color(item.overdue ? '#A65A3B' : '#202B36'); row.lineLimit = 1; widget.addSpacer(4);
}
if (!data.pending.length) { const text = widget.addText('今天的待办已完成。'); text.font = Font.systemFont(12); text.textColor = new Color('#626E7B'); }
if (config.widgetFamily !== 'small' && data.events.length) {
 widget.addSpacer(5); const item = data.events.find(e=>e.state==='planned') || data.events[0];
 const event = widget.addText('○ ' + (item.plannedTime ? item.plannedTime + ' ' : '') + item.text); event.font = Font.systemFont(11); event.textColor = new Color('#17665C'); event.lineLimit = 1;
}
widget.addSpacer();
const time = new Date(refreshedAt), hh = String(time.getHours()).padStart(2,'0'), mm = String(time.getMinutes()).padStart(2,'0');
const footer = widget.addText((cached ? '缓存 · ' : '刷新于 ') + hh + ':' + mm); footer.font = Font.systemFont(9); footer.textColor = new Color('#6B7582');
widget.refreshAfterDate = new Date(Date.now() + 15*60000);
Script.setWidget(widget); if (!config.runsInWidget) await widget.presentMedium(); Script.complete();
