'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {core,rows,sourceSchema,eventSchema,config,html}=require('./fixtures/participants.cjs');
test('полная управляемая сборка проверяет схему API и не публикует служебные идентификаторы',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'managed-board-')),oldFetch=global.fetch;
  const keys=['BUILDIN_API_TOKEN','BUILDIN_PARTICIPANT_MANAGEMENT','PARTICIPANT_PUBLISH','PARTICIPANT_BOOTSTRAP_DIGEST','GITHUB_STEP_SUMMARY','GITHUB_OUTPUT','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA'];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
    const repo=path.join(__dirname,'..');
    for(const file of await fs.readdir(repo))if(file==='index.html'||file==='buildin-sync.json'||file==='personal-links.js'||file==='participation.js'||/\.(webp|svg|png)$/.test(file))await fs.copyFile(path.join(repo,file),path.join(dir,file));
    await fs.writeFile(path.join(dir,'participant-state-input.json'),'null');await fs.writeFile(path.join(dir,'participant-state-meta.json'),JSON.stringify({head:null,blob:null}));
    for(const key of keys)delete process.env[key];
    Object.assign(process.env,{BUILDIN_API_TOKEN:'FAKE_TEST_SECRET',BUILDIN_PARTICIPANT_MANAGEMENT:'true',PARTICIPANT_PUBLISH:'false'});
    const calls=[];
    global.fetch=async(url,options)=>{
      calls.push([url,options.method]);assert.ok(url.startsWith('https://api.buildin.ai/v2/databases/'));
      const source=url.includes(config.participantsDatabaseId),query=url.endsWith('/query');
      assert.equal(options.method,query?'POST':'GET');
      return Response.json(query?{object:'list',results:source?rows():[],has_more:false}:{object:'database',id:source?config.participantsDatabaseId:config.eventsDatabaseId,...(source?sourceSchema:eventSchema)});
    };
    await core.run(dir);
    const built=await fs.readFile(path.join(dir,'_site/index.html'),'utf8'),report=JSON.parse(await fs.readFile(path.join(dir,'sync-report.json'),'utf8'));
    assert.equal(calls.length,4);assert.equal(report.participants,17);assert.match(report.bootstrapDigest,/^[a-f0-9]{64}$/);
    const candidate=JSON.parse(await fs.readFile(path.join(dir,'participant-state-candidate.json'),'utf8'));assert.equal(candidate.bindings.length,17);
    for(const r of rows())assert.equal(built.includes(r.id),false);assert.equal(built.includes('FAKE_TEST_SECRET'),false);assert.equal(built.includes('participant-state'),false);
    assert.ok(built.includes('src="participation.js"'));assert.ok((await fs.readdir(path.join(dir,'_site'))).includes('participation.js'));
    assert.equal(await fs.readFile(path.join(dir,'index.html'),'utf8'),html);
    // First publication is refused unless the reviewed migration is explicitly confirmed.
    process.env.PARTICIPANT_PUBLISH='true';
    await assert.rejects(core.run(dir),/Первый перенос не подтверждён/);
    process.env.PARTICIPANT_BOOTSTRAP_DIGEST=report.bootstrapDigest;
    await core.run(dir);assert.equal(JSON.parse(await fs.readFile(path.join(dir,'participant-state-meta.json'),'utf8')).bootstrapApproved,true);
    // A subsequent preview starts from the accepted snapshot, preserving identity.
    process.env.PARTICIPANT_PUBLISH='false';delete process.env.PARTICIPANT_BOOTSTRAP_DIGEST;
    await fs.writeFile(path.join(dir,'participant-state-input.json'),JSON.stringify(candidate));
    await core.run(dir);assert.equal(JSON.parse(await fs.readFile(path.join(dir,'sync-report.json'),'utf8')).bootstrapDigest,null);
    process.env.BUILDIN_PARTICIPANT_MANAGEMENT='false';
    await assert.rejects(core.run(dir),/Прежний режим не может/);
  }finally{
    global.fetch=oldFetch;for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
    await fs.rm(dir,{recursive:true,force:true});
  }
});
