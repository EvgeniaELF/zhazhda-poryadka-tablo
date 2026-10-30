'use strict';
// Post-deploy only. No Telegram token or permanent callback secret in GitHub.
const CALLBACK='https://functions.yandexcloud.net/d4eo0fab2fjrqi9m6ki1?publication_notice=1';
const fs=require('node:fs/promises');
const {setTimeout:delay}=require('node:timers/promises');
class NoticeError extends Error{}
const callbackErrors=new Set(['PUBLICATION_DISABLED','PUBLICATION_FORBIDDEN','PUBLICATION_BAD_REQUEST','PUBLICATION_AUTH_UNAVAILABLE','PUBLICATION_DELIVERY_NOT_CONFIGURED','PUBLICATION_NOT_READY','PUBLICATION_EVENT_NOT_FOUND','PUBLICATION_INVALID_CARD','PUBLICATION_UNAVAILABLE','TELEGRAM_DELIVERY_UNCONFIRMED','BAD_ROUTE','BAD_REQUEST','JSON_REQUIRED','METHOD_NOT_ALLOWED']);
// Diagnostic comparisons only, never authorization. Print fixed check names,
// not claim values, JWTs, credentials, request URLs or response bodies.
function claimMismatches(token,env,now=Date.now()){
  let h,c;try{const p=token.split('.');if(p.length!==3)throw 0;h=JSON.parse(Buffer.from(p[0],'base64url'));c=JSON.parse(Buffer.from(p[1],'base64url'));if(!h||!c||typeof h!=='object'||typeof c!=='object')throw 0;}catch{return ['encoding'];}
  const repo='EvgeniaELF/zhazhda-poryadka-tablo',sec=Math.floor(now/1000),same=(a,b)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
  const subjects=['repo:'+repo+':environment:github-pages','repo:EvgeniaELF@250887240/zhazhda-poryadka-tablo@1297869392:environment:github-pages'];
  const checks={alg:h.alg==='RS256',typ:h.typ==='JWT',kid:typeof h.kid==='string'&&h.kid.length<=200,header:!h.jku&&!h.x5u&&!h.crit,
    issuer:c.iss==='https://token.actions.githubusercontent.com',audience:c.aud===CALLBACK,repository:same(c.repository,repo),repository_id:String(c.repository_id)==='1297869392',owner_id:String(c.repository_owner_id)==='250887240',
    workflow:same(c.workflow_ref,repo+'/.github/workflows/buildin-board.yml@refs/heads/main'),reusable:!c.job_workflow_ref,ref:c.ref==='refs/heads/main',event:c.event_name==='workflow_dispatch',environment:c.environment==='github-pages',runner:c.runner_environment==='github-hosted',ref_type:c.ref_type==='branch',subject:subjects.some(s=>same(c.sub,s)),
    time:Number.isInteger(c.exp)&&Number.isInteger(c.nbf)&&Number.isInteger(c.iat)&&c.exp>sec&&c.nbf<=sec+30&&c.iat<=sec+30&&c.iat>=sec-900&&c.exp-c.iat<=900&&c.exp>c.iat,
    jti:typeof c.jti==='string'&&c.jti.length>0&&c.jti.length<=200,run_id:c.run_id===env.GITHUB_RUN_ID,run_attempt:c.run_attempt===env.GITHUB_RUN_ATTEMPT,sha:c.sha===env.GITHUB_SHA};
  return Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name);
}
async function getToken(env,fetchImpl){
  const url=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
  if(url.protocol!=='https:'||url.username||url.password||url.port||!url.hostname.endsWith('.actions.githubusercontent.com')
    ||typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN!=='string'||!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||/[\r\n]/.test(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN))throw new NoticeError('OIDC_NOT_CONFIGURED');
  url.searchParams.set('audience',CALLBACK);
  const r=await fetchImpl(url.href,{method:'GET',headers:{Authorization:'Bearer '+env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw new NoticeError('OIDC_UNAVAILABLE');
  const text=await r.text();if(Buffer.byteLength(text)>32768)throw new NoticeError('OIDC_UNAVAILABLE');
  const token=JSON.parse(text).value;
  if(typeof token!=='string'||token.length>16384||!/^[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+$/.test(token))throw new NoticeError('OIDC_UNAVAILABLE');
  return token;
}
async function notify(env=process.env,{fetchImpl=fetch,sleep=delay,report=()=>{}}={}){
  const eventKey=env.NOTICE_EVENT;
  if(!eventKey)return {status:'skipped'};
  if(!/^[a-f0-9]{64}$/.test(eventKey)||!/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID||'')
    ||!/^[1-9]\d{0,4}$/.test(env.GITHUB_RUN_ATTEMPT||'')||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))throw new NoticeError('INVALID_NOTICE_CONTEXT');
  const body={eventKey,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT,sha:env.GITHUB_SHA};
  for(let attempt=0;attempt<6;attempt++){
    let token;
    try{token=await getToken(env,fetchImpl);}catch(error){report(error instanceof NoticeError&&error.message==='OIDC_NOT_CONFIGURED'?'OIDC_NOT_CONFIGURED':'OIDC_UNAVAILABLE');throw new NoticeError('OIDC_UNAVAILABLE');}
    const mismatches=claimMismatches(token,env);
    report(mismatches.length?'OIDC_UNVERIFIED_CHECK_MISMATCH: '+mismatches.join(','):'OIDC_UNVERIFIED_CHECKS_OK');
    let response,data;
    try{
      // Authorization is reserved by the Yandex HTTPS invocation layer.
      response=await fetchImpl(CALLBACK,{method:'POST',headers:{'Content-Type':'application/json','X-Navigator-Publication-Authorization':'Bearer '+token},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25000)});
      const text=await response.text();if(Buffer.byteLength(text)>32768)throw new Error('SIZE');data=JSON.parse(text);
    }catch{
      // The function might already have sent Telegram. No blind resend after
      // an ambiguous network outcome.
      report('CALLBACK_NETWORK_UNCONFIRMED');throw new NoticeError('NOTICE_DELIVERY_UNCONFIRMED');
    }
    const status=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?String(response.status):'UNKNOWN';
    report('CALLBACK_HTTP_'+status+': '+(data?.ok===true?'OK':callbackErrors.has(data?.error)?data.error:'UNRECOGNIZED_RESPONSE'));
    if(response.status===200&&data.ok===true)return {status:'delivered'};
    if(response.status===503&&['PUBLICATION_NOT_READY','PUBLICATION_AUTH_UNAVAILABLE','PUBLICATION_DELIVERY_NOT_CONFIGURED'].includes(data.error)&&attempt<5){await sleep(5000);continue;}
    throw new NoticeError('NOTICE_DELIVERY_UNCONFIRMED');
  }
  throw new NoticeError('NOTICE_DELIVERY_UNCONFIRMED');
}
async function main(){
  try{
    const result=await notify(process.env,{report:line=>console.log('::notice::Личная ссылка: '+line)});
    if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,result.status==='delivered'?'\nЛичная ссылка: сообщение доставлено в пульт штурмана.\n':'\nЛичная ссылка: этот запуск не запрашивал сообщение.\n');
  }catch{
    console.log('::warning::Табло опубликовано, но доставка личной ссылки в бот не подтверждена. Карточки можно открыть на сайте и скопировать ссылку.');
    if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,'\n⚠️ Табло опубликовано. Сообщение с личной ссылкой в бот не подтверждено; открой карточки на сайте и скопируй ссылку.\n');
    process.exitCode=1;
  }
}
module.exports={notify,getToken,NoticeError,CALLBACK,claimMismatches};
if(require.main===module)main();
