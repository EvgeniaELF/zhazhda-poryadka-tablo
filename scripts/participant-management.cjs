'use strict';
// Buildin stays read-only. Accepted history lives on a dedicated Git branch.
const {createHash} = require('node:crypto');
const core = require('./buildin-board.cjs');
const links = require('../personal-links.js');
const {roundForDate,segments} = require('../participation.js');
const DAY = 86400000;
const FIELDS = {
  firstReport:['Дата старта','date'], joinedRound:['Круг присоединения','number'],
  pauseDate:['Дата начала пит-стопа','date'], pauseRound:['Пит-стоп с круга','number'],
  returnDate:['Дата возвращения','date'], ready:['Готово к табло','checkbox']
};
const hash = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const fail = message => { throw new core.SafeError(message); };
const sourceKey = id => hash('zhazhda-poryadka:participant:v1:' + id.toLowerCase());
const boardFingerprint = base => hash(base);
const shiftDate = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const todayInMoscow = now => new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
// Diagnose a rejected API date without logging the page or original values.
function dateShape(value, depth=0) {
  if (value === null) return {type:'null'};
  if (Array.isArray(value)) return {type:'array',length:value.length};
  const type = typeof value;
  if (type === 'string') return {
    type, length:value.length,
    pattern:value.slice(0,64).replace(/[0-9]/g,'0').replace(/[A-Za-z]/g,'A').replace(/[^0A :./+\-]/gu,'?'),
    dateOnly:/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(value),
    midnight:/^\d{4}[-/]\d{2}[-/]\d{2}[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value)
  };
  if (type !== 'object' || depth >= 2) return {type};
  const fields = {};
  for (const key of ['start','end','time_zone','date','value','timestamp','startDate','endDate','startTime','endTime','start_date','end_date','start_time','end_time','includeTime','include_time','showTime','isRange']) {
    if (Object.hasOwn(value,key)) fields[key] = dateShape(value[key],depth+1);
  }
  return {type,fieldCount:Object.keys(value).length,fields,
    equalStartEnd:typeof value.start === 'string' && typeof value.end === 'string' && value.start === value.end};
}
function dateValue(page, field) {
  const v = core.value(page, field).date;
  if (v === null) return null;
  if (!v || v.end || typeof v.start !== 'string' || !/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(v.start)) fail('«' + field.name + '»: нужна одна дата без времени и диапазона. DATE_SHAPE=' + JSON.stringify(dateShape(v)));
  const iso = v.start.replaceAll('/', '-'), t = Date.parse(iso + 'T00:00:00Z');
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== iso) fail('«' + field.name + '»: неверная календарная дата.');
  return iso;
}
function numberValue(page, field, max) {
  const n = core.value(page, field).number;
  if (n === null) return null;
  if (!Number.isInteger(n) || n < 1 || n > max) fail('«' + field.name + '»: нужен целый номер круга от 1 до ' + max + '.');
  return n;
}
function readControls(row, fields, current) {
  const ready = core.value(row, fields.ready).checkbox;
  if (typeof ready !== 'boolean') fail('«Готово к табло» должно быть чекбоксом.');
  if (!ready) return {ready:false};
  return {ready, firstReport:dateValue(row, fields.firstReport), joinedRound:numberValue(row, fields.joinedRound, current),
    pauseDate:dateValue(row, fields.pauseDate), pauseRound:numberValue(row, fields.pauseRound, current + 1), returnDate:dateValue(row, fields.returnDate)};
}
function validatePauses(person) {
  let lastEnd = null;
  for (const p of person.trackPauses || []) {
    for (const d of [p.pausedAt, p.resumedAt].filter(Boolean)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d+'T00:00:00Z')) || shiftDate(d,0)!==d) fail('Повреждена сохранённая дата пит-стопа.');
    }
    const start = shiftDate(p.pausedAt, 1);
    if (start < person.firstReport || (lastEnd && start < lastEnd) || (p.resumedAt && p.resumedAt <= start)) fail('Периоды пит-стопа пересекаются или имеют неверный порядок.');
    if (lastEnd === Infinity) fail('Перед новым пит-стопом нужно сохранить возвращение из предыдущего.');
    if (p.pitStopRound != null && (!Number.isInteger(p.pitStopRound) || p.pitStopRound < person.joinedRound || (p.resumedAt && p.pitStopRound > roundForDate(p.resumedAt)))) fail('Круг пит-стопа не согласован с периодом участия.');
    lastEnd = p.resumedAt || Infinity;
  }
}
function validateState(state, base) {
  if (!state || state.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 1 || state.baseline !== boardFingerprint(base) || !Array.isArray(state.bindings) || !Array.isArray(state.events)) fail('Служебная история не соответствует исходному табло. Нужна сверка; автоматический сброс запрещён.');
  const {checksum, ...payload} = state;
  if (checksum !== hash(payload)) fail('Контрольная сумма служебной истории не совпала.');
  const board = state.board;
  if (!Array.isArray(board?.members) || !Array.isArray(board?.rounds) || !Array.isArray(board?.seasons)) fail('Повреждена структура служебной истории.');
  const cards = new Set(), keys = new Set(), names = new Set();
  for (const b of state.bindings) {
    if (!/^[a-f0-9]{64}$/.test(b.key) || keys.has(b.key) || cards.has(b.cardId) || !links.validCard(b.cardId)) fail('Повреждено постоянное сопоставление участниц.');
    keys.add(b.key);cards.add(b.cardId);
    if (!Array.isArray(b.names) || !b.names.length || b.names.some(n=>typeof n!=='string')) fail('Повреждена история подписей.');
  }
  for (const p of board.members) {
    if (!cards.has(p.cardId) || names.has(p.name) || typeof p.firstReport !== 'string' || !Number.isInteger(p.joinedRound)) fail('Повреждены сохранённые профили.');
    names.add(p.name);validatePauses(p);
  }
  if (board.members.length !== state.bindings.length || new Set(board.members.map(p=>p.cardId)).size !== cards.size || base.members.some(p=>!cards.has(p.cardId))) fail('Из служебной истории исчез прежний профиль.');
  const seen = new Set();
  for (const e of state.events) {
    if (!/^[a-f0-9]{64}$/.test(e.key) || seen.has(e.key) || !cards.has(e.cardId) || !['Старт','Финиш'].includes(e.event) || !Number.isInteger(e.round) || e.round < 1) fail('Повреждена история событий.');
    seen.add(e.key);
  }
  return state;
}
function sealState(payload, previous) {
  const compare = s => JSON.stringify({baseline:s.baseline, board:s.board, bindings:s.bindings, events:s.events});
  if (previous && compare(payload) === compare(previous)) return previous;
  const result = {schema:1, revision:(previous?.revision || 0)+1, ...payload};
  return {...result, checksum:hash(result)};
}
function acceptedProfile(member, controls, status, current, today, rounds) {
  if (!controls.ready) return member;
  if (!controls.firstReport || !controls.joinedRound) fail('Перед подтверждением заполни «Дата старта» и «Круг присоединения».');
  if (controls.firstReport > today) fail('Дата старта ещё не наступила. Оставь карточку черновиком.');
  if (member.firstReport !== controls.firstReport || member.joinedRound !== controls.joinedRound) fail('Изменены уже принятые дата старта или круг присоединения. Нужна отдельная сверка истории.');
  if (Boolean(controls.pauseDate) !== Boolean(controls.pauseRound)) fail('Для пит-стопа укажи и дату начала, и круг.');
  if (controls.returnDate && !controls.pauseDate) fail('Укажи, из какого пит-стопа возвращается участница.');
  if (controls.pauseDate) {
    if (controls.pauseDate > today || controls.pauseDate < member.firstReport) fail('Дата начала пит-стопа вне прошедшего периода участия.');
    if (controls.returnDate && (controls.returnDate <= controls.pauseDate || controls.returnDate > today)) fail('Возвращение должно быть после начала паузы и не позже сегодняшнего дня.');
    const pauses = member.trackPauses ||= [];
    const last = pauses.at(-1), pausedAt = shiftDate(controls.pauseDate, -1);
    if (last?.pausedAt === pausedAt) {
      const oldRound = last.pitStopRound ?? member.pitStopRound ?? segments(member,rounds).at(-1)?.start;
      if (oldRound != null && oldRound !== controls.pauseRound) fail('Изменён уже принятый круг пит-стопа. Нужна сверка.');
      if (last.resumedAt && last.resumedAt !== controls.returnDate) fail('Не удаляй и не меняй уже сохранённую дату возвращения.');
      last.pitStopRound = controls.pauseRound;
      last.resumedAt = controls.returnDate;
    } else {
      if (last && !last.resumedAt) fail('Сначала сохрани возвращение и выполни обновление GitHub, затем вводи следующий пит-стоп.');
      pauses.push({pausedAt, resumedAt:controls.returnDate, pitStopRound:controls.pauseRound});
    }
    member.pitStopRound = controls.pauseRound;
  } else if (member.trackPauses?.length) fail('История пит-стопа уже принята. Сохраняй последние даты в карточке, прежние эпизоды остаются в архиве.');
  validatePauses(member);
  const open = (member.trackPauses || []).some(p=>!p.resumedAt);
  if ((status === 'На пит-стопе') !== open) fail('Согласуй статус с датами: открытая пауза — «На пит-стопе», возвращение — «На треке».');
  return member;
}
function mergeManaged(base, sourceRows, eventRows, sourceSchema, eventSchema, config, now, previous = null) {
  const {sf, ef} = core.schemas(sourceSchema,eventSchema,config);
  const fields = Object.fromEntries(Object.entries(FIELDS).map(([k,[name,type]])=>[k,core.field(sourceSchema,name,[type])]));
  if (previous) validateState(previous,base);
  const board = structuredClone(previous?.board || base);
  delete board.publication;
  const current = core.currentCalendar(board, now), today = todayInMoscow(now);
  const bindings = structuredClone(previous?.bindings || []), byKey = new Map(bindings.map(b=>[b.key,b]));
  const byCard = new Map(board.members.map(p=>[p.cardId,p])), bySource = new Map(), rowKeys = new Set(), activeKeys = new Set();
  const changes = [], drafts = [];
  // Binding by name is allowed only during the reviewable first migration.
  const legacyNames = new Map(base.members.map(p=>[core.normalize(p.name),p.cardId]));
  for (const row of sourceRows) {
    const id = core.pageId(row), key = sourceKey(id);
    if (rowKeys.has(key)) fail('Buildin вернул повторную запись участницы.');
    rowKeys.add(key);
    if (row.archived || row.in_trash) continue;
    const name = core.title(row,sf.title), controls = readControls(row,fields,current);
    if (!controls.ready && !byKey.has(key) && (previous || !legacyNames.has(name))) {drafts.push(name || 'Новая карточка');continue;}
    if (!name || name.length > 100 || /[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(name)) fail('Укажи публичную подпись участницы без служебных символов, до 100 знаков.');
    const v = core.value(row,sf.status), status = v.select?.name ?? v.status?.name;
    if (!['На треке','На пит-стопе'].includes(status)) fail('Неизвестный статус участницы.');
    let binding = byKey.get(key);
    if (!binding && !previous && legacyNames.has(name)) {
      const cardId = legacyNames.get(name);
      if (bindings.some(b=>b.cardId===cardId)) fail('Две записи претендуют на одну прежнюю личную ссылку.');
      binding = {key,cardId,names:[name]};bindings.push(binding);byKey.set(key,binding);
    }
    if (!binding) {
      if (!controls.ready) {drafts.push(name);continue;}
      if (!controls.firstReport || !controls.joinedRound) fail('У новой участницы нужны дата старта и круг присоединения.');
      if (legacyNames.has(name)) fail('Новая запись повторяет прежнюю участницу. Не пересоздавай её карточку.');
      const cardId = 'p' + key.slice(0,16);
      if (byCard.has(cardId)) fail('Коллизия постоянных ссылок. Публикация остановлена.');
      binding = {key,cardId,names:[name]};bindings.push(binding);byKey.set(key,binding);
      const person = {cardId,name,firstReport:controls.firstReport,joinedRound:controls.joinedRound};
      board.members.push(person);byCard.set(cardId,person);
      changes.push({cardId,action:'Новая участница'});
    }
    const person = byCard.get(binding.cardId);
    if(!previous && !controls.ready && ((status==='На пит-стопе') !== (person.trackPauses || []).some(p=>!p.resumedAt))) fail('При первом переносе статус отличается от прежнего табло. Сначала сверь паузу и даты.');
    const before = JSON.stringify(person);
    if (controls.ready) {
      if (person.name !== name) {
        const oldName = person.name;
        for (const r of board.rounds) if (Object.hasOwn(r.marks,oldName)) {
          if (Object.hasOwn(r.marks,name)) fail('Переименование смешает историю двух участниц. Выбери различимые подписи.');
          Object.defineProperty(r.marks,name,{value:r.marks[oldName],enumerable:true,writable:true,configurable:true});delete r.marks[oldName];
        }
        person.name = name;
        if (!binding.names.includes(name)) binding.names.push(name);
      }
      acceptedProfile(person,controls,status,current,today,board.rounds);
    }
    if (before !== JSON.stringify(person)) changes.push({cardId:person.cardId,action:'Обновление профиля'});
    bySource.set(id,{member:person,binding});activeKeys.add(key);
  }
  if (bindings.some(b=>!activeKeys.has(b.key))) fail('Из Buildin исчезла ранее принятая участница. История и сайт сохранены; нужна сверка.');
  if (!previous && base.members.some(p=>!bindings.some(b=>b.cardId===p.cardId))) fail('Не найдены все 17 прежних карточек. Первое сопоставление не подтверждено.');
  const names = new Set();
  for (const p of board.members) {
    if (names.has(p.name) || ['__proto__','constructor','prototype'].includes(p.name)) fail('Публичные подписи должны различаться. Добавь номер болида для тёзок.');
    names.add(p.name);
  }
  const seen = new Set(), acceptedEvents = [], previousEvents = new Map((previous?.events || []).map(e=>[e.key,e]));
  const report = {version:'2.0.0',checkedAt:now.toISOString(),participants:board.members.length,sourceEvents:0,uniqueMarks:0,duplicates:0,legacyNameMatches:0,added:[],events:acceptedEvents,preservedHistory:true,drafts,profileChanges:changes};
  for (const row of eventRows) {
    const key = core.eventKey(core.pageId(row));
    if (row.archived || row.in_trash) continue;
    report.sourceEvents++;
    const round = core.value(row,ef.round).number, kind = core.value(row,ef.kind).select?.name;
    if (!Number.isInteger(round) || round < 1 || round > current || !['Старт','Финиш'].includes(kind)) fail('Некорректный круг или тип события.');
    const relation = core.value(row,ef.person);
    if (!Array.isArray(relation.relation) || relation.has_more || relation.relation.length > 1) fail('Событию нужна одна полная связь с участницей.');
    let person;
    if (relation.relation.length) person = bySource.get(relation.relation[0].id?.toLowerCase())?.member;
    else if (previousEvents.has(key)) person = byCard.get(previousEvents.get(key).cardId);
    else {
      const name = core.title(row,ef.title), matches = bindings.filter(b=>b.names.includes(name));
      if (matches.length === 1) person = byCard.get(matches[0].cardId);
      report.legacyNameMatches++;
    }
    if (!person) fail('Событие относится к неизвестной или неподтверждённой участнице.');
    if (round < person.joinedRound) fail('Событие предшествует кругу присоединения.');
    const descriptor = {key,cardId:person.cardId,round,event:kind};
    const was = previousEvents.get(key);
    if (was && JSON.stringify(was)!==JSON.stringify(descriptor)) fail('Изменено уже принятое событие. Нужна отдельная сверка истории.');
    if (acceptedEvents.some(e=>e.key===key)) fail('Buildin повторил ID события.');
    acceptedEvents.push(descriptor);
    const pair = person.cardId+':'+round+':'+kind;
    if (seen.has(pair)) {report.duplicates++;continue;}seen.add(pair);report.uniqueMarks++;
    const r = board.rounds.find(r=>r.number===round), old = r.marks[person.name] || {}, flag = kind==='Старт'?'entered':'finished';
    if (old.pit || old.skip || old.startIcon) fail('Событие конфликтует с особой исторической отметкой. Нужна сверка.');
    // An already accepted mark survives a later administrative pause.
    if (!old[flag] && segments(person,board.rounds).some(p=>round>=p.start && round<p.end)) fail('Новое событие попало в круг пит-стопа. Сначала проверь даты возвращения.');
    if (!old[flag]) report.added.push({participant:person.name,round,event:kind});
    const mark = {entered:false,finished:false,pit:false,late:false,...old,[flag]:true};
    mark.lastMark=mark.entered&&mark.finished?'Старт и финиш '+round+'-го круга отмечены. Оба чек-поинта круга приняты.':mark.finished?'Финиш '+round+'-го круга отмечен.':'Заезд на '+round+'-й круг отмечен.';
    Object.defineProperty(r.marks,person.name,{value:mark,enumerable:true,writable:true,configurable:true});
    if (!old[flag]) r.updated = new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric'}).format(now).replace(/ г\.$/,'');
  }
  if ((previous?.events || []).some(e=>!acceptedEvents.some(n=>n.key===e.key))) fail('Из Buildin исчезло уже принятое событие. История не удалена; нужна сверка.');
  acceptedEvents.sort((a,b)=>a.key.localeCompare(b.key));bindings.sort((a,b)=>a.cardId.localeCompare(b.cardId));
  const bootstrapDigest = hash({baseline:boardFingerprint(base),bindings:bindings.filter(b=>base.members.some(p=>p.cardId===b.cardId))});
  report.bootstrapDigest = previous ? null : bootstrapDigest;
  report.participantsPreview=board.members.map(p=>({cardId:p.cardId,name:p.name,firstReport:p.firstReport,joinedRound:p.joinedRound,pauses:p.trackPauses || []}));
  const state = sealState({baseline:boardFingerprint(base),board:structuredClone(board),bindings,events:acceptedEvents},previous);
  return {board,report,state};
}
module.exports = {FIELDS,sourceKey,hash,boardFingerprint,shiftDate,dateValue,validateState,mergeManaged};
