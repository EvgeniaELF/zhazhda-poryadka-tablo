'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {boardPart,mergeBoard,queryAll,client,inject,currentCalendar,run}=require('../scripts/buildin-board.cjs');
const config=require('../buildin-sync.json');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const baseline=boardPart(html).board;
const now=new Date('2026-10-28T23:30:00Z');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const prop=(type,data)=>({type,[type]:data});
const text=name=>[{plain_text:name}];
const sourceSchema={properties:{Участник:{type:'title'},Статус:{type:'select'}}};
const eventSchema={properties:{Участник:{type:'title'},Круг:{type:'number'},Событие:{type:'select'},'Карточка участника':{type:'relation',relation:{database_id:config.participantsDatabaseId}}}};
function rows(){return baseline.members.map((m,i)=>({object:'page',id:id(i+1),properties:{Участник:prop('title',text(m.name)),Статус:prop('select',{name:(m.trackPauses||[]).some(p=>!p.resumedAt)?'На пит-стопе':'На треке'})}}));}
function event(name,round,kind,extra={}){const i=baseline.members.findIndex(m=>m.name===name);return {object:'page',id:id(100+round+(kind==='Старт'?0:100)),properties:{Участник:prop('title',text(name)),Круг:prop('number',round),Событие:prop('select',{name:kind}),'Карточка участника':prop('relation',[{id:id(i+1)}])},...extra};}
const merge=(events=[],source=rows(),board=baseline)=>mergeBoard(board,source,events,sourceSchema,eventSchema,config,now);
test('пустая база событий не стирает 17 кругов и 17 профилей',()=>assert.deepEqual(merge().board,baseline));
test('новый финиш сохраняет старт и все исторические особенности',()=>{const r=merge([event('Настя · болид №28',17,'Финиш')]);assert.equal(r.report.added.length,1);const mark=r.board.rounds[16].marks['Настя · болид №28'];assert.equal(mark.entered,true);assert.equal(mark.finished,true);assert.deepEqual(r.board.members,baseline.members);assert.deepEqual(r.board.rounds.slice(0,16),baseline.rounds.slice(0,16));});
test('два одинаковых события дают одну отметку',()=>{const e=event('Настя · болид №28',17,'Финиш');const r=merge([e,{...e,id:id(999)}]);assert.equal(r.report.duplicates,1);assert.equal(r.report.added.length,1);});
test('оба типа в одном круге учитываются независимо',()=>{const r=merge([event('Болид №7',17,'Старт'),event('Болид №7',17,'Финиш')]);assert.equal(r.report.added.length,2);});
test('старое событие без связи сопоставляется только по уникальному полному имени',()=>{const e=event('Аня',17,'Старт');e.properties['Карточка участника'].relation=[];assert.equal(merge([e]).report.legacyNameMatches,1);});
test('если связь есть, её ID важнее устаревшего заголовка события',()=>{const e=event('Аня',17,'Старт');e.properties.Участник.title=text('старое имя');assert.equal(merge([e]).report.uniqueMarks,1);});
test('чужая связь не подменяется поиском по имени',()=>{const e=event('Аня',17,'Старт');e.properties['Карточка участника'].relation=[{id:id(888)}];assert.throws(()=>merge([e]),/неизвестного участника/);});
test('несколько/неполные связи отклоняются',()=>{const e=event('Аня',17,'Старт');e.properties['Карточка участника'].has_more=true;assert.throws(()=>merge([e]),/однозначно/);});
test('совпадение первых имён не объединяет участников',()=>{const r=merge([event('Аня',17,'Финиш')]);assert.equal(r.board.rounds[16].marks['Аня'].finished,true);assert.equal(r.board.rounds[16].marks['Аня · болид №22'],undefined);});
test('потеря/добавление/переименование участника останавливают сборку',()=>{assert.throws(()=>merge([],rows().slice(1)),/не совпадает/);const s=rows();s[0].properties.Участник.title=text('Новое имя');assert.throws(()=>merge([],s),/новый участник/);});
test('дубли в источнике не допускаются',()=>assert.throws(()=>merge([],[...rows(),rows()[0]]),/неоднозначные/));
test('изменение статуса требует точных дат паузы, а не догадки по времени запуска',()=>{const s=rows();s[0].properties.Статус.select.name='На пит-стопе';assert.throws(()=>merge([],s),/пит-стопов/);});
test('исторические даты 26 июля, 2 августа, 11 августа не меняются',()=>{const b=merge().board;for(const [name,date] of [['Ира · болид №8','2026-07-26'],['Таня · болид №11','2026-08-02'],['Юля · болид №17','2026-08-11']])assert.equal(b.members.find(m=>m.name===name).firstReport,date);});
test('будущий круг, тип и круг до участия не публикуются',()=>{assert.throws(()=>merge([event('Аня',18,'Старт')]),/некорректным кругом/);assert.throws(()=>merge([event('Аня',17,'Удалить')]),/неизвестным типом/);assert.throws(()=>merge([event('Настя · болид №28',1,'Старт')]),/предшествует/);});
test('особая отметка не затирается обычным стартом',()=>{const b=structuredClone(baseline);b.rounds[16].marks.Аня={skip:true};assert.throws(()=>merge([event('Аня',17,'Старт')],rows(),b),/особой исторической/);});
test('удалённое событие не добавляется; история из базового файла остаётся',()=>assert.equal(merge([event('Аня',17,'Финиш',{in_trash:true})]).report.uniqueMarks,0));
test('следующий понедельник открывает круг18, даты/сезон совпадают',()=>{const b=structuredClone(baseline);currentCalendar(b,new Date('2026-11-01T21:00:00Z'));assert.equal(b.selectedRound,18);assert.equal(b.selectedSeason,2);assert.equal(b.rounds.at(-1).endDate,'2026-11-07');assert.equal(b.rounds[16].status,'closed');});
test('неизвестный будущий сезон требует подготовки',()=>assert.throws(()=>currentCalendar(structuredClone(baseline),new Date('2027-01-01Z')),/настроен сезон/));
test('экспорт не исполняет текст участника как HTML/script',()=>{const b=structuredClone(baseline);b.members[0].name='</script><script>alert(1)</script>';const exported=inject(html,b);assert.ok(!exported.includes('"</script><script>alert(1)</script>"'));assert.deepEqual(boardPart(exported).board,b);});
test('HTML вне блока данных остаётся побайтно тем же',()=>{const p=boardPart(html),out=inject(html,baseline),q=boardPart(out);assert.equal(html.slice(0,p.start),out.slice(0,q.start));assert.equal(html.slice(p.end),out.slice(q.end));});
test('пагинация читает все страницы',async()=>{const calls=[];const all=await queryAll(async(p,b)=>{calls.push(b);return b.start_cursor?{object:'list',results:[2],has_more:false}:{object:'list',results:[1],has_more:true,next_cursor:'next'};},config.eventsDatabaseId);assert.deepEqual(all,[1,2]);assert.equal(calls[1].start_cursor,'next');});
test('повторный курсор/неполный список останавливают чтение',async()=>{await assert.rejects(queryAll(async()=>({object:'list',results:[],has_more:true,next_cursor:'same'}),config.eventsDatabaseId),/пагинация/);await assert.rejects(queryAll(async()=>({results:[]}),config.eventsDatabaseId),/Неполный/);});
test('API читает только fixed HTTPS host, без переходов и с проверкой TLS по умолчанию',async()=>{const calls=[];await client('test-local',async(u,o)=>{calls.push([u,o]);return {ok:true,text:async()=>'{}'};})(`/databases/${config.eventsDatabaseId}`);assert.equal(calls[0][0],'https://api.buildin.ai/v2/databases/'+config.eventsDatabaseId);assert.equal(calls[0][1].redirect,'error');assert.equal(calls[0][1].method,'GET');assert.equal(calls[0][1].headers.Authorization,'Bearer test-local');await assert.rejects(client('test-local')('/pages/anything'),/Запрещённый/);});
test('сбой/403 не выводят тело с секретами',async()=>{await assert.rejects(client('local-secret',async()=>({status:403,ok:false,text:async()=>'local-secret'}))('/databases/'+config.eventsDatabaseId),e=>e.message.includes('403')&&!e.message.includes('local-secret'));});
test('429 повторяется ограниченно, после него читается JSON',async()=>{let calls=0;const sleeps=[];const r=await client('test-local',async()=>++calls===1?{status:429,headers:new Headers({'retry-after':'2'}),body:{cancel:async()=>{}}}:{ok:true,text:async()=>'{}'},async(ms)=>sleeps.push(ms))('/databases/'+config.eventsDatabaseId);assert.deepEqual(r,{});assert.deepEqual(sleeps,[2000]);});
test('полная сборка выпускает только HTML и публичные ресурсы, не код/ключи/ID',async()=>{
  const fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'board-export-'));
  const oldFetch=global.fetch,oldToken=process.env.BUILDIN_API_TOKEN,oldSummary=process.env.GITHUB_STEP_SUMMARY;
  const oldRelease=Object.fromEntries(['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA'].map(k=>[k,process.env[k]]));
  try {
    const repo=path.join(__dirname,'..');
    await fsp.copyFile(path.join(repo,'index.html'),path.join(dir,'index.html'));
    await fsp.copyFile(path.join(repo,'buildin-sync.json'),path.join(dir,'buildin-sync.json'));
    await fsp.copyFile(path.join(repo,'personal-links.js'),path.join(dir,'personal-links.js'));
    for(const asset of await fsp.readdir(repo))if(/\.(webp|svg|png)$/.test(asset))await fsp.copyFile(path.join(repo,asset),path.join(dir,asset));
    process.env.BUILDIN_API_TOKEN='local-secret-do-not-export';delete process.env.GITHUB_STEP_SUMMARY;
    Object.assign(process.env,{GITHUB_RUN_ID:'98765',GITHUB_RUN_ATTEMPT:'2',GITHUB_SHA:'a'.repeat(40)});
    const events=[event('Настя · болид №28',17,'Старт'),event('Аня',17,'Старт'),event('Настя · болид №28',16,'Финиш'),event('Настя · болид №28',16,'Старт'),event('Лена · болид №10',16,'Старт'),event('Лена · болид №10',15,'Финиш')];
    global.fetch=async(url,options)=>{
      assert.ok(['GET','POST'].includes(options.method));
      const isSource=url.includes(config.participantsDatabaseId),query=url.endsWith('/query');
      const data=query?{object:'list',results:isSource?rows():events,has_more:false}:{object:'database',id:isSource?config.participantsDatabaseId:config.eventsDatabaseId,...(isSource?sourceSchema:eventSchema)};
      return {ok:true,text:async()=>JSON.stringify(data)};
    };
    await run(dir);
    const built=await fsp.readFile(path.join(dir,'_site/index.html'),'utf8');
    assert.equal(boardPart(built).board.members.length,17);
    assert.equal(JSON.parse(await fsp.readFile(path.join(dir,'sync-report.json'),'utf8')).uniqueMarks,6);
    assert.ok(!built.includes('local-secret-do-not-export'));
    assert.ok(!built.includes(config.participantsDatabaseId));
    assert.ok(!built.includes(config.eventsDatabaseId));
    assert.ok(built.includes('<meta name="tablo-publication" content="98765.2.'+'a'.repeat(40)+'">'));
    const manifest=JSON.parse(await fsp.readFile(path.join(dir,'_site/cards.json'),'utf8'));
    assert.deepEqual(manifest.publication,{runId:'98765',runAttempt:'2',sha:'a'.repeat(40)});
    assert.equal(manifest.events.length,6);
    for(const record of events)assert.ok(!JSON.stringify(manifest).includes(record.id));
    for(const code of built.matchAll(/<script>([\s\S]*?)<\/script>/g))new (require('node:vm').Script)(code[1]);
    const files=await fsp.readdir(path.join(dir,'_site'));
    assert.equal(files.length,17);assert.ok(files.every(p=>['index.html','cards.json','personal-links.js'].includes(p)||/\.(svg|png|webp)$/.test(p)));
    assert.equal(await fsp.readFile(path.join(dir,'index.html'),'utf8'),html);
  } finally {
    global.fetch=oldFetch;
    if(oldToken===undefined)delete process.env.BUILDIN_API_TOKEN;else process.env.BUILDIN_API_TOKEN=oldToken;
    if(oldSummary===undefined)delete process.env.GITHUB_STEP_SUMMARY;else process.env.GITHUB_STEP_SUMMARY=oldSummary;
    for(const [key,val] of Object.entries(oldRelease)){if(val===undefined)delete process.env[key];else process.env[key]=val;}
    await fsp.rm(dir,{recursive:true,force:true});
  }
});
