'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const {SafeError,boardPart}=require('./buildin-board.cjs');
const {validateState,hash}=require('./participant-management.cjs');
const REPO='EvgeniaELF/zhazhda-poryadka-tablo',BRANCH='tablo-participants-state',FILE='participant-state.json',ROOT='/repos/'+REPO;
const fail=text=>{throw new SafeError(text);};
function githubClient(token,fetchImpl=fetch){
  if(!token||/[\r\n]/.test(token))fail('Не получен служебный GITHUB_TOKEN.');
  return async(route,{method='GET',body,missing=false}={})=>{
    if(!route.startsWith(ROOT+'/')||/[\r\n]/.test(route))fail('Запрещённый путь служебного хранилища.');
    let r;
    try{r=await fetchImpl('https://api.github.com'+route,{method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10'},redirect:'error',signal:AbortSignal.timeout(15000),...(body?{body:JSON.stringify(body)}:{})});}
    catch{fail('Нет подтверждения ответа GitHub. Запись автоматически не повторяется.');}
    if(missing&&r.status===404){await r.body?.cancel();return null;}
    if(!r.ok){await r.body?.cancel();fail('GitHub HTTP '+r.status+' при работе со служебной историей.');}
    try{const text=await r.text();if(text.length>2*1024*1024)fail('Служебная история превышает предел чтения.');return JSON.parse(text);}
    catch(e){if(e instanceof SafeError)throw e;fail('Некорректный ответ служебного хранилища.');}
  };
}
async function loadState(request){
  const ref=await request(ROOT+'/git/ref/heads/'+BRANCH,{missing:true});
  if(ref===null)return {state:null,head:null,blob:null};
  if(ref.ref!=='refs/heads/'+BRANCH||ref.object?.type!=='commit'||!/^[a-f0-9]{40}$/.test(ref.object.sha))fail('Неизвестная служебная ветка.');
  const head=ref.object.sha,file=await request(ROOT+'/contents/'+FILE+'?ref='+head);
  if(file.type!=='file'||file.encoding!=='base64'||!/^[a-f0-9]{40}$/.test(file.sha)||typeof file.content!=='string'||file.size>900000)fail('В служебной ветке нет допустимого снимка. Автоматический сброс запрещён.');
  try{
    const bytes=Buffer.from(file.content,'base64');
    if(bytes.length!==file.size||createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!==file.sha)fail('Не совпала контрольная сумма файла истории.');
    return {state:JSON.parse(bytes.toString('utf8')),head,blob:file.sha};
  }catch(e){if(e instanceof SafeError)throw e;fail('Не удалось прочитать служебную историю.');}
}
async function saveState(request,candidate,expected,sha){
  const current=await loadState(request);
  if(current.state&&hash(current.state)===hash(candidate))return {unchanged:true};
  if(current.head!==expected.head||current.blob!==expected.blob)fail('История изменилась после проверки. Запусти новую сборку; перезапись запрещена.');
  const content=JSON.stringify(candidate)+'\n';
  if(Buffer.byteLength(content)>900000)fail('Снимок достиг предела. Нужен план архивирования.');
  if(!current.head){
    if(!expected.bootstrapApproved||!/^[a-f0-9]{40}$/.test(sha||''))fail('Первый снимок требует подтверждения переноса.');
    // Publish the initial branch atomically: orphan commit contains only history.
    try {
      const blob=await request(ROOT+'/git/blobs',{method:'POST',body:{content:Buffer.from(content).toString('base64'),encoding:'base64'}});
      if(!/^[a-f0-9]{40}$/.test(blob.sha||''))fail('Не подтверждён объект первого снимка.');
      const tree=await request(ROOT+'/git/trees',{method:'POST',body:{tree:[{path:FILE,mode:'100644',type:'blob',sha:blob.sha}]}});
      if(!/^[a-f0-9]{40}$/.test(tree.sha||''))fail('Не подтверждена структура первого снимка.');
      const commit=await request(ROOT+'/git/commits',{method:'POST',body:{message:'Первый проверенный снимок истории табло',tree:tree.sha,parents:[]}});
      if(!/^[a-f0-9]{40}$/.test(commit.sha||''))fail('Не подтверждён первый коммит истории.');
      await request(ROOT+'/git/refs',{method:'POST',body:{ref:'refs/heads/'+BRANCH,sha:commit.sha}});
    } catch(e) {
      const observed=await loadState(request);
      if(!observed.state||hash(observed.state)!==hash(candidate))throw e;
      return {reconciled:true};
    }
    const observed=await loadState(request);
    if(!observed.state||hash(observed.state)!==hash(candidate))fail('Первый снимок истории не подтверждён.');
    return {saved:true};
  }
  const body={message:'История табло: ревизия '+candidate.revision,branch:BRANCH,content:Buffer.from(content).toString('base64'),...(current.blob?{sha:current.blob}:{})};
  try{await request(ROOT+'/contents/'+FILE,{method:'PUT',body});}
  catch(e){
    // Reconcile an ambiguous write by reading; never retry it blindly.
    const observed=await loadState(request);
    if(!observed.state||hash(observed.state)!==hash(candidate))throw e;
    return {reconciled:true};
  }
  const observed=await loadState(request);
  if(!observed.state||hash(observed.state)!==hash(candidate))fail('Запись истории не подтверждена. Публикация остановлена.');
  return {saved:true};
}
async function cli(mode,root=process.cwd(),env=process.env){
  if((env.GITHUB_REPOSITORY||'').toLowerCase()!==REPO.toLowerCase())fail('Хранилище разрешено только в репозитории табло.');
  const request=githubClient(env.GITHUB_TOKEN);
  const base=boardPart(await fs.readFile(path.join(root,'index.html'),'utf8')).board;
  if(mode==='fetch'){
    const current=await loadState(request);
    if(current.state)validateState(current.state,base);
    if(current.state && env.BUILDIN_PARTICIPANT_MANAGEMENT!=='true')fail('Управление уже включалось: служебная история существует. Включи BUILDIN_PARTICIPANT_MANAGEMENT; возврат к прежнему режиму остановлен для сохранения пауз.');
    await fs.writeFile(path.join(root,'participant-state-input.json'),JSON.stringify(current.state)+'\n',{mode:0o600});
    await fs.writeFile(path.join(root,'participant-state-meta.json'),JSON.stringify({head:current.head,blob:current.blob})+'\n',{mode:0o600});
    console.log(current.state?'PARTICIPANT_STATE_LOADED':'PARTICIPANT_STATE_NOT_INITIALIZED');
  }else if(mode==='save'){
    const dir=path.join(root,'.participant-state');
    const candidate=JSON.parse(await fs.readFile(path.join(dir,'participant-state-candidate.json'),'utf8'));
    const expected=JSON.parse(await fs.readFile(path.join(dir,'participant-state-meta.json'),'utf8'));
    validateState(candidate,base);
    await saveState(request,candidate,expected,env.GITHUB_SHA);
    console.log('PARTICIPANT_STATE_SAVED');
  }else fail('Неизвестное действие служебного хранилища.');
}
module.exports={REPO,BRANCH,FILE,githubClient,loadState,saveState,cli};
if(require.main===module)cli(process.argv[2]).catch(e=>{console.error(e instanceof SafeError?e.message:'Не удалось проверить историю; ответы и ключи не выводятся.');process.exitCode=1;});
