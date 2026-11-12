'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const core=require('../../scripts/buildin-board.cjs'),management=require('../../scripts/participant-management.cjs'),links=require('../../personal-links.js'),participation=require('../../participation.js');
const config=require('../../buildin-sync.json'),html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8'),base=core.boardPart(html).board;
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),prop=(type,v)=>({type,[type]:v}),txt=s=>[{plain_text:s}];
const sourceSchema={properties:{Участник:{name:'Участник',type:'title'},Статус:{name:'Статус',type:'select'}}};
for(const [name,type] of Object.values(management.FIELDS))sourceSchema.properties[name]={name,type};
const eventSchema={properties:{Участник:{type:'title'},Круг:{type:'number'},Событие:{type:'select'},'Карточка участника':{type:'relation',relation:{database_id:config.participantsDatabaseId}}}};
const initialTime=new Date('2026-11-12T12:00:00Z');
function row(n,name,status='На треке',data={}){
  const properties={Участник:prop('title',txt(name)),Статус:prop('select',{name:status})};
  for(const [key,[name,type]] of Object.entries(management.FIELDS)){
    const v=Object.hasOwn(data,key)?data[key]:type==='checkbox'?false:null;
    properties[name]=prop(type,type==='date'&&v?{start:v,end:null}:v);
  }
  return {object:'page',id:id(n),properties};
}
function rows(){return base.members.map((p,i)=>row(i+1,p.name,(p.trackPauses||[]).some(p=>!p.resumedAt)?'На пит-стопе':'На треке'));}
function approve(list,card,data,status){
  const i=base.members.findIndex(p=>p.cardId===card),p=base.members[i];
  list[i]=row(i+1,p.name,status||list[i].properties.Статус.select.name,{ready:true,firstReport:p.firstReport,joinedRound:p.joinedRound,...data});
  return list;
}
function event(n,person,round,kind='Старт'){
  return {object:'page',id:id(1000+n),properties:{Участник:prop('title',txt('может быть старое имя')),Круг:prop('number',round),Событие:prop('select',{name:kind}),'Карточка участника':prop('relation',[{id:id(person)}])}};
}
const merge=(list=rows(),events=[],previous=null,now=initialTime)=>management.mergeManaged(base,list,events,sourceSchema,eventSchema,config,now,previous);

module.exports={txt,core,management,links,participation,config,html,base,initialTime,rows,row,approve,event,sourceSchema,eventSchema,merge,id};
