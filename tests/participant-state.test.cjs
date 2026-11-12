'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {merge,base,management}=require('./fixtures/participants.cjs');
const {REPO,BRANCH,FILE,githubClient,loadState,saveState}=require('../scripts/participant-state.cjs');
const ROOT='/repos/'+REPO,HEAD='a'.repeat(40),NEXT='b'.repeat(40);
const blobSha=content=>createHash('sha1').update('blob '+Buffer.byteLength(content)+'\0').update(content).digest('hex');
function server(state,{absent=false,ambiguous=false,failBeforeRef=false}={}){
  let current=absent?null:state,head=absent?null:HEAD,pending,missingFile=false;
  const calls=[];
  const request=async(route,options={})=>{
    calls.push({route,...options});
    if(!options.method){
      if(route===ROOT+'/git/ref/heads/'+BRANCH)return head?{ref:'refs/heads/'+BRANCH,object:{type:'commit',sha:head}}:null;
      if(route===ROOT+'/contents/'+FILE+'?ref='+head){
        if(missingFile)throw Error('file missing');
        const content=JSON.stringify(current)+'\n';
        return {type:'file',encoding:'base64',size:Buffer.byteLength(content),sha:blobSha(content),content:Buffer.from(content).toString('base64')};
      }
    }
    if(options.method==='PUT'){
      assert.equal(route,ROOT+'/contents/'+FILE);assert.equal(options.body.branch,BRANCH);
      assert.equal(options.body.sha,blobSha(JSON.stringify(current)+'\n'));
      current=JSON.parse(Buffer.from(options.body.content,'base64').toString());head=NEXT;
      if(ambiguous)throw Error('response lost after commit');
      return {content:{sha:blobSha(JSON.stringify(current)+'\n')}};
    }
    if(options.method==='POST'){
      if(route===ROOT+'/git/blobs'){pending=JSON.parse(Buffer.from(options.body.content,'base64').toString());return {sha:'1'.repeat(40)};}
      if(route===ROOT+'/git/trees'){assert.deepEqual(options.body.tree,[{path:FILE,mode:'100644',type:'blob',sha:'1'.repeat(40)}]);if(failBeforeRef)throw Error('tree creation failed');return {sha:'2'.repeat(40)};}
      if(route===ROOT+'/git/commits'){assert.deepEqual(options.body.parents,[]);return {sha:NEXT};}
      if(route===ROOT+'/git/refs'){assert.equal(options.body.ref,'refs/heads/'+BRANCH);current=pending;head=NEXT;if(ambiguous)throw Error('ref response lost');return {};}
    }
    assert.fail('unexpected GitHub operation '+route);
  };
  return {request,calls,get state(){return current;},loseFile(){missingFile=true;}};
}
test('снимок читается по точному коммиту ветки, а не по подвижной ссылке',async()=>{
  const s=server(merge().state),r=await loadState(s.request);assert.equal(r.head,HEAD);assert.deepEqual(r.state,s.state);
  assert.ok(s.calls[1].route.endsWith('?ref='+HEAD));management.validateState(r.state,base);
});
test('отсутствующая ветка допускает только предпросмотр до первого подтверждения',async()=>{
  const candidate=merge().state,s=server(null,{absent:true});assert.equal((await loadState(s.request)).state,null);
  await assert.rejects(saveState(s.request,candidate,{head:null,blob:null},HEAD),/подтверждения/);assert.equal(s.calls.filter(c=>c.method).length,0);
});
test('первая ветка появляется сразу с полным снимком, без промежуточной пустой истории',async()=>{
  const candidate=merge().state,s=server(null,{absent:true});
  assert.deepEqual(await saveState(s.request,candidate,{head:null,blob:null,bootstrapApproved:true},HEAD),{saved:true});
  assert.deepEqual(s.state,candidate);assert.deepEqual(s.calls.filter(c=>c.method).map(c=>c.route.split('/').at(-1)),['blobs','trees','commits','refs']);
});
test('ошибка подготовки первого снимка оставляет ветку отсутствующей',async()=>{
  const s=server(null,{absent:true,failBeforeRef:true});await assert.rejects(saveState(s.request,merge().state,{head:null,blob:null,bootstrapApproved:true},HEAD),/tree creation/);
  assert.equal((await loadState(s.request)).state,null);assert.equal(s.calls.some(c=>c.route.endsWith('/refs')),false);
});
test('изменившийся снимок не перезаписывается устаревшей сборкой',async()=>{
  const a=merge().state,s=server(a),expected=await loadState(s.request),b={...a,revision:2};
  await assert.rejects(saveState(s.request,b,{head:'c'.repeat(40),blob:expected.blob},HEAD),/изменилась/);assert.equal(s.calls.some(c=>c.method),false);
});
test('одинаковый снимок не создаёт коммит',async()=>{
  const a=merge().state,s=server(a),expected=await loadState(s.request);assert.deepEqual(await saveState(s.request,a,expected,HEAD),{unchanged:true});assert.equal(s.calls.some(c=>c.method),false);
});
test('новая ревизия сохраняется с условием прежней SHA файла',async()=>{
  const a=merge().state,s=server(a),expected=await loadState(s.request),b={...a,revision:2};
  assert.deepEqual(await saveState(s.request,b,expected,HEAD),{saved:true});assert.equal(s.calls.filter(c=>c.method==='PUT').length,1);assert.deepEqual(s.state,b);
});
test('потерянный ответ записи проверяется чтением, повторной записи нет',async()=>{
  const a=merge().state,s=server(a,{ambiguous:true}),expected=await loadState(s.request),b={...a,revision:2};
  assert.deepEqual(await saveState(s.request,b,expected,HEAD),{reconciled:true});assert.equal(s.calls.filter(c=>c.method==='PUT').length,1);
});
test('потерянный ответ создания ветки также сверяется без повторной мутации',async()=>{
  const a=merge().state,s=server(null,{absent:true,ambiguous:true});assert.deepEqual(await saveState(s.request,a,{head:null,blob:null,bootstrapApproved:true},HEAD),{reconciled:true});assert.equal(s.calls.filter(c=>c.route.endsWith('/refs')).length,1);
});
test('ветка с потерянным файлом не считается первым запуском',async()=>{
  const s=server(merge().state);s.loseFile();await assert.rejects(loadState(s.request),/file missing/);assert.equal(s.calls.some(c=>c.method),false);
});
test('повреждённая SHA скачанного файла останавливает чтение',async()=>{
  const s=server(merge().state);await assert.rejects(loadState(async(...args)=>{const r=await s.request(...args);if(r?.content)r.sha='0'.repeat(40);return r;}),/контрольная сумма/);
});
test('клиент GitHub использует только фиксированный host и не выводит ответ с ключами',async()=>{
  const calls=[],request=githubClient('FAKE_LOCAL_SECRET',async(u,o)=>{calls.push({u,o});return Response.json({ok:true});});
  await request(ROOT+'/git/ref/heads/'+BRANCH);assert.equal(calls[0].u,'https://api.github.com'+ROOT+'/git/ref/heads/'+BRANCH);assert.equal(calls[0].o.redirect,'error');
  await assert.rejects(request('/repos/attacker/other/git/refs'),/Запрещённый/);
  await assert.rejects(githubClient('FAKE_LOCAL_SECRET',async()=>new Response('FAKE_LOCAL_SECRET',{status:403}))(ROOT+'/git/refs'),e=>e.message.includes('403')&&!e.message.includes('FAKE_LOCAL_SECRET'));
});
test('неподтверждённая мутация GitHub не повторяется клиентом автоматически',async()=>{
  let calls=0;const request=githubClient('FAKE_LOCAL_SECRET',async()=>{calls++;throw Error('FAKE_LOCAL_SECRET');});
  await assert.rejects(request(ROOT+'/git/refs',{method:'POST',body:{}}),e=>!e.message.includes('FAKE_LOCAL_SECRET'));assert.equal(calls,1);
});
