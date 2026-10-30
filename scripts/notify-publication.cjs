'use strict';
// Post-deploy only. No Telegram token or permanent callback secret in GitHub.
const CALLBACK='https://functions.yandexcloud.net/d4eo0fab2fjrqi9m6ki1?publication_notice=1';
const fs=require('node:fs/promises');
const {setTimeout:delay}=require('node:timers/promises');
class NoticeError extends Error{}
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
async function notify(env=process.env,{fetchImpl=fetch,sleep=delay}={}){
  const eventKey=env.NOTICE_EVENT;
  if(!eventKey)return {status:'skipped'};
  if(!/^[a-f0-9]{64}$/.test(eventKey)||!/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID||'')
    ||!/^[1-9]\d{0,4}$/.test(env.GITHUB_RUN_ATTEMPT||'')||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))throw new NoticeError('INVALID_NOTICE_CONTEXT');
  const body={eventKey,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT,sha:env.GITHUB_SHA};
  for(let attempt=0;attempt<6;attempt++){
    let token;
    try{token=await getToken(env,fetchImpl);}catch{throw new NoticeError('OIDC_UNAVAILABLE');}
    let response,data;
    try{
      // Authorization is reserved by the Yandex HTTPS invocation layer.
      response=await fetchImpl(CALLBACK,{method:'POST',headers:{'Content-Type':'application/json','X-Navigator-Publication-Authorization':'Bearer '+token},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25000)});
      const text=await response.text();if(Buffer.byteLength(text)>32768)throw new Error('SIZE');data=JSON.parse(text);
    }catch{
      // The function might already have sent Telegram. No blind resend after
      // an ambiguous network outcome.
      throw new NoticeError('NOTICE_DELIVERY_UNCONFIRMED');
    }
    if(response.status===200&&data.ok===true)return {status:'delivered'};
    if(response.status===503&&['PUBLICATION_NOT_READY','PUBLICATION_AUTH_UNAVAILABLE','PUBLICATION_DELIVERY_NOT_CONFIGURED'].includes(data.error)&&attempt<5){await sleep(5000);continue;}
    throw new NoticeError('NOTICE_DELIVERY_UNCONFIRMED');
  }
  throw new NoticeError('NOTICE_DELIVERY_UNCONFIRMED');
}
async function main(){
  try{
    const result=await notify();
    if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,result.status==='delivered'?'\nЛичная ссылка: сообщение доставлено в пульт штурмана.\n':'\nЛичная ссылка: этот запуск не запрашивал сообщение.\n');
  }catch{
    console.log('::warning::Табло опубликовано, но доставка личной ссылки в бот не подтверждена. Карточки можно открыть на сайте и скопировать ссылку.');
    if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,'\n⚠️ Табло опубликовано. Сообщение с личной ссылкой в бот не подтверждено; открой карточки на сайте и скопируй ссылку.\n');
    process.exitCode=1;
  }
}
module.exports={notify,getToken,NoticeError,CALLBACK};
if(require.main===module)main();
