'use strict';
// Prepared option 1.2.0: send from the trusted GitHub deploy job, after Pages.
// Credentials are supplied only to this step by github-pages environment secrets.
const fs=require('node:fs/promises');
const {setTimeout:delay}=require('node:timers/promises');
const SITE='https://evgeniaelf.github.io/zhazhda-poryadka-tablo/';
const REPO='EvgeniaELF/zhazhda-poryadka-tablo';
const WORKFLOW=REPO+'/.github/workflows/buildin-board.yml@refs/heads/main';
const BOT='navigator_admin_bot';
const CODES=new Set(['INVALID_NOTICE_CONTEXT','TELEGRAM_NOT_CONFIGURED','PUBLICATION_NOT_READY','PUBLICATION_INVALID_CARD','PUBLICATION_EVENT_NOT_FOUND','TELEGRAM_TOKEN_REJECTED','TELEGRAM_WRONG_BOT','TELEGRAM_BOT_CHECK_UNAVAILABLE','TELEGRAM_CHAT_UNAVAILABLE','TELEGRAM_RATE_LIMITED','TELEGRAM_REQUEST_REJECTED','TELEGRAM_DELIVERY_UNCONFIRMED']);
class NoticeError extends Error{}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const same=(a,b)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
function context(env){
  if(!/^[a-f0-9]{64}$/.test(env.NOTICE_EVENT||'')||!same(env.GITHUB_REPOSITORY,REPO)
    ||env.GITHUB_REPOSITORY_ID!=='1297869392'||env.GITHUB_REPOSITORY_OWNER_ID!=='250887240'
    ||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_REF!=='refs/heads/main'
    ||!same(env.GITHUB_WORKFLOW_REF,WORKFLOW)||env.GITHUB_SERVER_URL!=='https://github.com'
    ||!/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID||'')||!/^[1-9]\d{0,4}$/.test(env.GITHUB_RUN_ATTEMPT||'')
    ||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))throw new NoticeError('INVALID_NOTICE_CONTEXT');
  const token=env.NAVIGATOR_TELEGRAM_BOT_TOKEN,owner=env.NAVIGATOR_ADMIN_TELEGRAM_ID;
  if(typeof token!=='string'||!/^[1-9]\d{4,15}:[A-Za-z0-9_-]{20,200}$/.test(token)
    ||!/^[1-9]\d{0,15}$/.test(owner||'')||!Number.isSafeInteger(Number(owner)))throw new NoticeError('TELEGRAM_NOT_CONFIGURED');
  return {eventKey:env.NOTICE_EVENT,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT,sha:env.GITHUB_SHA,token,owner:Number(owner)};
}
async function read(url,init,fetchImpl,limit,timeout=5000){
  const controller=new AbortController();let timer;
  try{return await Promise.race([
    (async()=>{
      const response=await fetchImpl(url,{...init,redirect:'error',signal:controller.signal});
      let text;
      if(response.body?.getReader){
        const reader=response.body.getReader(),chunks=[];let size=0;
        try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>limit)throw new Error('SIZE');chunks.push(Buffer.from(p.value));}}
        catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
        text=Buffer.concat(chunks).toString('utf8');
      }else{text=await response.text();if(Buffer.byteLength(text)>limit)throw new Error('SIZE');}
      return {status:response.status,ok:response.ok,text};
    })(),
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('TIMEOUT'));},timeout);})
  ]);}finally{clearTimeout(timer);controller.abort();}
}
function findCard(manifest,ctx){
  const p=manifest?.publication;
  if(!object(manifest)||manifest.schema!==1||!object(p)||p.runId!==ctx.runId||p.runAttempt!==ctx.runAttempt||p.sha!==ctx.sha
    ||!Array.isArray(manifest.events)||!Array.isArray(manifest.members))throw new NoticeError('PUBLICATION_NOT_READY');
  const events=manifest.events.filter(e=>e?.key===ctx.eventKey);
  if(events.length!==1)throw new NoticeError('PUBLICATION_EVENT_NOT_FOUND');
  const e=events[0],members=manifest.members.filter(m=>m?.cardId===e.cardId);
  if(members.length!==1||!/^p[0-9]{2,5}$/.test(e.cardId||'')||!Number.isInteger(e.round)||e.round<1||e.round>999
    ||!['Старт','Финиш'].includes(e.event)||typeof members[0].name!=='string'||members[0].name.length>100
    ||!members[0].name.trim()||/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(members[0].name))throw new NoticeError('PUBLICATION_INVALID_CARD');
  return {cardId:e.cardId,round:e.round,event:e.event,name:members[0].name};
}
async function publication(ctx,{fetchImpl,sleep}){
  for(let attempt=0;attempt<6;attempt++){
    try{
      const revision=ctx.runId+'.'+ctx.runAttempt;
      const m=await read(SITE+'cards.json?v='+revision,{method:'GET',headers:{Accept:'application/json','Cache-Control':'no-cache'}},fetchImpl,256*1024);
      if(m.status!==200)throw new NoticeError('PUBLICATION_NOT_READY');
      let manifest;try{manifest=JSON.parse(m.text);}catch{throw new NoticeError('PUBLICATION_NOT_READY');}
      const card=findCard(manifest,ctx);
      const page=await read(SITE+'?v='+revision,{method:'GET',headers:{Accept:'text/html','Cache-Control':'no-cache'}},fetchImpl,2*1024*1024);
      const marker='<meta name="tablo-publication" content="'+ctx.runId+'.'+ctx.runAttempt+'.'+ctx.sha+'">';
      if(page.status!==200||!page.text.includes(marker))throw new NoticeError('PUBLICATION_NOT_READY');
      return card;
    }catch(error){
      if(error instanceof NoticeError&&['PUBLICATION_INVALID_CARD','PUBLICATION_EVENT_NOT_FOUND'].includes(error.message))throw error;
      if(attempt===5)throw new NoticeError('PUBLICATION_NOT_READY');
      await sleep(5000);
    }
  }
}
async function telegram(ctx,method,payload,fetchImpl){
  if(!['getMe','sendMessage'].includes(method))throw new NoticeError('TELEGRAM_REQUEST_REJECTED');
  let r,data;
  try{
    r=await read('https://api.telegram.org/bot'+ctx.token+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)},fetchImpl,64*1024,10000);
    data=JSON.parse(r.text);
  }catch{throw new NoticeError(method==='getMe'?'TELEGRAM_BOT_CHECK_UNAVAILABLE':'TELEGRAM_DELIVERY_UNCONFIRMED');}
  if(!r.ok||!object(data)||data.ok!==true){
    const code=Number.isInteger(data?.error_code)?data.error_code:r.status;
    throw new NoticeError(code===401?'TELEGRAM_TOKEN_REJECTED':code===403?'TELEGRAM_CHAT_UNAVAILABLE':code===429?'TELEGRAM_RATE_LIMITED':method==='getMe'?'TELEGRAM_BOT_CHECK_UNAVAILABLE':'TELEGRAM_REQUEST_REJECTED');
  }
  return data.result;
}
async function notify(env=process.env,{fetchImpl=fetch,sleep=delay,report=()=>{}}={}){
  if(!env.NOTICE_EVENT)return {status:'skipped'};
  const ctx=context(env),card=await publication(ctx,{fetchImpl,sleep});
  report('PUBLICATION_VERIFIED');
  const me=await telegram(ctx,'getMe',{},fetchImpl);
  if(!object(me)||me.is_bot!==true||!same(me.username,BOT)||String(me.id)!==ctx.token.split(':')[0])throw new NoticeError('TELEGRAM_WRONG_BOT');
  const link=SITE+'?v='+ctx.runId+'.'+ctx.runAttempt+'#card='+card.cardId+'&round='+card.round;
  const payload={chat_id:ctx.owner,text:'✅ Карточки обновлены.\n'+card.name+'\nКруг '+card.round+' · '+card.event+'\n\nЛичный трек и Личный рубеж:\n'+link+'\n\nМожно скачать PNG или переслать участнику эту ссылку.',link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[[{text:'Открыть личные карточки',url:link}]]}};
  // One send attempt: a timeout may mean Telegram accepted the message.
  const sent=await telegram(ctx,'sendMessage',payload,fetchImpl);
  if(!object(sent)||!Number.isSafeInteger(sent.message_id)||sent.message_id<1||sent.chat?.id!==ctx.owner||sent.chat?.type!=='private')throw new NoticeError('TELEGRAM_DELIVERY_UNCONFIRMED');
  report('TELEGRAM_DELIVERED');return {status:'delivered'};
}
async function main(){
  try{
    const r=await notify(process.env,{report:code=>console.log('::notice::Личная ссылка: '+code)});
    if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,r.status==='delivered'?'\nЛичная ссылка: Telegram подтвердил отправку владельцу пульта.\n':'\nЛичная ссылка: этот запуск не запрашивал сообщение.\n');
  }catch(error){
    const code=error instanceof NoticeError&&CODES.has(error.message)?error.message:'NOTICE_UNCONFIRMED';
    console.log('::warning::Табло опубликовано; личная ссылка не подтверждена. Код: '+code);
    if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,'\n⚠️ Табло опубликовано; отправка личной ссылки не подтверждена. Код: '+code+'. Ссылку можно скопировать на сайте.\n');
    process.exitCode=1;
  }
}
module.exports={notify,findCard,context,NoticeError,SITE};
if(require.main===module)main();
