'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {html,base,core,participation}=require('./fixtures/participants.cjs');

function uiFunction(name,context) {
  const start=html.indexOf('    function '+name+'(');assert.ok(start>=0);
  const closing='\n    }\n',end=html.indexOf(closing,start)+closing.length;assert.ok(end>start);
  return vm.runInNewContext('('+html.slice(start,end).trim()+')',context);
}
function history(board,season) {
  const fn=uiFunction('historyParticipants',{
    BOARD_DATA:board,Participation:participation,selectedSeason:()=>season,
    roundsForSeason:s=>board.rounds.filter(r=>r.number>=s.firstRound&&r.number<=s.lastRound),
    isOnActivePitStop:p=>(p.trackPauses||[]).some(p=>p.pausedAt&&!p.resumedAt)
  });
  return Array.from(fn());
}
function boardAt(date='2026-11-12T12:00:00Z') {
  const board=structuredClone(base);core.currentCalendar(board,new Date(date));return board;
}
const season1={number:1,firstRound:1,lastRound:12},season2={number:2,firstRound:13,lastRound:24},season3={number:3,firstRound:25,lastRound:36};

test('closed season restores Anya and all its participants above any current pit grouping',()=>{
  const board=boardAt(),before=structuredClone(board),rows=history(board,season1);
  assert.equal(rows[0].person.cardId,'p01');
  assert.equal(rows.length,16);assert.ok(rows.every(row=>row.isOnPitStop===false));
  assert.deepEqual(rows.map(row=>row.person.cardId),board.members.filter(p=>p.joinedRound<=12).map(p=>p.cardId));
  assert.deepEqual(board,before);
});
test('a participant who paused during season one stays in its ordinary archive list',()=>{
  const rows=history(boardAt(),season1),person=rows.find(row=>row.person.cardId==='p02');
  assert.ok(person);assert.equal(person.isOnPitStop,false);
  assert.equal(participation.roundState(person.person,3,boardAt().rounds),'pit');
});
test('current season retains all existing pit-stop participants, including earlier pauses',()=>{
  const board=boardAt(),rows=history(board,season2),expected=board.members.filter(p=>(p.trackPauses||[]).some(p=>p.pausedAt&&!p.resumedAt));
  assert.equal(rows.length,17);assert.deepEqual(rows.filter(row=>row.isOnPitStop).map(row=>row.person.cardId),expected.map(p=>p.cardId));
  const firstPit=rows.findIndex(row=>row.isOnPitStop);assert.ok(firstPit>0);
  assert.ok(rows.slice(0,firstPit).every(row=>!row.isOnPitStop));assert.ok(rows.slice(firstPit).every(row=>row.isOnPitStop));
});
test('Nastya and the new participant belong to season two and not season one',()=>{
  const board=boardAt();
  board.members.push({cardId:'p1122334455667788',name:'Новый участник',joinedRound:19,firstReport:'2026-11-12'});
  const first=history(board,season1).map(row=>row.person.cardId),second=history(board,season2).map(row=>row.person.cardId);
  assert.equal(first.includes('p17'),false);assert.equal(first.includes('p1122334455667788'),false);
  assert.ok(second.includes('p17'));assert.ok(second.includes('p1122334455667788'));assert.equal(second.length,18);
});
test('season two becomes an ordinary historical list when season three starts',()=>{
  const board=boardAt();
  const nastya=board.members.find(p=>p.cardId==='p17');nastya.trackPauses=[{pausedAt:'2026-11-10',resumedAt:null,pitStopRound:19}];nastya.pitStopRound=19;
  assert.equal(history(board,season2).find(row=>row.person===nastya).isOnPitStop,true);
  core.currentCalendar(board,new Date('2026-12-20T21:00:00Z'));
  const archive=history(board,season2);assert.ok(archive.some(row=>row.person===nastya));assert.ok(archive.some(row=>row.person.cardId==='p01'));
  assert.ok(archive.every(row=>!row.isOnPitStop));
  assert.equal(history(board,season3).find(row=>row.person===nastya).isOnPitStop,true);
});
test('a whole season on an earlier continuing pause does not create empty archive rows',()=>{
  const board=boardAt('2026-12-21T12:00:00Z');
  assert.equal(history(board,season2).some(row=>row.person.cardId==='p02'),false);
  assert.ok(history(board,season1).some(row=>row.person.cardId==='p02'));
  assert.ok(history(board,season3).some(row=>row.person.cardId==='p02'&&row.isOnPitStop));
});
test('a return during the selected season preserves membership and marks, regardless of a later pause',()=>{
  const board=boardAt('2026-12-21T12:00:00Z'),person=board.members.find(p=>p.cardId==='p03');
  person.trackPauses=[{pausedAt:'2026-09-01',resumedAt:'2026-10-05',pitStopRound:9},{pausedAt:'2026-12-01',resumedAt:null,pitStopRound:23}];
  const before=structuredClone(board);assert.ok(history(board,season2).some(row=>row.person===person&&!row.isOnPitStop));assert.deepEqual(board,before);
});
test('future season and participants who have not joined yet are absent from its list',()=>{
  const board=boardAt();assert.equal(history(board,season3).length,0);
  board.members.push({cardId:'p1122334455667788',name:'Позже',joinedRound:20,firstReport:'2026-11-16'});
  assert.equal(history(board,season2).some(row=>row.person.name==='Позже'),false);
});
test('real route rendering switches season checkpoints while retaining lifetime totals and card targets',()=>{
  const person={cardId:'p01',name:'Участница',joinedRound:1,firstReport:'2026-07-06',trackPauses:[{pausedAt:'2026-11-04',resumedAt:null,pitStopRound:19}]};
  const board={selectedRound:19,members:[person],rounds:[
    {number:1,marks:{Участница:{entered:true,finished:true}}},
    {number:12,marks:{Участница:{finished:true}}},
    {number:13,marks:{Участница:{entered:true}}},
    {number:19,marks:{Участница:{entered:true,finished:true}}}
  ]};
  class Element {
    constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.dataset={};this.listeners={};this.style={setProperty(){}};this.textContent='';}
    append(...nodes){this.children.push(...nodes);}
    appendChild(node){this.children.push(node);return node;}
    replaceChildren(...nodes){this.children=[...nodes];}
    setAttribute(key,value){this.attrs[key]=value;}
    addEventListener(event,callback){this.listeners[event]=callback;}
  }
  let selected=season1;const grid=new Element('div'),opened=[];
  const render=uiFunction('renderHistory',{
    document:{getElementById:id=>{assert.equal(id,'history-grid');return grid;},createElement:tag=>new Element(tag)},
    BOARD_DATA:board,Participation:participation,roundsForSeason:()=>board.rounds.filter(r=>r.number>=selected.firstRound&&r.number<=selected.lastRound),
    historyParticipants:()=>history(board,selected),formatLaps:n=>n+' кругов',formatCheckpoints:n=>n+' чек-поинтов',initial:name=>name[0],
    openPersonalStory:(...args)=>opened.push(args),requestAnimationFrame(){},syncHistoryScrollbars(){}
  });
  const snapshot=()=>({headers:grid.children.filter(x=>x.className==='history-head').map(x=>x.textContent),
    name:grid.children.find(x=>x.attrs.role==='rowheader'),total:grid.children.find(x=>x.className?.startsWith('lap-total')),
    cells:grid.children.filter(x=>x.className?.startsWith('lap '))});
  const original=structuredClone(board);render();const first=snapshot();
  assert.deepEqual(first.headers,['Участник','Отмечено','Круг 1','Круг 12']);
  assert.equal(first.name.className,'history-name');assert.deepEqual(first.total.children.map(x=>x.textContent),['4 кругов','6 чек-поинтов']);
  first.name.children[0].listeners.click();first.cells[0].listeners.click();
  assert.equal(opened[0][0],person);assert.equal(opened[0][2],undefined);assert.equal(opened[1][2].number,1);
  selected=season2;render();const second=snapshot();
  assert.deepEqual(second.headers,['Участник','Отмечено','Круг 13','Круг 19']);assert.equal(second.name.className,'history-name is-pit');
  assert.deepEqual(second.total.children.map(x=>x.textContent),['4 кругов','6 чек-поинтов']);
  assert.match(second.cells[0].attrs['aria-label'],/отмечен только заезд/);
  board.rounds[2].marks.Участница.finished=true;render();
  assert.deepEqual(snapshot().total.children.map(x=>x.textContent),['4 кругов','7 чек-поинтов']);
  assert.match(snapshot().cells[0].attrs['aria-label'],/заезд и финиш отмечены/);
  delete board.rounds[2].marks.Участница.finished;selected=season1;render();
  assert.deepEqual(snapshot().headers,first.headers);assert.deepEqual(board,original);
});
