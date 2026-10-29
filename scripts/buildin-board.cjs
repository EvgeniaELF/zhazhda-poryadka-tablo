'use strict';
// Read-only Buildin export. Only the existing BOARD_DATA literal is replaced.
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const API = 'https://api.buildin.ai/v2';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ANCHOR = Date.UTC(2026, 6, 6);
const DAY = 86400000;
const ASSETS = ['author.webp','checkpoints.webp','elf-checklist-finish.png','elf.webp','favicon.svg','finish-flag.webp','helmet.webp','logo-compact-color.svg','logo-horizontal-color.svg','logo-horizontal-reverse.svg','logo-mark-micro-color.svg','season-trophy-elf.png','start-flag.webp','track.webp'];
class SafeError extends Error {}
const fail = message => { throw new SafeError(message); };
const normalize = s => String(s).normalize('NFC').trim().replace(/\s+/gu,' ');
function boardPart(html) {
  const start = html.indexOf('    const BOARD_DATA = ');
  const end = html.indexOf('\n\n    const SEASON_TROPHY_ELF', start);
  if (start < 0 || end < 0 || html.indexOf('    const BOARD_DATA = ',start+1) >= 0) fail('Не найден единственный блок BOARD_DATA.');
  const literal = html.slice(start,end).replace(/^    const BOARD_DATA = /,'').trim().replace(/;$/,'');
  let board;
  try { board = JSON.parse(JSON.stringify(vm.runInNewContext('('+literal+')',Object.create(null),{timeout:500}))); }
  catch { fail('Не удалось прочитать исходные данные табло.'); }
  if (!Array.isArray(board.members) || !Array.isArray(board.rounds) || !Array.isArray(board.seasons)) fail('Неизвестная структура табло.');
  return {start,end,board};
}
function field(schema,name,types) {
  const entries = Object.entries(schema.properties || {}).filter(([k,v])=>normalize(v.name || k)===name);
  if (entries.length!==1 || !types.includes(entries[0][1].type)) fail('Проверь тип свойства «'+name+'» в Buildin.');
  const [key,value]=entries[0]; return {key,...value};
}
function value(page,f) {
  const result=Object.values(page.properties || {}).find(p=>p?.id && p.id===f.id) || page.properties?.[f.key] || page.properties?.[f.name];
  if (!result || result.type && result.type!==f.type) fail('В записи отсутствует ожидаемое свойство «'+(f.name || f.key)+'».');
  return result;
}
function title(page,f) {
  const v=value(page,f).title;
  if (!Array.isArray(v)) fail('Участник должен содержать текст.');
  return normalize(v.map(x=>x.plain_text ?? x.text?.content ?? '').join(''));
}
function pageId(page) {
  if (page?.object!=='page' || !UUID.test(page.id)) fail('Buildin вернул некорректную запись.');
  return page.id.toLowerCase();
}
function schemas(source,events,config) {
  const sf={title:field(source,'Участник',['title']),status:field(source,'Статус',['select','status'])};
  const ef={title:field(events,'Участник',['title']),round:field(events,'Круг',['number']),kind:field(events,'Событие',['select']),person:field(events,'Карточка участника',['relation'])};
  if (ef.person.relation?.database_id && ef.person.relation.database_id.toLowerCase()!==config.participantsDatabaseId) fail('«Карточка участника» связана с другой базой.');
  return {sf,ef};
}
function currentCalendar(board, now) {
  const iso = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const today=Date.parse(iso+'T00:00:00Z');
  const current=1+Math.floor((today-ANCHOR)/(7*DAY));
  const season=board.seasons.find(s=>current>=s.firstRound && current<=s.lastRound);
  if (!season) fail('Для текущего круга ещё не настроен сезон. Публикация остановлена.');
  const numbers=new Set(board.rounds.map(r=>r.number));
  if (numbers.size!==board.rounds.length) fail('В исходном табло повторяется номер круга.');
  const endLabel = date => new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',day:'numeric',month:'long'}).format(date);
  for (let n=1;n<=current;n++) {
    if (!numbers.has(n)) {
      const start=new Date(ANCHOR+(n-1)*7*DAY), end=new Date(+start+5*DAY);
      board.rounds.push({number:n,dates:endLabel(start)+' – '+endLabel(end),endDate:end.toISOString().slice(0,10),updated:'пока нет',status:'active',marks:{}});
    }
  }
  board.rounds.sort((a,b)=>a.number-b.number);
  board.rounds.forEach(r=>{r.status=r.number<current?'closed':r.number===current?'active':'future';});
  board.selectedRound=current;board.selectedSeason=season.number;
  return current;
}
function mergeBoard(base, sourceRows, eventRows, sourceSchema, eventSchema, config, now=new Date()) {
  const board=structuredClone(base), {sf,ef}=schemas(sourceSchema,eventSchema,config);
  const current=currentCalendar(board,now), members=new Map();
  const cardIds=new Set();
  for (const member of board.members) {
    const name=normalize(member.name);
    if (!name || members.has(name)) fail('В табло неоднозначные имена участников.');
    if(!/^p[0-9]{2,5}$/.test(member.cardId || '') || cardIds.has(member.cardId)) fail('В исходном табло нужен уникальный постоянный cardId каждого участника.');
    cardIds.add(member.cardId);
    members.set(name,member);
  }
  const source=new Map(), byName=new Map();
  for (const row of sourceRows) {
    const id=pageId(row);if(row.in_trash || row.archived) continue;
    const name=title(row,sf.title);
    if (!name || byName.has(name) || source.has(id)) fail('В источнике неоднозначные имена или повторные записи.');
    const member=members.get(name);
    if (!member) fail('В Buildin найден новый участник. Сначала добавь его профиль в исходное табло.');
    const v=value(row,sf.status), status=v.select?.name ?? v.status?.name;
    if (!['На треке','На пит-стопе'].includes(status)) fail('Неизвестный статус участника.');
    const pit=(member.trackPauses || []).some(p=>p.pausedAt && !p.resumedAt);
    if ((status==='На пит-стопе')!==pit) fail('Статус Buildin отличается от истории пит-стопов табло. Сначала согласуй даты паузы/возвращения.');
    const item={id,name,member};source.set(id,item);byName.set(name,item);
  }
  if (!source.size || source.size!==members.size) fail('Состав Buildin и табло не совпадает. История не заменена.');
  const report={version:'1.1.0',checkedAt:now.toISOString(),participants:source.size,sourceEvents:0,uniqueMarks:0,duplicates:0,legacyNameMatches:0,added:[],events:[],preservedHistory:true};
  const seen=new Set();
  for (const row of eventRows) {
    pageId(row);if(row.in_trash || row.archived) continue;
    report.sourceEvents++;
    const round=value(row,ef.round).number,kind=value(row,ef.kind).select?.name;
    if (!Number.isInteger(round) || round<1 || round>current || !['Старт','Финиш'].includes(kind)) fail('Есть событие с неизвестным типом или некорректным кругом.');
    const relation=value(row,ef.person);
    if (!Array.isArray(relation.relation) || relation.has_more || relation.relation.length>1) fail('Событие должно однозначно указывать на одного участника.');
    let person;
    if (relation.relation.length) {
      const ref=relation.relation[0]?.id;
      if (!UUID.test(ref || '')) fail('Некорректная связь события.');
      person=source.get(ref.toLowerCase());
    } else {
      person=byName.get(title(row,ef.title));report.legacyNameMatches++;
    }
    if (!person) fail('Событие ссылается на неизвестного участника.');
    if ((person.member.joinedRound || 1)>round) fail('Событие предшествует первому кругу участника.');
    report.events.push({key:eventKey(row.id),cardId:person.member.cardId,round,event:kind});
    const key=person.id+':'+round+':'+kind;
    if (seen.has(key)) {report.duplicates++;continue;}seen.add(key);report.uniqueMarks++;
    const r=board.rounds.find(x=>x.number===round), old=r.marks[person.member.name] || {};
    if (old.pit || old.skip || old.startIcon) fail('Событие конфликтует с особой исторической отметкой. Нужна ручная сверка.');
    const flag=kind==='Старт'?'entered':'finished';
    if (!old[flag]) report.added.push({participant:person.member.name,round,event:kind});
    const mark={entered:false,finished:false,pit:false,late:false,...old,[flag]:true};
    mark.lastMark=mark.entered&&mark.finished?'Старт и финиш '+round+'-го круга отмечены. Оба чек-поинта круга приняты.':mark.finished?'Финиш '+round+'-го круга отмечен.':'Заезд на '+round+'-й круг отмечен.';
    r.marks[person.member.name]=mark;
    if (!old[flag]) r.updated=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric'}).format(now).replace(/ г\.$/,'');
  }
  return {board,report};
}
function client(token,fetchImpl=fetch,sleep=delay) {
  if (!token || /[\r\n]/.test(token)) fail('Добавь закрытый секрет BUILDIN_API_TOKEN в GitHub Actions.');
  return async function request(route,body) {
    if (!/^\/databases\/[a-f0-9-]{36}(?:\/query)?$/.test(route)) fail('Запрещённый путь запроса.');
    for(let attempt=0;attempt<3;attempt++) {
      let response;
      try {response=await fetchImpl(API+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(12000),...(body?{body:JSON.stringify(body)}:{})});}
      catch {if(attempt<2){await sleep(1000*(attempt+1));continue;}fail('Нет соединения с Buildin. Предыдущая публикация сохранена.');}
      if ((response.status===429 || response.status>=500) && attempt<2) {const seconds=Number(response.headers.get('retry-after'));await response.body?.cancel();await sleep(Math.min(30,Math.max(1,Number.isFinite(seconds)?seconds:attempt+1))*1000);continue;}
      if (!response.ok) fail('Buildin HTTP '+response.status+'. Проверь доступ интеграции к обеим базам.');
      try {const text=await response.text();if(text.length>5*1024*1024) fail('Ответ Buildin превышает лимит.');return JSON.parse(text);}
      catch(error) {if(error instanceof SafeError)throw error;fail('Buildin вернул некорректный JSON.');}
    }
  };
}
async function queryAll(request,id) {
  let cursor;const rows=[],cursors=new Set();
  for(let n=0;n<100;n++) {
    const data=await request('/databases/'+id+'/query',{page_size:100,...(cursor?{start_cursor:cursor}:{})});
    if(data.object!=='list' || !Array.isArray(data.results) || typeof data.has_more!=='boolean') fail('Неполный ответ списка Buildin.');
    rows.push(...data.results);
    if (!data.has_more) return rows;
    cursor=data.next_cursor;
    if(typeof cursor!=='string' || !cursor || cursors.has(cursor))fail('Некорректная пагинация Buildin.');
    cursors.add(cursor);
  }
  fail('Превышен предел чтения таблицы.');
}
function inject(html,board) {
  const {start,end}=boardPart(html);
  const json=JSON.stringify(board,null,2).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  return html.slice(0,start)+'    const BOARD_DATA = '+json+';'+html.slice(end);
}
function eventKey(id) {
  if(!UUID.test(id || ''))fail('Некорректный ID события.');
  return createHash('sha256').update('zhazhda-poryadka:event:v1:'+id.toLowerCase()).digest('hex');
}
function publication(env=process.env) {
  if(!env.GITHUB_RUN_ID)return null;
  if(!/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID) || !/^[1-9]\d{0,4}$/.test(env.GITHUB_RUN_ATTEMPT || '') || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || ''))fail('Некорректный номер публикации GitHub.');
  return {runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT,sha:env.GITHUB_SHA};
}
function publicManifest(board,report,release) {
  return {schema:1,publication:release,members:board.members.map(p=>({cardId:p.cardId,name:p.name})),events:report.events};
}
async function run(root=process.cwd()) {
  const config=JSON.parse(await fs.readFile(path.join(root,'buildin-sync.json'),'utf8'));
  if(!UUID.test(config.participantsDatabaseId) || !UUID.test(config.eventsDatabaseId) || config.participantsDatabaseId===config.eventsDatabaseId) fail('Неверные ID двух баз.');
  const html=await fs.readFile(path.join(root,'index.html'),'utf8');
  const request=client(process.env.BUILDIN_API_TOKEN);
  // Sequential bounded requests avoid bursts against the provider.
  const sourceSchema=await request('/databases/'+config.participantsDatabaseId);
  const eventSchema=await request('/databases/'+config.eventsDatabaseId);
  if(sourceSchema.object!=='database' || eventSchema.object!=='database' || sourceSchema.id?.toLowerCase()!==config.participantsDatabaseId || eventSchema.id?.toLowerCase()!==config.eventsDatabaseId) fail('Buildin вернул неизвестную схему.');
  const sourceRows=await queryAll(request,config.participantsDatabaseId);
  const eventRows=await queryAll(request,config.eventsDatabaseId);
  const {board,report}=mergeBoard(boardPart(html).board,sourceRows,eventRows,sourceSchema,eventSchema,config);
  const release=publication();
  if(release)board.publication=release;
  const out=path.join(root,'_site');await fs.rm(out,{recursive:true,force:true});await fs.mkdir(out,{recursive:true});
  for(const asset of ASSETS) {
    const src=path.join(root,asset);const stat=await fs.lstat(src);
    if(!stat.isFile() || stat.isSymbolicLink()) fail('Не найден безопасный ресурс оформления: '+asset);
    await fs.copyFile(src,path.join(out,asset));
  }
  const published=inject(html,board);
  const marker=release?'<meta name="tablo-publication" content="'+release.runId+'.'+release.runAttempt+'.'+release.sha+'">':'';
  await fs.writeFile(path.join(out,'index.html'),published.replace('</head>',marker+'\n</head>'));
  const linkScript=path.join(root,'personal-links.js'),linkStat=await fs.lstat(linkScript);
  if(!linkStat.isFile()||linkStat.isSymbolicLink())fail('Не найден безопасный скрипт персональных ссылок.');
  await fs.copyFile(linkScript,path.join(out,'personal-links.js'));
  await fs.writeFile(path.join(out,'cards.json'),JSON.stringify(publicManifest(board,report,release))+'\n');
  await fs.writeFile(path.join(root,'sync-report.json'),JSON.stringify(report,null,2)+'\n');
  const summary='## Проверка Buildin → табло\n\nУчастников: '+report.participants+'. Событий: '+report.sourceEvents+'. Уникальных отметок: '+report.uniqueMarks+'. Повторов в базе: '+report.duplicates+'.\n\nНовых отметок относительно исходного табло: '+report.added.length+'. Старых сопоставлений по уникальному имени: '+report.legacyNameMatches+'.\n\nСтарые сезоны, даты выхода на трек и пит-стопы сохранены. Проверка только читает Buildin. Удаления и исправления исходных исторических отметок требуют отдельной сверки.\n';
  await fs.writeFile(path.join(root,'sync-report.md'),summary);
  if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,summary);
  console.log('Проверка завершена: '+report.participants+' участников, '+report.uniqueMarks+' отметок. Подробности: sync-report.json.');
}
module.exports={boardPart,mergeBoard,queryAll,client,inject,SafeError,run,currentCalendar,eventKey,publication,publicManifest};
if(require.main===module)run().catch(error=>{console.error(error instanceof SafeError?error.message:'Не удалось собрать табло. Секреты и ответы API не выводятся.');process.exitCode=1;});
