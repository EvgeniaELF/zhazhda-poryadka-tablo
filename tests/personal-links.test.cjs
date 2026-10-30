'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const links=require('../personal-links');
const {boardPart,eventKey,publication,publicManifest,mergeBoard}=require('../scripts/buildin-board.cjs');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),board=boardPart(html).board;
test('all 17 existing members have distinct permanent link IDs without changing historical data',()=>{
  assert.equal(new Set(board.members.map(m=>m.cardId)).size,17);assert.ok(board.members.every(m=>links.validCard(m.cardId)));
  const recipients=['Аня','Юля','Лена · болид №10','Женя · болид №9','Женя','Ира','Нина','Болид №7','Света','Ира · болид №8','Аня · болид №22','Даша','Юля · болид №17','Таня · болид №11','Лена · болид №3','Даша · болид №5','Настя · болид №28'];
  for(const [i,name] of recipients.entries())assert.equal(board.members.find(p=>p.cardId==='p'+String(i+1).padStart(2,'0'))?.name,name,'An existing public link must not change its recipient');
  const historical=structuredClone(board);for(const person of historical.members)delete person.cardId;
  assert.equal(createHash('sha256').update(JSON.stringify(historical)).digest('hex'),'7eb082bddeb79cddd9adc25bf685ec8cb68a5469c38e5b9b48903eae133b8ace');
});
test('a shared link opens both cards for the selected person and selected historical round',()=>{
  const url=links.url('https://evgeniaelf.github.io/zhazhda-poryadka-tablo/','p04',16,'12345.1'),target=links.parse(new URL(url).hash),result=links.resolve(board,target);
  assert.equal(url,'https://evgeniaelf.github.io/zhazhda-poryadka-tablo/?v=12345.1#card=p04&round=16');
  assert.equal(result.person.name,'Женя · болид №9');assert.equal(result.round.number,16);
  assert.ok(!url.includes('Женя'));
});
test('the same permanent link survives a name change and does not redirect to another member',()=>{
  const renamed=structuredClone(board);renamed.members.find(m=>m.cardId==='p04').name='Новое имя';
  assert.equal(links.resolve(renamed,{card:'p04',round:17}).person.name,'Новое имя');
});
test('invalid, duplicate, incomplete and injected hash values never select a fallback person',()=>{
  for(const hash of ['#card=p04','#card=p04&round=0','#card=p04&round=18&round=17','#card=p04&card=p01&round=17','#card=%22%3E%3Cscript%3E&round=17','#card=p04&round=17&url=https://wrong.test','#card=p04&round=017'])assert.throws(()=>links.parse(hash));
  assert.equal(links.parse(''),null);assert.equal(links.parse('#unrelated'),null);
  for(const target of [{card:'p99',round:17},{card:'p04',round:999},{card:'p17',round:1}])assert.throws(()=>links.resolve(board,target));
});
test('personal link generation rejects active content schemes and invalid rounds',()=>{
  for(const base of ['javascript:alert(1)','data:text/html,test','https://name:secret@example.com/'])assert.throws(()=>links.url(base,'p04',17));
  for(const n of [0,-1,1.5,1000,'17'])assert.throws(()=>links.url('https://example.test/','p04',n));
});
test('public notification metadata hashes page identifiers and contains no database credentials',()=>{
  const id='22222222-2222-4222-8222-222222222222',key=eventKey(id);
  assert.equal(key,eventKey(id.toUpperCase()));assert.match(key,/^[a-f0-9]{64}$/);assert.ok(!key.includes(id));
  const out=publicManifest(board,{events:[{key,cardId:'p04',round:17,event:'Финиш'}]},publication({GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40)}));
  assert.deepEqual(Object.keys(out),['schema','publication','members','events']);assert.ok(!JSON.stringify(out).includes(id));
});
test('a development build cannot masquerade as a GitHub release marker',()=>{
  assert.equal(publication({}),null);assert.throws(()=>publication({GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'bad'}));
});
