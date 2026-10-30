'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {notify,SITE}=require('../scripts/notify-publication.cjs');
const env={NOTICE_EVENT:'b'.repeat(64),GITHUB_REPOSITORY:'EvgeniaELF/zhazhda-poryadka-tablo',GITHUB_REPOSITORY_ID:'1297869392',GITHUB_REPOSITORY_OWNER_ID:'250887240',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:'EvgeniaELF/zhazhda-poryadka-tablo/.github/workflows/buildin-board.yml@refs/heads/main',GITHUB_SERVER_URL:'https://github.com',GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40),NAVIGATOR_TELEGRAM_BOT_TOKEN:'123456789:FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY_12345',NAVIGATOR_ADMIN_TELEGRAM_ID:'987654321'};
function fixture(custom=()=>{}){
  const calls=[],logs=[],waits=[];
  const manifest={schema:1,publication:{runId:'12345',runAttempt:'1',sha:env.GITHUB_SHA},members:[{cardId:'p04',name:'Женя · болид №9'}],events:[{key:env.NOTICE_EVENT,cardId:'p04',round:17,event:'Старт'}]};
  const page='<meta name="tablo-publication" content="12345.1.'+env.GITHUB_SHA+'">';
  const botUrl='https://api.telegram.org/bot'+env.NAVIGATOR_TELEGRAM_BOT_TOKEN+'/';
  const fetchImpl=async(url,init)=>{
    assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);calls.push({url,init});
    const value=await custom(url,init,{manifest,calls,page,botUrl});if(value!==undefined)return value;
    if(url===SITE+'cards.json?v=12345.1')return Response.json(manifest);
    if(url===SITE+'?v=12345.1')return new Response(page);
    if(url===botUrl+'getMe')return Response.json({ok:true,result:{id:123456789,is_bot:true,username:'navigator_admin_bot'}});
    if(url===botUrl+'sendMessage')return Response.json({ok:true,result:{message_id:77,chat:{id:Number(env.NAVIGATOR_ADMIN_TELEGRAM_ID),type:'private'}}});
    assert.fail('Unexpected network target');
  };
  return {manifest,calls,logs,waits,options:{fetchImpl,report:s=>logs.push(s),sleep:async ms=>waits.push(ms)}};
}
test('GitHub verifies the exact release, sends participant-ready cards, then a separate owner menu without Yandex',async()=>{
  const r=fixture();assert.deepEqual(await notify(env,r.options),{status:'delivered'});
  assert.deepEqual(r.calls.map(c=>new URL(c.url).hostname),['evgeniaelf.github.io','evgeniaelf.github.io','api.telegram.org','api.telegram.org','api.telegram.org']);
  const payload=JSON.parse(r.calls[3].init.body);
  assert.equal(payload.chat_id,Number(env.NAVIGATOR_ADMIN_TELEGRAM_ID));assert.match(payload.text,/Женя · болид №9/);
  assert.equal(payload.parse_mode,'HTML');assert.equal(payload.text,'✅ Карточки обновлены.\n\nСтарт 17 круга · принят 🏎️\nкарточки Личный трек и Личный рубеж можно посмотреть и скачать тут: <a href="'+SITE+'?v=12345.1#card=p04&amp;round=17">Женя · болид №9</a>');
  assert.equal(payload.reply_markup,undefined);
  const menu=JSON.parse(r.calls[4].init.body);assert.equal(menu.chat_id,Number(env.NAVIGATOR_ADMIN_TELEGRAM_ID));assert.equal(menu.text,'Выбери следующее действие.');
  assert.deepEqual(menu.reply_markup.inline_keyboard,[[{text:'Ещё отметка в этом круге',callback_data:'r:17'}],[{text:'← В меню',callback_data:'home'}]]);
  assert.deepEqual(r.logs,['PUBLICATION_VERIFIED','TELEGRAM_DELIVERED','TELEGRAM_MENU_DELIVERED']);
  for(const c of r.calls.slice(0,2)){assert.equal(c.init.method,'GET');assert.ok(!JSON.stringify(c.init).includes(env.NAVIGATOR_TELEGRAM_BOT_TOKEN));}
});
test('empty notice from scheduled or ordinary manual publication never touches any credential or network',async()=>{
  assert.deepEqual(await notify({NOTICE_EVENT:''},{fetchImpl:()=>assert.fail('No request')}),{status:'skipped'});
});
test('wrong repository, workflow, branch, event, run and origin are rejected before network access',async()=>{
  const bad=[{GITHUB_REPOSITORY:'attacker/repo'},{GITHUB_REPOSITORY_ID:'9'},{GITHUB_REPOSITORY_OWNER_ID:'9'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_REF:'refs/heads/other'},{GITHUB_WORKFLOW_REF:env.GITHUB_WORKFLOW_REF.replace('buildin-board.yml','other.yml')},{GITHUB_SERVER_URL:'https://wrong.test'},{GITHUB_RUN_ID:'1\nINJECT'},{GITHUB_RUN_ATTEMPT:'0'},{GITHUB_SHA:'bad'},{NOTICE_EVENT:'bad'}];
  for(const change of bad)await assert.rejects(notify({...env,...change},{fetchImpl:()=>assert.fail('No request')}),/INVALID_NOTICE_CONTEXT/);
});
test('missing and malformed bot/owner secrets fail closed before reading Pages or Telegram',async()=>{
  for(const change of [{NAVIGATOR_TELEGRAM_BOT_TOKEN:''},{NAVIGATOR_TELEGRAM_BOT_TOKEN:'secret\nINJECT'},{NAVIGATOR_ADMIN_TELEGRAM_ID:'@someone'},{NAVIGATOR_ADMIN_TELEGRAM_ID:'-1'},{NAVIGATOR_ADMIN_TELEGRAM_ID:'9007199254740992'}])await assert.rejects(notify({...env,...change},{fetchImpl:()=>assert.fail('No request')}),/TELEGRAM_NOT_CONFIGURED/);
});
test('stale manifest and stale HTML cannot send a current-card claim; retries stay on the public site',async()=>{
  for(const which of ['manifest','html']){
    const r=fixture((url,init,{manifest})=>url===SITE+(which==='manifest'?'cards.json?v=12345.1':'?v=12345.1')?(which==='manifest'?Response.json({...manifest,publication:{...manifest.publication,runId:'old'}}):new Response('old page')):undefined);
    await assert.rejects(notify(env,r.options),/PUBLICATION_NOT_READY/);assert.equal(r.waits.length,5);assert.ok(r.calls.every(c=>c.url.startsWith(SITE)));
  }
});
test('Pages propagation may be retried before sending, and each successful message is sent once',async()=>{
  let reads=0;const r=fixture((url,init,{manifest})=>url.includes('cards.json')&&++reads<3?Response.json({...manifest,publication:null}):undefined);
  await notify(env,r.options);assert.equal(reads,3);assert.deepEqual(r.waits,[5000,5000]);assert.equal(r.calls.filter(c=>c.url.endsWith('/sendMessage')).length,2);
});
test('removed or duplicated event is not announced, and ambiguous participant mapping cannot choose another person',async()=>{
  for(const variant of ['missing','duplicate','member']){
    const r=fixture();if(variant==='missing')r.manifest.events=[];else if(variant==='duplicate')r.manifest.events.push(r.manifest.events[0]);else r.manifest.members.push(r.manifest.members[0]);
    await assert.rejects(notify(env,r.options),/PUBLICATION_(EVENT_NOT_FOUND|INVALID_CARD)/);assert.ok(r.calls.every(c=>c.url.startsWith(SITE)));
  }
});
test('active-content card IDs, invalid dates/rounds, controls and unknown event types never enter Telegram',async()=>{
  for(const change of [{cardId:'p04\nINJECT'},{round:0},{round:'17'},{round:1000},{event:'Custom'}]){
    const r=fixture();Object.assign(r.manifest.events[0],change);await assert.rejects(notify(env,r.options),/PUBLICATION_INVALID_CARD/);assert.ok(r.calls.every(c=>c.url.startsWith(SITE)));
  }
  const r=fixture();r.manifest.members[0].name='PRIVATE\nINJECT';await assert.rejects(notify(env,r.options),/PUBLICATION_INVALID_CARD/);
});
test('extra public-manifest recipient or URL fields cannot redirect the message or its link',async()=>{
  const r=fixture();Object.assign(r.manifest,{chat_id:1,url:'https://wrong.test'});Object.assign(r.manifest.events[0],{chat_id:1,url:'https://wrong.test'});
  await notify(env,r.options);const payload=JSON.parse(r.calls.at(-1).init.body);assert.equal(payload.chat_id,Number(env.NAVIGATOR_ADMIN_TELEGRAM_ID));assert.ok(!JSON.stringify(payload).includes('wrong.test'));
});
test('an unrecognized bot is rejected before any message write',async()=>{
  const r=fixture(url=>url.endsWith('/getMe')?Response.json({ok:true,result:{id:123456789,is_bot:true,username:'wrong_bot'}}):undefined);
  await assert.rejects(notify(env,r.options),/TELEGRAM_WRONG_BOT/);assert.ok(!r.calls.some(c=>c.url.endsWith('/sendMessage')));
});
test('a failed read-only bot check does not try sending or reveal Telegram error text',async()=>{
  const r=fixture(url=>url.endsWith('/getMe')?Response.json({ok:false,error_code:401,description:'PRIVATE '+env.NAVIGATOR_TELEGRAM_BOT_TOKEN},{status:401}):undefined);
  await assert.rejects(notify(env,r.options),e=>e.message==='TELEGRAM_TOKEN_REJECTED');assert.ok(!r.calls.some(c=>c.url.endsWith('/sendMessage')));assert.ok(!JSON.stringify(r.logs).includes('PRIVATE'));
});
test('timeouts, invalid JSON and negative Telegram replies never cause a blind repeated send',async()=>{
  for(const mode of ['network','json',400,403,429]){
    const r=fixture(url=>{if(!url.endsWith('/sendMessage'))return;
      if(mode==='network')throw new Error('PRIVATE '+env.NAVIGATOR_TELEGRAM_BOT_TOKEN);
      if(mode==='json')return new Response('PRIVATE '+env.NAVIGATOR_TELEGRAM_BOT_TOKEN);
      return Response.json({ok:false,error_code:mode,description:'PRIVATE '+env.NAVIGATOR_TELEGRAM_BOT_TOKEN},{status:mode});
    });
    await assert.rejects(notify(env,r.options),e=>!e.message.includes('PRIVATE')&&/^TELEGRAM_/.test(e.message));assert.equal(r.calls.filter(c=>c.url.endsWith('/sendMessage')).length,1);assert.equal(r.waits.length,0);
  }
});
test('Telegram success without a matching private recipient and message ID is unconfirmed',async()=>{
  for(const result of [null,{}, {message_id:77,chat:{id:1,type:'private'}},{message_id:77,chat:{id:Number(env.NAVIGATOR_ADMIN_TELEGRAM_ID),type:'group'}}]){
    const r=fixture(url=>url.endsWith('/sendMessage')?Response.json({ok:true,result}):undefined);await assert.rejects(notify(env,r.options),/TELEGRAM_DELIVERY_UNCONFIRMED/);
  }
});
test('oversized public response and redirect responses cannot carry a bot token to another host',async()=>{
  for(const kind of ['large','redirect']){
    const r=fixture(url=>url.startsWith(SITE)?(kind==='large'?new Response('x'.repeat(300000)):new Response(null,{status:302,headers:{Location:'https://wrong.test'}})):undefined);
    await assert.rejects(notify(env,r.options),/PUBLICATION_NOT_READY/);assert.ok(r.calls.every(c=>c.url.startsWith(SITE)));assert.ok(r.calls.every(c=>!JSON.stringify(c.init).includes(env.NAVIGATOR_TELEGRAM_BOT_TOKEN)));
  }
});
module.exports={env,fixture};
test('participant names and the personal link are escaped for Telegram HTML',async()=>{
  const r=fixture();r.manifest.members[0].name='Женя & <b>"№9"</b>';
  await notify(env,r.options);const card=JSON.parse(r.calls[3].init.body);
  assert.ok(card.text.includes('Женя &amp; &lt;b&gt;&quot;№9&quot;&lt;/b&gt;'));
  assert.ok(card.text.includes('#card=p04&amp;round=17'));assert.ok(!card.text.includes('<b>'));
  assert.equal(card.reply_markup,undefined);assert.equal(card.parse_mode,'HTML');
});
test('finish text and the separate menu keep the exact published round and participant',async()=>{
  const r=fixture();r.manifest.members[0].name='Болид №7';Object.assign(r.manifest.events[0],{event:'Финиш',round:16});
  await notify(env,r.options);const card=JSON.parse(r.calls[3].init.body),menu=JSON.parse(r.calls[4].init.body);
  assert.ok(card.text.includes('Финиш 16 круга · принят 🏎️'));assert.ok(card.text.endsWith('>Болид №7</a>'));
  assert.ok(card.text.includes('round=16'));assert.equal(menu.reply_markup.inline_keyboard[0][0].callback_data,'r:16');
});
test('an uncertain or rejected menu does not repeat delivered cards and reports only menu failure',async()=>{
  for(const mode of ['network','json',400,403,429]){
    const r=fixture((url,init,{calls})=>{
      if(!url.endsWith('/sendMessage')||calls.filter(c=>c.url.endsWith('/sendMessage')).length!==2)return;
      if(mode==='network')throw Error('PRIVATE');
      if(mode==='json')return new Response('PRIVATE');
      return Response.json({ok:false,error_code:mode,description:'PRIVATE'},{status:mode});
    });
    await assert.rejects(notify(env,r.options),e=>e.message==='TELEGRAM_MENU_UNCONFIRMED');
    assert.deepEqual(r.logs,['PUBLICATION_VERIFIED','TELEGRAM_DELIVERED']);
    assert.equal(r.calls.filter(c=>c.url.endsWith('/sendMessage')).length,2);assert.equal(r.waits.length,0);
  }
});
test('the menu is not confirmed for a wrong recipient, group, absent or invalid message ID',async()=>{
  for(const result of [null,{}, {message_id:0,chat:{id:Number(env.NAVIGATOR_ADMIN_TELEGRAM_ID),type:'private'}},{message_id:78,chat:{id:1,type:'private'}},{message_id:78,chat:{id:Number(env.NAVIGATOR_ADMIN_TELEGRAM_ID),type:'group'}}]){
    const r=fixture((url,init,{calls})=>url.endsWith('/sendMessage')&&calls.filter(c=>c.url.endsWith('/sendMessage')).length===2?Response.json({ok:true,result}):undefined);
    await assert.rejects(notify(env,r.options),/TELEGRAM_MENU_UNCONFIRMED/);
    assert.deepEqual(r.logs,['PUBLICATION_VERIFIED','TELEGRAM_DELIVERED']);assert.equal(r.calls.filter(c=>c.url.endsWith('/sendMessage')).length,2);
  }
});
