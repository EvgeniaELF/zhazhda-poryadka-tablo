'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {txt,core,management,links,participation,config,html,base,initialTime,rows,row,approve,event,sourceSchema,eventSchema,merge,id}=require('./fixtures/participants.cjs');
test('первый перенос сохраняет все 17 личных ссылок, даты, историю и особые отметки',()=>{
  const r=merge();assert.deepEqual(r.board.members,base.members);assert.deepEqual(r.board.rounds.slice(0,17).map(x=>x.marks),base.rounds.map(x=>x.marks));
  assert.equal(r.state.bindings.length,17);assert.match(r.report.bootstrapDigest,/^[a-f0-9]{64}$/);assert.equal(r.state.revision,1);
  management.validateState(r.state,base);
  for(const row of rows())assert.ok(!JSON.stringify(r.state).includes(row.id));
});
test('перестановка строк Buildin не меняет первое сопоставление',()=>assert.equal(merge().report.bootstrapDigest,merge(rows().reverse()).report.bootstrapDigest));
test('повторный одинаковый запуск не создаёт новую ревизию',()=>{const a=merge();const b=merge(rows(),[],a.state);assert.deepEqual(b.state,a.state);});
test('незаполненная новая карточка остаётся черновиком',()=>{
  const draft=row(30,'');draft.properties.Статус.select=null;
  const r=merge([...rows(),draft]);assert.equal(r.board.members.length,17);assert.equal(r.report.drafts.length,1);
});
test('новая подтверждённая участница получает постоянную ссылку автоматически',()=>{
  const list=[...rows(),row(30,'Аня · болид №33','На треке',{ready:true,firstReport:'2026-11-10',joinedRound:19})];
  const r=merge(list,[event(1,30,19)]),p=r.board.members.at(-1);
  assert.ok(links.validCard(p.cardId));assert.notEqual(p.cardId,'p01');assert.equal(p.joinedRound,19);
  assert.equal(r.board.rounds.at(-1).marks[p.name].entered,true);
  assert.equal(links.resolve(r.board,links.parse(new URL(links.url('https://example.test/',p.cardId,19)).hash)).person.name,p.name);
  const again=merge(list,[event(1,30,19)],r.state);assert.equal(again.board.members.at(-1).cardId,p.cardId);
});
test('дата и круг новой участницы обязательны независимо друг от друга',()=>{
  for(const missing of [{firstReport:null,joinedRound:19},{firstReport:'2026-11-10',joinedRound:null}])assert.throws(()=>merge([...rows(),row(30,'Новая','На треке',{ready:true,...missing})]),/дата|круг/);
});
test('прежние поздние даты не выводят круг присоединения заново',()=>{
  const r=merge(approve(rows(),'p13',{}));const p=r.board.members.find(p=>p.cardId==='p13');assert.equal(p.joinedRound,5);assert.equal(p.firstReport,'2026-08-11');
});
test('подтверждённую дату или круг участия нельзя незаметно переписать',()=>{
  const prior=merge().state;
  assert.throws(()=>merge(approve(rows(),'p04',{joinedRound:2}),[],prior),/уже принятые/);
  assert.throws(()=>merge(approve(rows(),'p04',{firstReport:'2026-07-07'}),[],prior),/уже принятые/);
});
test('дата API со слешами нормализуется, невозможная дата и время отклоняются',()=>{
  const a=approve(rows(),'p04',{firstReport:'2026/07/06'});assert.equal(merge(a).board.members[3].firstReport,'2026-07-06');
  for(const d of ['2026-02-30','2026-11-11T23:00:00Z'])assert.throws(()=>merge([...rows(),row(30,'Новая','На треке',{ready:true,firstReport:d,joinedRound:19})]),/дата|дату/);
});
test('неподтверждённые изменения существующей карточки не меняют опубликованный профиль',()=>{
  const previous=merge().state,list=rows();list[3].properties.Участник.title=txt('Черновое имя');list[3].properties.Статус.select.name='На пит-стопе';
  const r=merge(list,[],previous);assert.equal(r.board.members[3].name,base.members[3].name);assert.equal(r.board.members[3].trackPauses,undefined);
});
test('стабильная связь сохраняет историю и ссылку после переименования',()=>{
  const first=merge(rows(),[event(1,4,19)]),list=approve(rows(),'p04',{});list[3].properties.Участник.title=txt('Женя · болид №09');
  const r=merge(list,[event(1,4,19)],first.state);const p=r.board.members.find(p=>p.cardId==='p04');
  assert.equal(p.name,'Женя · болид №09');
  assert.deepEqual(r.board.rounds[0].marks[p.name],first.board.rounds[0].marks[base.members[3].name]);
  assert.equal(r.board.rounds.at(-1).marks[p.name].entered,true);assert.equal(r.board.rounds[0].marks[base.members[3].name],undefined);
});
test('точно одинаковые публичные подписи отклоняются, тёзки с разными болидами не смешиваются',()=>{
  assert.throws(()=>merge([...rows(),row(30,'Женя','На треке',{ready:true,firstReport:'2026-11-10',joinedRound:19})]),/прежнюю|различаться/);
  const r=merge([...rows(),row(30,'Женя · болид №99','На треке',{ready:true,firstReport:'2026-11-10',joinedRound:19})],[event(1,30,19)]);
  assert.equal(r.board.rounds.at(-1).marks['Женя · болид №99'].entered,true);assert.equal(r.board.rounds.at(-1).marks['Женя'],undefined);
});
test('чужая связь события не заменяется совпадающим именем',()=>{
  const e=event(1,88,19);e.properties.Участник.title=txt(base.members[3].name);
  assert.throws(()=>merge(rows(),[e]),/неизвестной/);
});
test('удаление или пересоздание ранее принятой участницы останавливает публикацию',()=>{
  const prior=merge().state;assert.throws(()=>merge(rows().slice(1),[],prior),/исчезла/);
  const list=rows();list[0].id=id(99);assert.throws(()=>merge(list,[],prior),/исчезла/);
});
test('первый день паузы преобразуется в последний засчитанный день',()=>{
  const list=approve(rows(),'p03',{pauseDate:'2026-11-10',pauseRound:19},'На пит-стопе');
  assert.deepEqual(merge(list).board.members[2].trackPauses,[{pausedAt:'2026-11-09',resumedAt:null,pitStopRound:19}]);
});
test('Аня сохраняет старт 18, паузу с 5 ноября и значок с 19-го круга',()=>{
  const list=approve(rows(),'p01',{pauseDate:'2026-11-05',pauseRound:19});
  const r=merge(list,[event(1,1,18)]),p=r.board.members[0];assert.equal(p.trackPauses[0].pausedAt,'2026-11-04');
  assert.equal(r.board.rounds.find(r=>r.number===18).marks.Аня.entered,true);
  assert.equal(participation.roundState(p,18,r.board.rounds),'track');assert.equal(participation.roundState(p,19,r.board.rounds),'pit');
});
test('полупустой пит-стоп и несовместимый статус не публикуются',()=>{
  for(const data of [{pauseDate:'2026-11-10'},{pauseRound:19},{pauseDate:'2026-11-10',pauseRound:19}])assert.throws(()=>merge(approve(rows(),'p03',data,'На треке')),/дату|круг|статус/);
});
test('возвращение закрывает паузу, следующий пит-стоп сохраняет оба эпизода',()=>{
  const first=merge(approve(rows(),'p03',{pauseDate:'2026-11-10',pauseRound:19},'На пит-стопе'));
  const back=merge(approve(rows(),'p03',{pauseDate:'2026-11-10',pauseRound:19,returnDate:'2026-11-16'},'На треке'),[],first.state,new Date('2026-11-17Z'));
  const nextRows=approve(rows(),'p03',{pauseDate:'2026-11-24',pauseRound:21},'На пит-стопе');
  const next=merge(nextRows,[],back.state,new Date('2026-11-25Z')),p=next.board.members[2];
  assert.equal(p.trackPauses.length,2);assert.equal(p.trackPauses[0].resumedAt,'2026-11-16');assert.equal(p.trackPauses[1].pausedAt,'2026-11-23');
  assert.equal(participation.roundState(p,19,next.board.rounds),'pit');assert.equal(participation.roundState(p,20,next.board.rounds),'track');assert.equal(participation.roundState(p,21,next.board.rounds),'pit');
});
test('вторую паузу нельзя начать, не сохранив возвращение из первой',()=>{
  const first=merge(approve(rows(),'p03',{pauseDate:'2026-11-10',pauseRound:19},'На пит-стопе'));
  assert.throws(()=>merge(approve(rows(),'p03',{pauseDate:'2026-11-24',pauseRound:21},'На пит-стопе'),[],first.state,new Date('2026-11-25Z')),/Сначала сохрани возвращение/);
});
test('сохранённое возвращение и круг паузы не стираются',()=>{
  const first=merge(approve(rows(),'p03',{pauseDate:'2026-11-08',pauseRound:18,returnDate:'2026-11-10'},'На треке'));
  assert.throws(()=>merge(approve(rows(),'p03',{pauseDate:'2026-11-08',pauseRound:18},'На пит-стопе'),[],first.state),/дату возвращения/);
  assert.throws(()=>merge(approve(rows(),'p03',{pauseDate:'2026-11-08',pauseRound:19,returnDate:'2026-11-10'},'На треке'),[],first.state),/круг пит-стопа/);
});
test('новый старт в середине открытой паузы отклоняется, принятый старт сохраняется',()=>{
  const e=event(1,3,19),prior=merge(rows(),[e]);
  const list=approve(rows(),'p03',{pauseDate:'2026-11-10',pauseRound:19},'На пит-стопе');
  assert.equal(merge(list,[e],prior.state).board.rounds.at(-1).marks[base.members[2].name].entered,true);
  assert.throws(()=>merge(list,[e]),/пит-стопа/);
});
test('удаление или изменение принятого события требует сверки',()=>{
  const e=event(1,4,19),prior=merge(rows(),[e]);assert.throws(()=>merge(rows(),[],prior.state),/исчезло/);
  const changed=structuredClone(e);changed.properties.Событие.select.name='Финиш';assert.throws(()=>merge(rows(),[changed],prior.state),/Изменено/);
});
test('дубли отметки считаются один раз, повторный ID отклоняется',()=>{
  const e=event(1,4,19),copy={...e,id:id(3000)};assert.equal(merge(rows(),[e,copy]).report.duplicates,1);
  assert.throws(()=>merge(rows(),[e,e]),/повторил ID/);
});
test('потеря служебной истории или исходных ссылок не маскируется новой миграцией',()=>{
  const state=merge().state;state.board.members.pop();assert.throws(()=>merge(rows(),[],state),/сумма/);
  const valid=merge().state;valid.baseline='0'.repeat(64);assert.throws(()=>merge(rows(),[],valid),/не соответствует/);
});
test('воскресенья считаются, дни двух пауз исключаются, день возвращения включён',()=>{
  const p={firstReport:'2026-11-01',trackPauses:[{pausedAt:'2026-11-04',resumedAt:'2026-11-08'},{pausedAt:'2026-11-09',resumedAt:'2026-11-12'}]};
  assert.equal(participation.daysOnTrack(p,'2026-11-12'),7);assert.equal(participation.daysOnTrack({firstReport:'2026-11-01'},'2026-11-01'),1);
});
test('московская полночь открывает новый круг и сезон без изменения прошлых отметок',()=>{
  const a=structuredClone(base),b=structuredClone(base);core.currentCalendar(a,new Date('2026-12-20T20:59:59Z'));core.currentCalendar(b,new Date('2026-12-20T21:00:00Z'));
  assert.equal(a.selectedRound,24);assert.equal(b.selectedRound,25);assert.equal(b.selectedSeason,3);assert.deepEqual(b.rounds.slice(0,17).map(r=>r.marks),base.rounds.map(r=>r.marks));
  core.currentCalendar(b,new Date('2027-03-14T21:00:00Z'));assert.equal(b.selectedRound,37);assert.equal(b.selectedSeason,4);
});
function uiFunction(name,context){const start=html.indexOf('    function '+name+'(');assert.ok(start>=0);const end=html.indexOf('\n    function ',start+10);return vm.runInNewContext('('+html.slice(start,end).trim()+')',context);}
test('настоящая функция сводки считает итоги только внутри выбранного сезона',()=>{
  const p={name:'Участница',joinedRound:1};
  const board={members:[p],rounds:[{number:12,marks:{Участница:{entered:true,finished:true}}},{number:13,marks:{Участница:{entered:true}}}]};
  const fn=uiFunction('roundSummaryData',{BOARD_DATA:board,seasonForRound:()=>({firstRound:13})});
  const data=fn(board.rounds[1]);assert.equal(data.seasonCheckpoints,1);assert.equal(data.seasonEntered,1);assert.equal(data.seasonFinished,0);
});
test('реальная функция счётчика использует все эпизоды паузы',()=>{
  const p={firstReport:'2026-11-01',trackPauses:[{pausedAt:'2026-11-04',resumedAt:'2026-11-08'},{pausedAt:'2026-11-09',resumedAt:'2026-11-12'}]};
  const fn=uiFunction('daysOnTrack',{Participation:participation,todayUtcInBoardTimeZone:()=>Date.parse('2026-11-12Z')});assert.equal(fn(p),7);
});
test('при первом переносе расхождение статуса с прежней историей требует сверки',()=>{
  const list=rows();list[3].properties.Статус.select.name='На пит-стопе';assert.throws(()=>merge(list),/При первом переносе/);
});
test('возврат в том же круге оставляет исторический знак и возвращает участницу в текущий список',()=>{
  const p={name:'Участница',joinedRound:1,trackPauses:[{pausedAt:'2026-11-23',resumedAt:'2026-11-27',pitStopRound:21}]};
  const round={number:21,marks:{}},board={members:[p],rounds:[round],selectedRound:21};
  assert.equal(participation.roundState(p,21,board.rounds),'pit');
  const fn=uiFunction('selectedParticipants',{BOARD_DATA:board,Participation:participation,selectedRound:()=>round,isOnActivePitStop:m=>(m.trackPauses||[]).some(p=>!p.resumedAt)});
  assert.equal(fn().length,1);
});
