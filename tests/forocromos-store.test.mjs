import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLocalForocromosStore } from '../scripts/local-forocromos-store.mjs';

const PREFIX = '/forocromos/v1';
async function fixture(t, existingDirectory) {
  const directory = existingDirectory || await mkdtemp(path.join(tmpdir(),'sx-forocromos-'));
  const sessions = new Map([['a','a@example.invalid'],['b','b@example.invalid'],['c','c@example.invalid']]);
  const store = await createLocalForocromosStore({ directory,
    getActor: req => sessions.has(req.headers['x-fixture-session']) ? { email: sessions.get(req.headers['x-fixture-session']) } : null });
  const server = createServer(async (req,res) => {
    try { await store.handle(req,res,new URL(req.url,'http://127.0.0.1')); }
    catch (error) { res.statusCode = error.status || 500; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({code:error.code,message:error.message})); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  const close = async () => { if (closed) return; closed = true;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await store.close(); };
  t.after(async () => { await close(); if (!existingDirectory) await rm(directory,{recursive:true,force:true}); });
  async function api(actor,route,method='GET',body) {
    const res = await fetch(origin + PREFIX + route,{method,headers:{ ...(actor ? {'x-fixture-session':actor} : {}),
      ...(body !== undefined ? {'content-type':'application/json'} : {}) },body:body === undefined ? undefined : JSON.stringify(body)});
    return {status:res.status,body:await res.json()};
  }
  async function topic(actor='a',extra={}) {
    const result = await api(actor,'/topics','POST',{category_id:'entre-companeras',title:'Una pregunta práctica',body:'Texto de prueba entre compañeras.',client_request_id:randomUUID(),...extra});
    assert.equal(result.status,201,JSON.stringify(result.body)); return result.body.topic;
  }
  async function reply(topicId,actor='b',extra={}) {
    const result = await api(actor,`/topics/${topicId}/replies`,'POST',{body:'Una respuesta de prueba.',client_request_id:randomUUID(),...extra});
    assert.equal(result.status,201,JSON.stringify(result.body)); return result.body.reply;
  }
  return { directory,store,sessions,origin,api,topic,reply,close };
}

test('Forocromos admits only seeded community members; session and role never come from JSON',async t => {
  const app = await fixture(t);
  assert.equal((await app.api(null,'/me')).status,401);
  assert.equal((await app.api('c','/me')).status,403);
  const a = await app.api('a','/me'), b = await app.api('b','/me');
  assert.equal(a.body.member.role,'moderator'); assert.equal(b.body.member.role,'member');
  assert.equal(b.body.member.alias,'Compañera B');
  assert.doesNotMatch(JSON.stringify(a.body),/@example|email/);
  const forged = await app.api('b','/topics','POST',{category_id:'ideas',title:'Una idea',body:'Texto',client_request_id:randomUUID(),role:'moderator',author_id:a.body.member.id});
  assert.equal(forged.status,400);
  assert.equal((await app.api('b','/memberships','POST',{email:'c@example.invalid',role:'moderator'})).status,404);
});

test('Forocromos keeps every known and guessed route private from external accounts',async t => {
  const app = await fixture(t), topic = await app.topic(), reply = await app.reply(topic.id);
  for (const [route,method,body] of [
    ['/categories','GET'],['/topics?q=prueba','GET'],[`/topics/${topic.id}`,'GET'],['/reports','GET'],
    ['/topics','POST',{category_id:'ideas',title:'x',body:'x',client_request_id:randomUUID()}],
    [`/topics/${topic.id}/replies`,'POST',{body:'x',client_request_id:randomUUID()}],
    [`/topics/${topic.id}`,'DELETE'],[`/replies/${reply.id}`,'DELETE'],
    [`/topics/${topic.id}/moderation`,'POST',{action:'hide'}],['/not-an-endpoint','GET']]) {
    const res = await app.api('c',route,method,body); assert.equal(res.status,403,route);
    assert.doesNotMatch(JSON.stringify(res.body),/Una pregunta|Una respuesta/);
  }
});

test('Forocromos creates a shared private thread, replies, bounded search and pagination',async t => {
  const app = await fixture(t);
  assert.equal((await app.api('a','/categories')).body.categories.length,3);
  const first = await app.topic('a',{title:'Turno y descanso',body:'Busco un plan cotidiano.'});
  await app.topic('b',{category_id:'vida-practica',title:'Transporte',body:'Probar cien por ciento 100%_literal'});
  const reply = await app.reply(first.id);
  const result = await app.api('b',`/topics/${first.id}`);
  assert.equal(result.body.replies[0].id,reply.id); assert.equal(result.body.total,1);
  assert.equal(result.body.topic.reply_count,1); assert.equal(result.body.topic.author.alias,'Compañera A');
  assert.equal((await app.api('a','/topics?limit=1')).body.has_more,true);
  assert.equal((await app.api('a','/topics?limit=1&offset=1')).body.topics.length,1);
  const search = await app.api('b','/topics?q=100%25_literal'); assert.equal(search.body.total,1);
  assert.equal((await app.api('b','/topics?category=ideas')).body.total,0);
  assert.doesNotMatch(JSON.stringify(result.body),/example.invalid|email/);
});

test('Forocromos rejects malformed text, unknown fields and unbounded or duplicate query parameters',async t => {
  const app = await fixture(t);
  for (const route of ['/topics?limit=0','/topics?limit=51','/topics?offset=10001','/topics?limit=1&limit=2','/topics?owner_id=a','/topics?category=not-real',`/topics?q=${'x'.repeat(101)}`]) {
    assert.equal((await app.api('a',route)).status,400,route);
  }
  const base = {category_id:'ideas',title:'Título',body:'Cuerpo',client_request_id:randomUUID()};
  for (const change of [{title:''},{title:'x'.repeat(121)},{body:'x'.repeat(5001)},{body:'\0x'},{client_request_id:'no'},{category_id:'not-real'},{owner:'b'}]) {
    assert.equal((await app.api('a','/topics','POST',{...base,...change})).status,400);
  }
  const large = await app.api('a','/topics','POST',{...base,body:'x'.repeat(17000)}); assert.equal(large.status,413);
  const malformed = await fetch(app.origin + PREFIX + '/topics',{method:'POST',headers:{'x-fixture-session':'a','content-type':'application/json'},body:'{'});
  assert.equal(malformed.status,400);
  const wrongType = await fetch(app.origin + PREFIX + '/topics',{method:'POST',headers:{'x-fixture-session':'a','content-type':'text/plain'},body:'{}'});
  assert.equal(wrongType.status,415);
});

test('Forocromos idempotency survives concurrent retry and rejects request-ID reuse with changed payload',async t => {
  const app = await fixture(t), body = {category_id:'ideas',title:'Idea única',body:'Mismo contenido.',client_request_id:randomUUID()};
  const attempts = await Promise.all([app.api('a','/topics','POST',body),app.api('a','/topics','POST',body)]);
  assert.deepEqual(attempts.map(x => x.status).sort(),[200,201]);
  assert.equal(attempts[0].body.topic.id,attempts[1].body.topic.id);
  assert.equal((await app.api('a','/topics','POST',{...body,body:'Diferente'})).status,409);
  const topicId = attempts[0].body.topic.id, replyBody = {body:'Respuesta única',client_request_id:randomUUID()};
  const first = await app.api('b',`/topics/${topicId}/replies`,'POST',replyBody);
  const second = await app.api('b',`/topics/${topicId}/replies`,'POST',replyBody);
  assert.equal(first.status,201); assert.equal(second.status,200); assert.equal(first.body.reply.id,second.body.reply.id);
  assert.equal((await app.api('b','/topics','POST',{...body,client_request_id:replyBody.client_request_id})).status,409);
  assert.equal((await app.api('a','/topics')).body.total,1);
});

test('Forocromos reports remain private to moderators, target validation cannot cross threads',async t => {
  const app = await fixture(t), topic = await app.topic(), other = await app.topic('b'), reply = await app.reply(topic.id);
  assert.equal((await app.api('b','/reports')).status,403);
  assert.equal((await app.api('b','/reports','POST',{topic_id:other.id,reply_id:reply.id,reason:'Este no corresponde.'})).status,404);
  const result = await app.api('b','/reports','POST',{topic_id:topic.id,reply_id:reply.id,reason:'Revisad este texto de prueba.'});
  assert.equal(result.status,201); assert.equal(result.body.report.status,'pending');
  assert.equal((await app.api('b','/reports','POST',{topic_id:topic.id,reply_id:reply.id,reason:'Duplicado'})).status,409);
  const review = await app.api('a','/reports'); assert.equal(review.body.total,1);
  assert.equal(review.body.reports[0].target.body,reply.body); assert.equal(review.body.reports[0].target.type,'reply');
  assert.equal(review.body.reports[0].reporter.alias,'Compañera B');
  assert.doesNotMatch(JSON.stringify(review.body),/@example|email/);
  assert.equal((await app.api('b',`/reports/${result.body.report.id}/resolve`,'POST',{action:'hide'})).status,403);
});

test('Forocromos topic moderation hides details and search; ordinary members cannot lock, hide or restore',async t => {
  const app = await fixture(t), topic = await app.topic('b',{title:'Secreto de ensayo'});
  for (const action of ['lock','unlock','hide','restore']) assert.equal((await app.api('b',`/topics/${topic.id}/moderation`,'POST',{action})).status,403);
  assert.equal((await app.api('a',`/topics/${topic.id}/moderation`,'POST',{action:'lock'})).status,200);
  assert.equal((await app.api('b',`/topics/${topic.id}/replies`,'POST',{body:'No debe entrar',client_request_id:randomUUID()})).status,409);
  await app.api('a',`/topics/${topic.id}/moderation`,'POST',{action:'unlock'});
  await app.reply(topic.id);
  await app.api('a',`/topics/${topic.id}/moderation`,'POST',{action:'hide'});
  assert.equal((await app.api('a',`/topics/${topic.id}`)).status,404);
  assert.equal((await app.api('b',`/topics/${topic.id}`)).status,404);
  assert.equal((await app.api('b','/topics?q=Secreto')).body.total,0);
  assert.equal((await app.api('a','/topics')).body.total,0);
  assert.equal((await app.api('b',`/topics/${topic.id}/replies`,'POST',{body:'No',client_request_id:randomUUID()})).status,404);
  await app.api('a',`/topics/${topic.id}/moderation`,'POST',{action:'restore'});
  assert.equal((await app.api('b',`/topics/${topic.id}`)).status,200);
});

test('Forocromos resolving a reply report hides only that reply and its regular count',async t => {
  const app = await fixture(t), topic = await app.topic(), hidden = await app.reply(topic.id), visible = await app.reply(topic.id,'a');
  const report = await app.api('b','/reports','POST',{topic_id:topic.id,reply_id:hidden.id,reason:'Revisión puntual'});
  const route = `/reports/${report.body.report.id}/resolve`;
  assert.equal((await app.api('a',route,'POST',{action:'hide'})).body.report.status,'resolved');
  const result = await app.api('b',`/topics/${topic.id}`);
  assert.equal(result.body.total,1); assert.equal(result.body.topic.reply_count,1); assert.equal(result.body.replies[0].id,visible.id);
  assert.equal((await app.api('a','/topics')).body.topics[0].reply_count,1);
  assert.equal((await app.api('a','/reports')).body.total,0);
  const history = await app.api('a','/reports?status=all');
  assert.equal(history.body.reports[0].target.hidden,true); assert.equal(history.body.reports[0].target.body,hidden.body);
  assert.equal((await app.api('a',route,'POST',{action:'hide'})).status,200);
  assert.equal((await app.api('a',route,'POST',{action:'dismiss'})).status,409);
});

test('Forocromos withdrawing own thread clears text and attribution but preserves other authors replies',async t => {
  const app = await fixture(t), topic = await app.topic('a',{title:'Texto a retirar',body:'Contenido que retiro.'}), reply = await app.reply(topic.id);
  assert.equal((await app.api('b',`/topics/${topic.id}`,'DELETE')).status,403);
  assert.equal((await app.api('a',`/replies/${reply.id}`,'DELETE')).status,403);
  const removed = await app.api('a',`/topics/${topic.id}`,'DELETE');
  assert.equal(removed.body.topic.withdrawn,true); assert.equal(removed.body.topic.body,''); assert.equal(removed.body.topic.author,null);
  const detail = await app.api('b',`/topics/${topic.id}`);
  assert.equal(detail.body.topic.title,'Retirado por su autora'); assert.equal(detail.body.replies[0].body,reply.body);
  assert.equal(detail.body.topic.locked,true);
  assert.equal((await app.api('b','/topics?q=Contenido')).body.total,0);
  assert.equal((await app.api('b',`/topics/${topic.id}/replies`,'POST',{body:'No',client_request_id:randomUUID()})).status,409);
  assert.equal((await app.api('a',`/topics/${topic.id}`,'DELETE')).status,200);
});

test('Forocromos permits the author to withdraw a hidden reply, including the moderation review copy',async t => {
  const app = await fixture(t), topic = await app.topic(), reply = await app.reply(topic.id);
  const report = await app.api('a','/reports','POST',{topic_id:topic.id,reply_id:reply.id,reason:'Contenido para ensayo'});
  await app.api('a',`/reports/${report.body.report.id}/resolve`,'POST',{action:'hide'});
  assert.equal((await app.api('a',`/replies/${reply.id}`,'DELETE')).status,404);
  const result = await app.api('b',`/replies/${reply.id}`,'DELETE');
  assert.equal(result.status,200); assert.equal(result.body.reply.body,''); assert.equal(result.body.reply.author,null);
  const history = await app.api('a','/reports?status=all');
  assert.equal(history.body.reports[0].target.body,''); assert.equal(history.body.reports[0].target.withdrawn,true);
});

test('Forocromos membership, content, request IDs and moderation survive restart without reactivating revoked seeds',async t => {
  const directory = await mkdtemp(path.join(tmpdir(),'sx-forocromos-restart-'));
  const first = await fixture(t,directory), topic = await first.topic(), reply = await first.reply(topic.id);
  const id = randomUUID(), payload = {category_id:'ideas',title:'Reintento tras reinicio',body:'Persistencia',client_request_id:id};
  const created = await first.api('b','/topics','POST',payload);
  const oldA = (await first.api('a','/me')).body.member;
  first.store.setMembership('a@example.invalid',{status:'revoked'});
  await first.close();
  const second = await fixture(t,first.directory);
  t.after(() => rm(directory,{recursive:true,force:true}));
  assert.equal((await second.api('a','/me')).status,403);
  assert.equal((await second.api('b',`/topics/${topic.id}`)).body.replies[0].id,reply.id);
  const replay = await second.api('b','/topics','POST',payload);
  assert.equal(replay.status,200); assert.equal(replay.body.topic.id,created.body.topic.id);
  const restored = second.store.setMembership('a@example.invalid',{status:'active'});
  assert.equal(restored.id,oldA.id); assert.equal(restored.role,'moderator');
  assert.equal((await second.api('a','/reports')).status,200);
});

test('Forocromos rechecks both session and admission after receiving the request body',async t => {
  const app = await fixture(t);
  async function interruptedWrite(revoke) {
    const body = JSON.stringify({category_id:'ideas',title:'No debe guardarse',body:'Admisión revocada durante lectura',client_request_id:randomUUID()});
    return new Promise((resolve,reject) => {
      const req = httpRequest(app.origin + PREFIX + '/topics',{method:'POST',headers:{'x-fixture-session':'b','content-type':'application/json','content-length':Buffer.byteLength(body)}},res => {
        res.resume(); res.on('end',() => resolve(res.statusCode));
      });
      req.on('error',reject); req.write(body.slice(0,10));
      setTimeout(() => { revoke(); req.end(body.slice(10)); },30);
    });
  }
  assert.equal(await interruptedWrite(() => app.store.setMembership('b@example.invalid',{status:'revoked'})),403);
  app.store.setMembership('b@example.invalid',{status:'active'});
  assert.equal(await interruptedWrite(() => app.sessions.delete('b')),401);
  assert.equal((await app.api('a','/topics')).body.total,0);
});

test('Forocromos bounds write bursts without duplicating or dropping already accepted topics',async t => {
  const app = await fixture(t);
  for (let i=0;i<30;i++) await app.topic('a',{title:`Hilo de ensayo ${i}`});
  const denied = await app.api('a','/topics','POST',{category_id:'ideas',title:'Supera límite',body:'Prueba',client_request_id:randomUUID()});
  assert.equal(denied.status,429); assert.equal((await app.api('b','/topics')).body.total,30);
});

test('Forocromos refuses a storage directory inside public and never serves its SQLite path',async t => {
  await assert.rejects(createLocalForocromosStore({directory:fileURLToPath(new URL('../public/forocromos/',import.meta.url)),getActor:() => ({email:'a@example.invalid'})}),/public/);
  const app = await fixture(t);
  assert.equal((await app.api('a','/forocromos.sqlite')).status,404);
});
