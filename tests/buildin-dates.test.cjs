'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {management,rows,approve,event,merge,participation}=require('./fixtures/participants.cjs');
const field={name:'Дата старта',key:'Дата старта',type:'date'};
function diagnostic(value) {
  try {management.dateValue({properties:{'Дата старта':{type:'date',date:value}}},field);}
  catch(error) {
    assert.equal(error.name,'Error');
    const marker=error.message.indexOf('DATE_SHAPE=');
    assert.ok(marker>=0,error.message);
    return {message:error.message,shape:JSON.parse(error.message.slice(marker+11))};
  }
  assert.fail('A diagnostic must not accept a rejected date');
}
test('diagnostic distinguishes a plain date string from the supported object',()=>{
  const r=diagnostic('2026/10/05');
  assert.equal(r.shape.type,'string');assert.equal(r.shape.dateOnly,true);
  assert.equal(r.shape.pattern,'0000/00/00');assert.ok(!r.message.includes('2026'));
});
test('diagnostic distinguishes midnight timestamps and equal range endpoints',()=>{
  const time=diagnostic({start:'2026-10-05T00:00:00.000+03:00',end:null});
  assert.equal(time.shape.fields.start.midnight,true);assert.equal(time.shape.fields.end.type,'null');
  assert.equal(diagnostic({start:'2026/10/05',end:'2026/10/05'}).shape.equalStartEnd,true);
  assert.equal(diagnostic({start:'2026/10/05',end:'2026/10/06'}).shape.equalStartEnd,false);
});
test('rejected data cannot disclose free text, tokens or unlisted properties',()=>{
  const secret='ghp_TestSecret987654321';
  const r=diagnostic({start:secret,end:null,time_zone:'Europe/Moscow',token:secret,notes:'private participant notes',value:{value:{start:secret}}});
  for(const value of [secret,'private participant notes','Europe/Moscow','token','notes'])assert.ok(!r.message.includes(value),value);
  assert.equal(r.shape.fieldCount,6);assert.equal(r.shape.fields.value.fields.value.type,'object');
});
test('malformed primitives and arrays are described without coercion',()=>{
  for(const value of [undefined,false,0,[],42]){
    const r=diagnostic(value);assert.ok(r.shape.type);
  }
});
function readDate(start,extra={}) {
  return management.dateValue({properties:{'Дата старта':{type:'date',date:{start,end:null,time_zone:null,...extra}}}},field);
}
test('Buildin calendar dates with an unzoned time retain the written day',()=>{
  for(const sep of ['-','/'])for(const time of ['00:00:00','03:00:00','08:17:42','12:34:56','23:59:59']) {
    assert.equal(readDate('2026'+sep+'10'+sep+'05T'+time),'2026-10-05');
  }
});
test('calendar date normalization does not depend on the runner time zone',()=>{
  const previous=process.env.TZ;
  try {
    for(const zone of ['UTC','Europe/Moscow','America/Los_Angeles','Pacific/Kiritimati']) {
      process.env.TZ=zone;assert.equal(readDate('2026/10/05T23:59:59'),'2026-10-05');
    }
  }finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
test('invalid dates and invalid wall times remain rejected',()=>{
  for(const start of ['2026/02/29T12:34:56','2026/02/30T03:00:00','2026/13/01T03:00:00','2026/10/00T03:00:00','2026/10/05T24:00:00','2026/10/05T03:60:00','2026/10/05T03:00:60','2026/10-05T03:00:00','2026/10/05T3:00:00','2026/10/05T03:00:00extra']) {
    assert.throws(()=>readDate(start),/дата|даты/);
  }
  assert.equal(readDate('2028/02/29T03:00:00'),'2028-02-29');
});
test('range values and timestamps needing zone interpretation remain rejected',()=>{
  for(const start of ['2026-10-05T03:00:00Z','2026-10-05T03:00:00+03:00','2026/10/05T03:00:00-08:00'])assert.throws(()=>readDate(start),/дата/);
  assert.throws(()=>readDate('2026/10/05T03:00:00',{time_zone:'Europe/Moscow'}),/часового пояса/);
  for(const end of ['2026/10/05','2026/10/06'])assert.throws(()=>readDate('2026/10/05T03:00:00',{end}),/диапазона/);
});
test('Nastya 28 pause normalizes API dates and preserves her existing finish and link',()=>{
  const finish=event(1,17,18,'Финиш'),before=merge(rows(),[finish]);
  const list=approve(rows(),'p17',{firstReport:'2026/10/05T08:17:42',pauseDate:'2026/11/11T03:00:00',pauseRound:19},'На пит-стопе');
  const after=merge(list,[finish],before.state),person=after.board.members.find(p=>p.cardId==='p17');
  assert.equal(person.firstReport,'2026-10-05');assert.equal(person.joinedRound,14);
  assert.deepEqual(person.trackPauses,[{pausedAt:'2026-11-10',resumedAt:null,pitStopRound:19}]);
  assert.equal(participation.daysOnTrack(person,'2026-11-12'),37);
  assert.equal(participation.roundState(person,19,after.board.rounds),'pit');
  assert.equal(after.board.rounds.find(r=>r.number===18).marks[person.name].finished,true);
  assert.deepEqual(after.board.members.filter(p=>p.cardId!=='p17'),before.board.members.filter(p=>p.cardId!=='p17'));
  for(const round of before.board.rounds)assert.deepEqual(after.board.rounds.find(r=>r.number===round.number).marks,round.marks);
  assert.deepEqual(after.report.profileChanges,[{cardId:'p17',action:'Обновление профиля'}]);
  management.validateState(after.state,require('./fixtures/participants.cjs').base);
  assert.deepEqual(merge(list,[finish],after.state).state,after.state);
});
test('new profiles and returns use the same calendar-day normalization',()=>{
  const fixture=require('./fixtures/participants.cjs');
  const newcomer=fixture.row(30,'Новая · болид №33','На треке',{ready:true,firstReport:'2026/11/10T08:00:00',joinedRound:19});
  const added=merge([...rows(),newcomer],[event(2,30,19)]).board.members.at(-1);
  assert.equal(added.firstReport,'2026-11-10');assert.equal(added.joinedRound,19);
  const paused=merge(approve(rows(),'p17',{pauseDate:'2026/11/11T08:00:00',pauseRound:19},'На пит-стопе'));
  const back=merge(approve(rows(),'p17',{pauseDate:'2026/11/11T08:00:00',pauseRound:19,returnDate:'2026/11/16T08:00:00'},'На треке'),[],paused.state,new Date('2026-11-17T12:00:00Z'));
  assert.equal(back.board.members.find(p=>p.cardId==='p17').trackPauses[0].resumedAt,'2026-11-16');
});
