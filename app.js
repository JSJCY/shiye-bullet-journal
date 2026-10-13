(async () => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const Core = window.JournalCore;
  const STORAGE_KEY = 'shiye.bullet-journal.v1';
  const BACKUP_KEY = 'shiye.bullet-journal.backup-before-time-v2';
  let TODAY = Core.getToday();
  const symbols = { task: '•', event: '○', note: '–' };
  const stateSymbols = { open: '•', completed: '×', migrated: '>', scheduled: '<', cancelled: '•' };
  const monthNames = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
  const dayNames = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
  const englishMonths = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  const collections = ['产品想法', '待读书'];
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const dateObject = value => new Date(value + 'T12:00:00');
  const dateString = value => [value.getFullYear(), String(value.getMonth()+1).padStart(2,'0'), String(value.getDate()).padStart(2,'0')].join('-');
  const offsetDate = (date, offset) => { const value = dateObject(date); value.setDate(value.getDate()+offset); return dateString(value); };
  const monthKey = date => date.slice(0,7);
  const nextMonth = date => { const value = dateObject(date); value.setDate(1); value.setMonth(value.getMonth()+1); return dateString(value); };
  let selectedDate = TODAY, view = 'daily', collection = collections[0], filter = 'all', entryType = 'task', searchQuery = '', searchOpen = false;
  let calendarMonth = TODAY.slice(0,7), toastTimer, persistFailed = false, storedSnapshot = '', trackingFilter = 'pending', draftContext = '';
  const record = (text, type = 'task', options = {}) => ({ id: uid(), text, type, status: 'open', priority: false, inspiration: false, location: 'daily', date: TODAY, ...options });
  const seed = () => [
    record('完成子弹笔记页面草图', 'task', {priority:true}),
    record('整理桌面，给新的一周留点空间', 'task', {status:'completed'}),
    record('14:00 和伙伴讨论产品想法', 'event'),
    record('早上关掉通知后，比平时更容易专注。', 'note'),
    record('用符号保留思路的流动，让记录像写在纸上一样轻。', 'note', {inspiration:true}),
    record('睡前读 20 分钟书'),
    record('把书单放到一个专门的集合里', 'task', {date:offsetDate(TODAY,-1)}),
    record('整理上周的零散灵感', 'task', {date:offsetDate(TODAY,-1)}),
    record('走了很长一段路，天气刚刚好。', 'note', {date:offsetDate(TODAY,-2)}),
    record('做一个真正愿意每天打开的工具', 'task', {location:'monthly',date:monthKey(TODAY),priority:true}),
    record('月底回顾：哪些事情值得继续？', 'note', {location:'monthly',date:monthKey(TODAY)}),
    record('更新个人网站', 'task', {location:'future',date:nextMonth(TODAY)}),
    record('试着给自己的记录留一点呼吸感。', 'note', {location:'collection',collection:'产品想法'}),
    record('《子弹笔记》', 'task', {location:'collection',collection:'待读书'}),
    record('《当下的力量》', 'task', {location:'collection',collection:'待读书'})
  ];
  let entries, recoveryRaw = null, engine = null, syncUI = null, bootReady = false, dialogScope = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    recoveryRaw = raw;
    const parsed = raw ? JSON.parse(raw) : seed();
    entries = Core.normalize(parsed);
    if (raw && parsed.some(item => !Object.hasOwn(item,'createdAt')) && !localStorage.getItem(BACKUP_KEY)) localStorage.setItem(BACKUP_KEY,raw);
    storedSnapshot = raw || '';
  } catch (error) {
    entries = []; persistFailed = true;
    console.warn('笔记读取失败：',error.message);
  }
  function mirrorLegacy() {
    if(engine?.owner || persistFailed)return;
    try { const raw=JSON.stringify(engine?.state.entries||entries);localStorage.setItem(STORAGE_KEY,raw);storedSnapshot=raw; }
    catch { /* IndexedDB remains authoritative after a successful transaction. */ }
  }
  async function commit(change) {
    try {
      if(!bootReady)throw new Error('正在恢复本地笔记，请稍候。');
      if($('#action-dialog').open && dialogScope!==engine?.scope)throw new Error('账号已经切换，请关闭此窗口后重新打开；当前输入仍保留。');
      if(persistFailed || !engine)throw new Error('当前无法安全保存笔记，请先导出备份。');
      await engine.mutate(change);return true;
    } catch(error) {
      notify(error.message);const area=$('#dialog-error');if(area){area.textContent=error.message;area.hidden=false;}return false;
    }
  }
  function currentEntry(id){return entries.find(item=>item.id===id);}
  function dateTimeText(date,time){return date ? date.replaceAll('-','/')+(time?' '+time:'') : '未安排';}
  function stampText(value) {
    if(!value)return '时间未记录';
    return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
  }
  function eventTiming(entry) {
    if(entry.eventState==='occurred')return '已发生';
    if(entry.eventState==='cancelled')return '已取消';
    if(!entry.plannedDate)return '待安排';
    const today=Core.getToday();
    if(entry.plannedDate<today)return '日期已过';
    if(entry.plannedTime){
      const minutes=Math.ceil((Core.timeValue(entry.plannedDate,entry.plannedTime)-Date.now())/60000);
      if(minutes<=0)return '已到时间';
      if(minutes<=60)return minutes+' 分钟后';
    }
    return entry.plannedDate===today?'今日安排':'待发生';
  }

  function notify(message) {
    clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('show');
    toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2600);
  }
  function locationLabel(entry) {
    if (entry.location === 'daily') return entry.date.replaceAll('-', '/') + ' 每日记录';
    if (entry.location === 'monthly') return entry.date.replace('-', '/') + ' 月度计划';
    if (entry.location === 'future') return entry.date.replaceAll('-', '/') + ' 未来计划';
    return entry.collection;
  }
  function openDialog(html) { dialogScope=engine?.scope||null; $('#dialog-content').innerHTML = html; if (!$('#action-dialog').open) $('#action-dialog').showModal(); }
  function closeDialog() { $('#action-dialog').close(); }
  function selectedEntries() {
    let selected;
    if(searchQuery)selected=entries.filter(entry=>entry.text.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase()) || String(entry.memo || '').toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase()));
    else if(view==='tracking'){
      const tracking=Core.tracking(entries);
      if(trackingFilter==='events')selected=entries.filter(entry=>entry.type==='event').sort((a,b)=>(a.plannedDate || '9999').localeCompare(b.plannedDate || '9999'));
      else if(trackingFilter==='completed')selected=tracking.completed.slice().sort((a,b)=>(b.completedAt || '').localeCompare(a.completedAt || ''));
      else if(trackingFilter==='overdue')selected=tracking.overdue;
      else if(trackingFilter==='today')selected=Core.activeTasks(entries).filter(entry=>['open','doing'].includes(entry.taskState) && (entry.plannedDate===TODAY || entry.dueDate===TODAY));
      else selected=[...tracking.overdue,...tracking.older,...tracking.today,...tracking.upcoming,...tracking.undated];
    } else selected=entries.filter(entry=>view==='daily'?(entry.location==='daily' && entry.date===selectedDate) || (entry.location!=='daily' && entry.plannedDate===selectedDate && (entry.type==='event' || entry.type==='task' && !['migrated','scheduled'].includes(entry.status))):view==='monthly'?entry.location==='monthly' && entry.date===monthKey(selectedDate):view==='future'?entry.location==='future':entry.location==='collection' && entry.collection===collection);
    return selected.filter(entry=>filter==='all' || entry.type===filter);
  }
  function entrySymbol(entry) {
    if(entry.type!=='task')return symbols[entry.type];
    if(['migrated','scheduled'].includes(entry.status))return stateSymbols[entry.status];
    return entry.taskState==='completed'?'×':'•';
  }
  function entryMeta(entry) {
    const current=Core.taskFor(entries,entry), parts=[];
    if(entry.type==='task'){
      const state=current.taskState;
      const label=state==='completed'?(current.completedAt?(Core.isLate(current)?'逾期完成':'已完成'):'已完成 · 时间未记录'):state==='doing'?'进行中':state==='cancelled'?'已划掉':Core.isLate(current)?'已逾期':'待办';
      parts.push('<span class="status-label '+(state==='completed'?'done':Core.isLate(current)?'late':state==='doing'?'doing':'')+'">'+escape(label)+'</span>');
      if(current.plannedDate)parts.push('<span>计划 '+escape(dateTimeText(current.plannedDate,current.plannedTime))+'</span>');
      if(current.dueDate)parts.push('<span class="'+(current.taskState!=='cancelled' && Core.isLate(current)?'late-text':'')+'">截止 '+escape(dateTimeText(current.dueDate,current.dueTime))+'</span>');
      if(current.startedAt)parts.push('<span>开始 '+escape(stampText(current.startedAt))+'</span>');
      if(state==='completed' && current.completedAt)parts.push('<span>完成 '+escape(stampText(current.completedAt))+'</span>');
    } else if(entry.type==='event'){
      parts.push('<span class="status-label '+(entry.eventState==='occurred'?'done':'')+'">'+escape(eventTiming(entry))+'</span>');
      if(entry.plannedDate)parts.push('<span>'+escape(dateTimeText(entry.plannedDate,entry.plannedTime))+'</span>');
      if(entry.occurredAt)parts.push('<span>标记于 '+escape(stampText(entry.occurredAt))+'</span>');
    }
    return parts.length?'<div class="entry-timing">'+parts.join('')+'</div>':'';
  }
  function renderEntries() {
    const visible=selectedEntries(),active=visible.filter(entry=>entry.type==='task' && !['migrated','scheduled'].includes(entry.status));
    $('#entry-summary').textContent=visible.length?visible.length+' 条记录 · '+active.filter(entry=>['open','doing'].includes(entry.taskState)).length+' 件未完成':'让记录轻一点';
    $('#entry-list').innerHTML=visible.length?visible.map(entry=>{
      const destination=entry.target?currentEntry(entry.target):null,flags=(entry.priority?'*':'')+(entry.inspiration?'!':'');
      return '<div class="entry '+entry.type+' '+entry.status+(entry.eventState==='occurred'?' occurred':'')+'" data-id="'+escape(entry.id)+'"><div class="entry-signifier '+(entry.inspiration?'inspiration':'')+'" aria-label="'+escape((entry.priority?'重要 ':'')+(entry.inspiration?'灵感':''))+'">'+escape(flags)+'</div><button class="entry-symbol" data-action="actions" aria-label="操作记录：'+escape(entry.text)+'" title="点击符号处理记录">'+escape(entrySymbol(entry))+'</button><div class="entry-body"><button class="entry-text" data-action="edit" aria-label="编辑：'+escape(entry.text)+'">'+escape(entry.text)+'</button>'+entryMeta(entry)+(entry.memo?'<div class="entry-memo">'+escape(entry.memo)+'</div>':'')+(destination?'<button class="entry-destination" data-action="destination">'+escape(entry.status==='scheduled'?'已安排到 ':'已迁移到 ')+escape(locationLabel(destination))+' ↗</button>':'')+(searchQuery || view==='future' || view==='tracking' || view==='daily' && entry.location!=='daily'?'<div class="entry-source">'+escape(locationLabel(entry))+'</div>':'')+(entry.sourceId && !searchQuery && view!=='tracking'?'<div class="entry-source">从 '+escape(locationLabel(currentEntry(entry.sourceId) || entry))+' 迁入</div>':'')+'</div><button class="entry-more" data-action="actions" aria-label="更多操作：'+escape(entry.text)+'">···</button></div>';
    }).join(''):'<div class="empty-state"><span>'+escape(symbols[filter] || '–')+'</span>'+(searchQuery?'没有找到相关记录，换个关键词试试。':view==='tracking'?'这里暂时没有需要跟进的事项。':filter!=='all'?'这里还没有这类记录。':'这一页还是空白。<br>从一件小事开始吧。')+'</div>';
  }

  function renderWeek() {
    const date = dateObject(selectedDate), start = offsetDate(selectedDate, -((date.getDay()+6)%7));
    $('#week-strip').innerHTML = Array.from({length:7}, (_,i) => {
      const day = offsetDate(start,i);
      return '<button class="week-day ' + (day === selectedDate ? 'current ' : '') + (day === TODAY ? 'is-today' : '') + '" data-date="' + day + '" aria-label="' + day + '" aria-pressed="' + (day === selectedDate) + '"><span>' + ['MON','TUE','WED','THU','FRI','SAT','SUN'][i] + '</span><strong>' + dateObject(day).getDate() + '</strong></button>';
    }).join('');
  }
  function renderCalendar() {
    const first = dateObject(calendarMonth+'-01'), start = offsetDate(dateString(first), -((first.getDay()+6)%7));
    const last = new Date(first.getFullYear(), first.getMonth()+1, 0);
    const slots = Math.ceil((((first.getDay()+6)%7) + last.getDate())/7)*7;
    $('#calendar-heading').textContent = first.getFullYear() + '年' + (first.getMonth()+1) + '月';
    $('#calendar-grid').innerHTML = Array.from({length:slots}, (_,i) => {
      const day = offsetDate(start,i), hasRecord = entries.some(entry => entry.location === 'daily' && entry.date === day);
      return '<button class="calendar-day ' + (day === selectedDate ? 'selected ' : '') + (day === TODAY ? 'today ' : '') + (monthKey(day) !== calendarMonth ? 'other-month ' : '') + (hasRecord ? 'has-record' : '') + '" data-date="' + day + '" aria-label="' + day + (hasRecord ? '，有记录' : '') + '" aria-pressed="' + (day === selectedDate) + '">' + dateObject(day).getDate() + '</button>';
    }).join('');
  }
  function renderReview() {
    const tracking=Core.tracking(entries),review=[...tracking.overdue,...tracking.older];
    $('#review-list').innerHTML=review.length?review.slice(0,4).map(entry=>'<div class="review-item"><div class="review-text"><span>•</span>'+escape(entry.text)+'</div><small class="'+(Core.isLate(entry)?'late-text':'')+'">'+escape(Core.isLate(entry)?'截止 '+dateTimeText(entry.dueDate,entry.dueTime)+' · 已逾期':'计划 '+dateTimeText(entry.plannedDate,entry.plannedTime))+'</small><button data-review="'+escape(entry.id)+'">查看并处理 ↗</button></div>').join('')+(review.length>4?'<button class="review-more" data-open-tracking>查看全部 '+review.length+' 项 ↗</button>':''):'<div class="review-empty">没有遗漏的过往待办。<br>给今天留一点空间。</div>';
    const events=entries.filter(entry=>entry.type==='event' && entry.plannedDate===TODAY && entry.eventState!=='cancelled').sort((a,b)=>(a.plannedTime || '').localeCompare(b.plannedTime || ''));
    $('#event-agenda').innerHTML=events.length?events.map(entry=>'<button class="agenda-item" data-agenda="'+escape(entry.id)+'"><span>'+escape(entry.plannedTime || '全天')+'</span><div>'+escape(entry.text)+'<small>'+escape(eventTiming(entry))+'</small></div></button>').join(''):'<p class="review-empty">今天还没有安排事件。</p>';
  }
  function renderTimingDraft() {
    const context=view+':'+selectedDate+':'+collection;
    if(context!==draftContext){
      $('#composer-plan-date').value=['daily'].includes(view)?selectedDate:'';
      $('#composer-plan-time').value='';$('#composer-due-date').value='';$('#composer-due-time').value='';
      draftContext=context;
    }
    $('#composer-deadline').hidden=entryType!=='task';
    $('#composer-timing').hidden=entryType==='note' && view!=='future';
    if(view==='future')$('#composer-timing').open=true;
    $('#composer-date-label').textContent=entryType==='event'?'事件日期':entryType==='note'?'归属日期':'计划日期';
    if(view==='future')$('#composer-plan-date').min=offsetDate(TODAY,1);else $('#composer-plan-date').removeAttribute('min');
    $('#composer-placement-hint').textContent=view==='future'?'未来计划需要选择明天或之后的日期。':entryType==='event'?'日期和时间会进入“今日安排”，可标记已发生或改期。':'计划时间与截止时间分别记录；迁移会保留原截止时间。';
  }

  function render() {
    const date=dateObject(selectedDate),isToday=selectedDate===TODAY;
    const titles={daily:isToday?'把今天，写清楚。':'每一天，都值得记录。',monthly:'给这个月，一点方向。',future:'把期待，留给未来。',collection:collection+'，慢慢收集。',tracking:'每件事，都有下文。'};
    const descriptions={daily:'记下要做的事，也记下值得记住的瞬间。',monthly:'筛选值得投入的事，给时间一个清晰的方向。',future:'选择具体日期，给未来的任务和事件留个位置。',collection:'把散落在不同日子的记录，汇在同一个主题里。',tracking:'看见遗漏的待办、任务进展和真实的完成记录。'};
    const names={daily:'每日记录',monthly:'月度计划',future:'未来计划',collection,tracking:'时间跟进'};
    $('#page-title').textContent=titles[view];$('#page-subtitle').textContent=descriptions[view];
    $('#page-eyebrow').textContent={daily:'A LITTLE SPACE FOR YOUR DAY',monthly:'MAKE ROOM FOR WHAT MATTERS',future:'SOMETHING TO LOOK FORWARD TO',collection:'ONE PAGE, ONE LITTLE WORLD',tracking:'FOLLOW THROUGH, ONE THING AT A TIME'}[view];
    $('#breadcrumb-current').textContent=searchQuery?'全局搜索':names[view];
    $('#date-number').textContent=view==='daily'?String(date.getDate()).padStart(2,'0'):view==='monthly'?String(date.getMonth()+1).padStart(2,'0'):view==='future'?'↗':view==='tracking'?'◷':'⊙';
    $('#journal-title').textContent=searchQuery?'搜索结果':view==='daily'?monthNames[date.getMonth()]+' · '+dayNames[date.getDay()]:view==='monthly'?date.getFullYear()+'年 · '+monthNames[date.getMonth()]:names[view];
    const pageName={daily:'DAILY LOG',monthly:'MONTHLY LOG',future:'FUTURE LOG',collection:'COLLECTION',tracking:'FOLLOW UP'}[view];
    $('#journal-caption').innerHTML=date.getFullYear()+' / '+englishMonths[date.getMonth()]+' <span>'+pageName+'</span>';
    $('#week-strip').hidden=view!=='daily' || Boolean(searchQuery);
    $('#day-navigation').hidden=!['daily','monthly'].includes(view) || Boolean(searchQuery);
    $('#prev-day').setAttribute('aria-label',view==='monthly'?'上一个月':'前一天');$('#next-day').setAttribute('aria-label',view==='monthly'?'下一个月':'后一天');
    $('#today-button').textContent=view==='monthly'?'本月':'今天';
    $('#composer').hidden=Boolean(searchQuery) || view==='tracking';
    $('#tracking-tabs').hidden=view!=='tracking' || Boolean(searchQuery);
    $('#page-number').textContent=pageName;
    $$('.nav-item').forEach(button=>button.classList.toggle('active',button.dataset.view===view && (view!=='collection' || button.dataset.collection===collection)));
    $$('#filters button').forEach(button=>{button.classList.toggle('selected',button.dataset.filter===filter);button.setAttribute('aria-pressed',String(button.dataset.filter===filter));});
    $$('#tracking-tabs button').forEach(button=>{button.classList.toggle('selected',button.dataset.tracking===trackingFilter);button.setAttribute('aria-pressed',String(button.dataset.tracking===trackingFilter));});
    $$('[data-count]').forEach(element=>{element.textContent=entries.filter(entry=>entry.location==='collection' && entry.collection===element.dataset.count).length;});
    const tracking=Core.tracking(entries);$('#tracking-count').textContent=tracking.overdue.length+tracking.older.length || '';
    $('#storage-warning').hidden=!persistFailed;
    renderWeek();renderCalendar();renderEntries();renderReview();renderTimingDraft();
  }

  function setDate(date) { selectedDate = date; calendarMonth = monthKey(date); view = 'daily'; resetSearch(); filter = 'all'; render(); }
  function jumpTo(entry) { view = entry.location; if (entry.location === 'collection') collection = entry.collection; if (entry.location === 'daily') selectedDate = entry.date; if (entry.location === 'monthly') selectedDate = entry.date+'-01'; calendarMonth = monthKey(selectedDate); filter = 'all'; resetSearch(); render(); }
  function updateEntryType(type) {
    entryType = type; $('#composer-symbol').textContent = symbols[type];
    $$('#type-selector button').forEach(button => button.classList.toggle('chosen',button.dataset.type === type));
    $('#entry-input').placeholder = {task:'记下一件要做的事…',event:'记下一件发生的事…',note:'记下一个想法或观察…'}[type];
    renderTimingDraft();
  }
  function parseInput(raw) {
    let text = raw.trim(), type = entryType, priority = false, inspiration = false;
    let match;
    while ((match = /^([*!])\s*/.exec(text))) { priority ||= match[1] === '*'; inspiration ||= match[1] === '!'; text = text.slice(match[0].length); }
    match = /^([•○oO–-])\s+/.exec(text);
    if (match) { type = ['○','o','O'].includes(match[1]) ? 'event' : ['–','-'].includes(match[1]) ? 'note' : 'task'; text = text.slice(match[0].length).trim(); }
    return {text,type,priority,inspiration};
  }
  async function addEntry(event) {
    event.preventDefault();const parsed=parseInput($('#entry-input').value);
    if(!parsed.text){$('#entry-input').focus();return;}
    const planDate=$('#composer-plan-date').value,planTime=$('#composer-plan-time').value;
    if(view==='future' && !planDate){$('#composer-timing').open=true;notify('请先选择未来计划的日期。');$('#composer-plan-date').focus();return;}
    const dueDate=parsed.type==='task'?$('#composer-due-date').value:null,dueTime=parsed.type==='task'?$('#composer-due-time').value:null;
    const location=parsed.type==='event' && view==='daily' && planDate?'daily':view;
    const date=view==='monthly'?monthKey(selectedDate):view==='future'?planDate:parsed.type==='event' && view==='daily' && planDate?planDate:selectedDate;
    const success=await commit(latest=>[...latest,Core.makeEntry({...parsed,location,date,plannedDate:parsed.type==='note'?null:planDate,plannedTime:parsed.type==='note'?null:planTime,dueDate,dueTime,...(view==='collection'?{collection}:{})})]);
    if(success){filter='all';$('#entry-input').value='';updateEntryType(parsed.type);render();$('#entry-input').focus();notify(date!==selectedDate && location==='daily'?'已记录在 '+dateTimeText(date)+' 每日页面。':'记下了。');}
  }
  function showActions(original) {
    const entry=currentEntry(original.id) || original,current=Core.taskFor(entries,entry),archived=['migrated','scheduled'].includes(entry.status),operations=[];
    function action(name,symbol,label,hint=''){operations.push('<button data-operation="'+name+'"><span>'+escape(symbol)+'</span>'+escape(label)+(hint?'<small>'+escape(hint)+'</small>':'')+'</button>');}
    if(entry.type==='task'){
      if(archived)action('current','↗','查看当前任务',current.taskState==='completed'?'已经完成':'继续处理');
      else if(['open','doing'].includes(current.taskState)){
        if(current.taskState==='open')action('start','•','开始这项任务','记录开始时间');
        else action('reopen','•','暂时停下','恢复待办');
        action('complete','×','标记完成','记录完成时间');
        action('migrate','>','迁移或改期','保留去向与历史');
        action('schedule','<','安排到未来计划','选择日期');
        action('cancel','⌁','划掉这项任务','记录仍保留');
      } else action('reopen','•','恢复为待办','保留之前的完成历史');
      action('edit','–','编辑内容与时间');
    } else if(entry.type==='event'){
      action('edit','○','编辑事件日期和时间');
      if(entry.eventState==='planned'){action('occur','○','标记已发生','记录标记时间');action('reschedule','○','改期','调整日期和时间');action('cancel','⌁','取消事件','保留取消记录');}
      else action('reopen','○','恢复为待发生');
      action('memo','–','补充事件记录','发生了什么');
    } else {
      action('edit','–','编辑笔记');
      action(entry.status==='cancelled'?'reopen':'cancel','–',entry.status==='cancelled'?'恢复记录':'划掉这条笔记');
    }
    action('history','◷','查看时间与操作历史');
    action('trash','⌫','移到回收站','可以在账号与同步中恢复');
    openDialog('<div class="dialog-eyebrow">'+(entry.type==='event'?'AN EVENT, WITH A TIME AND A STORY':'FOLLOW THROUGH, ONE STEP AT A TIME')+'</div><h2 class="dialog-title">'+(entry.type==='event'?'这件事，接下来呢？':'这一条，怎么处理？')+'</h2><div class="dialog-entry">'+escape(entrySymbol(entry))+' '+escape(entry.text)+entryMeta(entry)+'</div><p id="dialog-error" class="dialog-error" hidden></p><div class="action-grid">'+operations.join('')+'</div>');
    $$('#dialog-content [data-operation]').forEach(button=>button.onclick=async()=>{
      const operation=button.dataset.operation;
      if(['edit','reschedule','memo'].includes(operation)){showEdit(current,operation);return;}
      if(operation==='migrate' || operation==='schedule'){showMigration(current,operation==='schedule');return;}
      if(operation==='history'){showHistory(current);return;}
      if(operation==='current'){closeDialog();jumpTo(current);return;}
      const success=await commit(latest=>{
        if(operation==='trash')return window.JournalSyncModel.setTrashed(latest,[{key:window.JournalSyncModel.keyOf(current),revision:current.revision}]);
        if(current.type==='task')return Core.changeTask(latest,current.id,operation);
        if(current.type==='event')return Core.changeEvent(latest,current.id,operation);
        return latest.map(item=>item.id===current.id?{...item,status:operation==='cancel'?'cancelled':'open',revision:item.revision+1,updatedAt:new Date().toISOString(),history:[...item.history,{kind:operation,at:new Date().toISOString()}]}:item);
      });
      if(success){closeDialog();notify({trash:'已移到回收站，可以恢复。',start:'已开始，开始时间已记录。',complete:'已完成，完成时间已记录。',occur:'已标记发生，可以补充事件记录。',cancel:'已划掉，历史仍保留。',reopen:'已恢复，之前的操作时间仍在历史中。'}[operation]);}
    });
  }
  function timingFields(entry,prefix) {
    const event=entry.type==='event';
    return '<div class="timing-grid"><div><label class="dialog-field" for="'+prefix+'-plan-date">'+(event?'事件日期':'计划日期')+'</label><input class="dialog-input" type="date" id="'+prefix+'-plan-date" value="'+escape(entry.plannedDate || '')+'"></div><div><label class="dialog-field" for="'+prefix+'-plan-time">'+(event?'事件时间':'计划时间')+'</label><input class="dialog-input" type="time" id="'+prefix+'-plan-time" value="'+escape(entry.plannedTime || '')+'"></div></div><div class="timing-grid task-deadline" id="'+prefix+'-deadline"'+(event?' hidden':'')+'><div><label class="dialog-field" for="'+prefix+'-due-date">截止日期</label><input class="dialog-input" type="date" id="'+prefix+'-due-date" value="'+escape(entry.dueDate || '')+'"></div><div><label class="dialog-field" for="'+prefix+'-due-time">截止时间（可选）</label><input class="dialog-input" type="time" id="'+prefix+'-due-time" value="'+escape(entry.dueTime || '')+'"></div></div>';
  }
  function showEdit(original,focusMode='edit') {
    const entry=Core.taskFor(entries,currentEntry(original.id) || original),revision=entry.revision;
    const isChain=entry.type==='task' && entries.filter(item=>item.taskId===entry.taskId).length>1;
    const eventButtons=['occurred','cancelled'].includes(entry.eventState)?'<button type="button" data-edit-event-action="reopen">恢复为待发生</button>':'<button type="button" data-edit-event-action="occur">保存并标记已发生</button><button type="button" data-edit-event-action="cancel">保存并取消事件</button>';
    openDialog('<div class="dialog-eyebrow">CONTENT, TIME, AND CONTEXT</div><h2 class="dialog-title">'+(entry.type==='event'?'事件详情':'修改这条记录')+'</h2><form id="edit-form" novalidate><label class="dialog-field" for="edit-text">记录内容</label><textarea class="dialog-textarea" id="edit-text" required maxlength="2000">'+escape(entry.text)+'</textarea><label class="dialog-field" for="edit-type">条目类型</label><select class="dialog-select" id="edit-type"><option value="task">• 任务</option><option value="event">○ 事件</option><option value="note">– 笔记</option></select><div id="edit-timing">'+timingFields(entry,'edit')+'</div><div id="edit-event-memo"'+(entry.type!=='event'?' hidden':'')+'><label class="dialog-field" for="edit-memo">事件备注 / 发生后的记录</label><textarea class="dialog-textarea memo-textarea" id="edit-memo" maxlength="4000" placeholder="记录发生了什么，以及你的观察…">'+escape(entry.memo || '')+'</textarea></div><p class="dialog-tip" id="edit-timing-tip">'+(entry.type==='event'?'改期会更新事件所在的每日页面，并保留原时间。':'计划与截止分别保存。截止只填日期时，按当天结束计算。')+'</p><div id="edit-event-controls" class="event-editor-controls"><span>事件状态：'+escape(entry.type==='event'?eventTiming(entry):'待发生')+'</span><div>'+eventButtons+'</div></div><div class="edit-flags"><label><input type="checkbox" id="edit-priority"'+(entry.priority?' checked':'')+'>* 重要</label><label><input type="checkbox" id="edit-inspiration"'+(entry.inspiration?' checked':'')+'>! 灵感</label></div><p id="dialog-error" class="dialog-error" hidden></p><div class="dialog-actions"><button type="button" class="secondary-button" id="edit-cancel">取消</button><button class="primary-button" type="submit">保存修改</button></div></form>');
    $('#edit-type').value=entry.type;$('#edit-type').disabled=isChain;
    function toggleFields(){const type=$('#edit-type').value;$('#edit-timing').hidden=type==='note';$('#edit-deadline').hidden=type!=='task';$('#edit-event-memo').hidden=type!=='event';$('#edit-event-controls').hidden=type!=='event';}
    toggleFields();$('#edit-type').onchange=toggleFields;$('#edit-cancel').onclick=closeDialog;
    async function saveEdit(eventAction=null){
      const type=$('#edit-type').value;
      const patch={text:$('#edit-text').value,type,priority:$('#edit-priority').checked,inspiration:$('#edit-inspiration').checked,plannedDate:type==='note'?null:$('#edit-plan-date').value,plannedTime:type==='note'?null:$('#edit-plan-time').value,dueDate:type==='task'?$('#edit-due-date').value:null,dueTime:type==='task'?$('#edit-due-time').value:null,memo:type==='event'?$('#edit-memo').value.trim():''};
      if(type==='event' && !patch.plannedDate && ['daily','future'].includes(entry.location)){$('#dialog-error').textContent='请先选择事件日期。';$('#dialog-error').hidden=false;return;}
      const success=await commit(latest=>{const updated=Core.updateEntry(latest,entry.id,patch,undefined,revision);return eventAction?Core.changeEvent(updated,entry.id,eventAction):updated;});
      if(success){closeDialog();const updated=currentEntry(entry.id);notify(eventAction?eventAction==='occur'?'已保存并标记发生，时间已记录。':eventAction==='cancel'?'事件已取消，仍可恢复。':'已恢复为待发生。':updated.location==='daily' && updated.date!==selectedDate?'事件已更新到 '+updated.date+' 每日记录。':'修改已保存，时间变化已记入历史。');}
    }
    $('#edit-form').onsubmit=event=>{event.preventDefault();saveEdit();};
    $$('#edit-event-controls [data-edit-event-action]').forEach(button=>button.onclick=()=>saveEdit(button.dataset.editEventAction));
    if(focusMode==='reschedule')$('#edit-plan-date').focus();
    if(focusMode==='memo')$('#edit-memo').focus();
  }
  function showMigration(entry,scheduled=false,toToday=false) {
    openDialog('<div class="dialog-eyebrow">KEEP WHAT STILL MATTERS</div><h2 class="dialog-title">'+(scheduled?'把它安排到未来':'给这件事一个去向')+'</h2><p class="dialog-description">保留原条目的去向。新页面继续跟进同一项任务，原截止时间会保留。</p><div class="dialog-entry">• '+escape(entry.text)+'</div><form id="migration-form" novalidate><label class="dialog-field" for="migration-kind">目标页面</label><select class="dialog-select" id="migration-kind"><option value="daily">每日记录</option><option value="monthly">月度计划</option><option value="future">未来计划</option><option value="collection">主题集合</option></select><div id="migration-date-field"><label class="dialog-field" id="migration-date-label" for="migration-date">日期</label><input class="dialog-input" id="migration-date" type="date" required></div><div id="migration-collection-field" hidden><label class="dialog-field" for="migration-collection">选择集合</label><select id="migration-collection" class="dialog-select">'+collections.map(name=>'<option>'+escape(name)+'</option>').join('')+'</select></div><p id="dialog-error" class="dialog-error" hidden></p><div class="dialog-actions"><button type="button" class="secondary-button" id="migration-cancel">取消</button><button type="submit" class="primary-button">确认迁移 →</button></div></form>');
    const select=$('#migration-kind'),dateInput=$('#migration-date');
    select.value=scheduled?'future':toToday?'daily':'daily';
    function syncKind(){
      const kind=select.value;$('#migration-date-field').hidden=kind==='collection';$('#migration-collection-field').hidden=kind!=='collection';
      dateInput.type=kind==='monthly'?'month':'date';
      dateInput.value=kind==='monthly'?monthKey(selectedDate):kind==='future'?offsetDate(TODAY,1):toToday?TODAY:offsetDate(selectedDate,1);
      $('#migration-date-label').textContent=kind==='monthly'?'月份':kind==='future'?'未来日期（明天起）':'日期';
      if(kind==='future')dateInput.min=offsetDate(TODAY,1);else dateInput.removeAttribute('min');
      $('#migration-form .primary-button').textContent=kind==='future'?'确认安排 →':'确认迁移 →';
    }
    syncKind();select.onchange=syncKind;$('#migration-cancel').onclick=closeDialog;
    $('#migration-form').onsubmit=async event=>{
      event.preventDefault();const destination={location:select.value,date:dateInput.value,collection:select.value==='collection'?$('#migration-collection').value:null};
      const success=await commit(latest=>Core.migrate(latest,entry.id,destination));
      if(success){closeDialog();const target=currentEntry(currentEntry(entry.id).target);notify('已'+(select.value==='future'?'安排到 ':'迁移到 ')+locationLabel(target)+'，历史已保留。');}
    };
  }
  function showHistory(original) {
    const entry=Core.taskFor(entries,currentEntry(original.id) || original);
    const labels={created:'创建记录',start:'开始任务',complete:'标记完成',reopen:'恢复待办 / 待发生',cancel:'划掉 / 取消',trashed:'移到回收站',restored:'从回收站恢复',edited:'修改记录',rescheduled:'调整日期与时间',migrated:'迁移 / 安排到未来',occurred:'标记事件已发生'};
    const history=entry.history.slice().reverse();
    const timing=entryMeta(entry);
    function historyDetail(item){
      if(item.kind==='migrated')return locationLabel(item.from)+' → '+locationLabel(item.to);
      if(item.kind==='rescheduled')return '计划 '+dateTimeText(item.before?.plannedDate,item.before?.plannedTime)+' → '+dateTimeText(item.after?.plannedDate,item.after?.plannedTime)+'；截止 '+dateTimeText(item.before?.dueDate,item.before?.dueTime)+' → '+dateTimeText(item.after?.dueDate,item.after?.dueTime);
      if(item.kind==='complete')return item.late?'完成时已超过截止时间':'完成时间已记录';
      return '';
    }
    openDialog('<div class="dialog-eyebrow">A RECORD OF HOW THINGS MOVED</div><h2 class="dialog-title">时间与操作历史</h2><div class="dialog-entry">'+escape(entry.text)+timing+'</div><div class="history-list">'+(history.length?history.map(item=>'<div class="history-item"><span class="history-dot"></span><div><strong>'+escape(labels[item.kind] || '更新记录')+'</strong><time>'+escape(item.at?stampText(item.at):'旧版操作 · 时间未记录')+'</time>'+(historyDetail(item)?'<p>'+escape(historyDetail(item))+'</p>':'')+'</div></div>').join(''):'<p class="dialog-tip">这是旧版记录，没有保存此前的操作时间。后续修改、完成和改期会在这里留下历史。</p>')+'</div>');
  }

  function showKey() {
    openDialog('<div class="dialog-eyebrow">THE LANGUAGE OF YOUR JOURNAL</div><h2 class="dialog-title">符号索引 · Key</h2><p class="dialog-description">一个符号，一眼就懂。让每一条记录都有自己的位置。</p><table class="key-table"><tbody>' +
      [['•','待办任务','需要行动的事'],['×','已完成','任务已经完成'],['○','事件','计划或已经发生的事情'],['–','笔记','想法、事实与观察'],['>','已迁移','同一任务换到其他页面，保留进展'],['<','已安排到未来','选择明天或之后的日期'],['*','重要','叠加在条目类型旁'],['!','灵感','值得记住的想法']].map(row => '<tr>'+row.map(cell=>'<td>'+escape(cell)+'</td>').join('')+'</tr>').join('') +
      '</tbody></table><p class="dialog-tip">快速输入：<b>o 空格</b> 为事件，<b>- 空格</b> 为笔记，<b>• 空格</b> 为任务。<br>开头输入 <b>*</b> 或 <b>!</b> 添加标记，两种标记可叠加。<br>任务进行中仍用 •，完成用 ×；事件始终保留 ○，状态另行显示。<br>划掉的记录保留删除线，随时可以恢复。</p>');
  }
  function resetSearch() { searchQuery='';searchOpen=false;$('#search-input').value='';$('#search-wrap').hidden=true; }
  function download(content,name,type='text/plain;charset=utf-8') {
    const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),anchor=document.createElement('a');
    anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function exportNotes() {
    const pages=new Map();entries.forEach(entry=>{const key=locationLabel(entry);if(!pages.has(key))pages.set(key,[]);pages.get(key).push(entry);});
    let markdown='# 拾页 · 子弹笔记\n\n• 任务 / × 完成 / ○ 事件 / – 笔记 / > 迁移 / < 未来安排 / * 重要 / ! 灵感\n\n';
    pages.forEach((items,label)=>{
      markdown+='## '+label+'\n\n';
      items.forEach(entry=>{
        const current=Core.taskFor(entries,entry),target=entry.target?currentEntry(entry.target):null;
        markdown+=(entry.priority?'* ':'')+(entry.inspiration?'! ':'')+entrySymbol(entry)+' '+(entry.status==='cancelled'?'~~'+entry.text+'~~':entry.text)+(target?' → '+locationLabel(target):'')+'\n';
        if(current.plannedDate)markdown+='  计划：'+dateTimeText(current.plannedDate,current.plannedTime)+'\n';
        if(current.dueDate)markdown+='  截止：'+dateTimeText(current.dueDate,current.dueTime)+'\n';
        if(current.startedAt)markdown+='  开始：'+stampText(current.startedAt)+'\n';
        if(current.taskState==='completed')markdown+='  完成：'+(current.completedAt?stampText(current.completedAt)+(Core.isLate(current)?'（逾期完成）':''):'旧版未记录时间')+'\n';
        if(entry.type==='event')markdown+='  事件状态：'+eventTiming(entry)+(entry.occurredAt?'；标记于 '+stampText(entry.occurredAt):'')+'\n';
        if(entry.memo)markdown+='  事件记录：'+entry.memo+'\n';
        markdown+='\n';
      });
    });
    download(markdown,'拾页-'+TODAY+'.md','text/markdown;charset=utf-8');notify('已导出符号、时间和任务状态。');
  }
  async function exportBackup() {
    const data=engine?await engine.backup():{version:2,exportedAt:new Date().toISOString(),entries};
    download(JSON.stringify(data,null,2),'拾页-完整备份-'+TODAY+'.json','application/json;charset=utf-8');
    notify('已导出记录、历史、待同步操作和冲突草稿。');
  }


  $('#search-toggle').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
  $$('.nav-item').forEach(button=>button.addEventListener('click',()=>{view=button.dataset.view;collection=button.dataset.collection||collection;filter='all';resetSearch();render();}));
  $('.brand').addEventListener('click',event=>{event.preventDefault();setDate(TODAY);});
  $('#week-strip').addEventListener('click',event=>{const button=event.target.closest('[data-date]');if(button)setDate(button.dataset.date);});
  $('#calendar-grid').addEventListener('click',event=>{const button=event.target.closest('[data-date]');if(button)setDate(button.dataset.date);});
  function stepPage(offset){
    if(view==='monthly'){const date=dateObject(selectedDate);date.setDate(1);date.setMonth(date.getMonth()+offset);selectedDate=dateString(date);calendarMonth=monthKey(selectedDate);render();}
    else setDate(offsetDate(selectedDate,offset));
  }
  $('#prev-day').onclick=()=>stepPage(-1);$('#next-day').onclick=()=>stepPage(1);
  $('#today-button').onclick=()=>{if(view==='monthly'){selectedDate=TODAY;calendarMonth=monthKey(TODAY);render();}else setDate(TODAY);};
  function changeMonth(offset){const value=dateObject(calendarMonth+'-01');value.setMonth(value.getMonth()+offset);calendarMonth=monthKey(dateString(value));renderCalendar();}
  $('#prev-month').onclick=()=>changeMonth(-1);$('#next-month').onclick=()=>changeMonth(1);
  $('#filters').addEventListener('click',event=>{const button=event.target.closest('[data-filter]');if(button){filter=button.dataset.filter;render();}});
  $('#type-selector').addEventListener('click',event=>{const button=event.target.closest('[data-type]');if(button){updateEntryType(button.dataset.type);$('#entry-input').focus();}});
  $('#composer-symbol').onclick=()=>{const types=['task','event','note'];updateEntryType(types[(types.indexOf(entryType)+1)%3]);$('#entry-input').focus();};
  $('#entry-input').addEventListener('input',()=>{const raw=$('#entry-input').value;const match=/^([•○oO–-])\s+$/.exec(raw);if(match){updateEntryType(['○','o','O'].includes(match[1])?'event':['–','-'].includes(match[1])?'note':'task');$('#entry-input').value='';}});
  $('#composer').addEventListener('submit',addEntry);
  $('#entry-list').addEventListener('click',event=>{const button=event.target.closest('[data-action]'),row=event.target.closest('[data-id]');if(!button||!row)return;const entry=entries.find(item=>item.id===row.dataset.id);if(!entry)return;if(button.dataset.action==='edit')showEdit(entry);else if(button.dataset.action==='destination'){const target=entries.find(item=>item.id===entry.target);if(target)jumpTo(target);}else showActions(entry);});
  $('#review-list').addEventListener('click',event=>{const button=event.target.closest('[data-review]');if(button){const entry=currentEntry(button.dataset.review);if(entry)showActions(entry);}if(event.target.closest('[data-open-tracking]')){view='tracking';trackingFilter='pending';filter='all';resetSearch();render();}});
  $('#event-agenda').addEventListener('click',event=>{const button=event.target.closest('[data-agenda]');if(button){const entry=currentEntry(button.dataset.agenda);if(entry)showActions(entry);}});
  $('#tracking-tabs').addEventListener('click',event=>{const button=event.target.closest('[data-tracking]');if(button){trackingFilter=button.dataset.tracking;filter=trackingFilter==='events'?'all':filter;render();}});
  $('#backup').onclick=exportBackup;
  $('#download-recovery').onclick=()=>{if(recoveryRaw)download(recoveryRaw,'拾页-原始数据备份-'+TODAY+'.json','application/json;charset=utf-8');else exportBackup();};
  ['#open-key','#below-key','#aside-key'].forEach(selector=>$(selector).onclick=showKey);
  $('#action-dialog').addEventListener('click',event=>{if(event.target===$('#action-dialog')){const rect=$('#action-dialog').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeDialog();}});
  $('#search-toggle').onclick=()=>{searchOpen=!searchOpen;$('#search-wrap').hidden=!searchOpen;if(searchOpen)$('#search-input').focus();else{resetSearch();render();}};
  $('#search-close').onclick=()=>{resetSearch();render();};
  $('#search-input').addEventListener('input',()=>{searchQuery=$('#search-input').value.trim();render();});
  $('#export').onclick=exportNotes;
  function refreshClock(){
    const fresh=Core.getToday();
    if(fresh!==TODAY){const previous=TODAY;TODAY=fresh;if(view==='daily' && selectedDate===previous){selectedDate=fresh;calendarMonth=monthKey(fresh);}render();return;}
    renderEntries();renderReview();
  }
  window.addEventListener('focus',refreshClock);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshClock();});
  setInterval(refreshClock,30000);
  render();document.body.inert=true;document.body.setAttribute('aria-busy','true');$('#save-label').textContent='正在恢复本地笔记…';
  $('#import-backup').onclick=()=>$('#backup-file').click();
  $('#backup-file').onchange=async event=>{
    const file=event.target.files[0];if(!file)return;
    try{const text=await file.text();if(text.length>5000000)throw new Error('备份过大，请分批导入。');const data=JSON.parse(text);const result=await engine.importEntries(Array.isArray(data)?data:data.entries);notify('已导入 '+result.added+' 项，跳过 '+result.skipped+' 项已有记录。');}
    catch(error){notify(error.message);}finally{event.target.value='';}
  };
  if(!persistFailed){
    try{
      let deviceId;try{deviceId=localStorage.getItem('shiye.device-id')||uid();localStorage.setItem('shiye.device-id',deviceId);}catch{deviceId=uid();}
      engine=new window.JournalSync.Engine({deviceId,onChange:fresh=>{entries=window.JournalSyncModel.visible(fresh);render();mirrorLegacy();syncUI?.status();},onStatus:status=>syncUI?.status(status)});
      await engine.init(entries);
      syncUI=new window.JournalSyncUI(engine,window.JOURNAL_CONFIG||{mode:'local'},notify);syncUI.status();
      await syncUI.init().catch(error=>engine.problem(error));
      $('.prototype-tag').textContent='PWA';
      if('serviceWorker' in navigator && window.isSecureContext)navigator.serviceWorker.register('./service-worker.js').catch(()=>notify('离线页面尚未就绪；本地笔记仍正常保存。'));
    }catch(error){persistFailed=true;render();notify('本地数据库无法打开，请先导出备份：'+error.message);}
  }
  bootReady=true;document.body.inert=false;document.body.removeAttribute('aria-busy');
  if(persistFailed)notify('现有数据暂时无法安全读取，原始内容未被覆盖；请先备份。');

})();
