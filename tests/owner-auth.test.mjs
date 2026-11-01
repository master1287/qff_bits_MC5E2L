import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ownerAuthResponse, ownerSignedIn, ownerRequest} from '../lib/owner-auth.mjs';
let sqlite;
function fixture() {
  sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE owner_login_attempts (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL)');
  class Statement {
    constructor(sql,values=[]) {this.sql=sql;this.values=values;}
    bind(...values) {return new Statement(this.sql,values);}
    first() {return Promise.resolve(sqlite.prepare(this.sql).get(...this.values));}
    run() {sqlite.prepare(this.sql).run(...this.values);return Promise.resolve({success:true});}
  }
  return {OWNER_ACCESS_KEY:'test-only-access-key-with-more-than-32-characters',DB:{prepare:sql=>new Statement(sql)}};
}
afterEach(()=>{sqlite?.close();sqlite=undefined;});
function login(env,key=env.OWNER_ACCESS_KEY,origin='https://qubit.test') {
  return ownerAuthResponse(new Request('https://qubit.test/owner-session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded','CF-Connecting-IP':'192.0.2.1'},body:new URLSearchParams({key})}),env);
}
test('owner login creates an authenticated, secure cookie and never echoes its key', async()=>{
  const env=fixture(); const response=await login(env);
  assert.equal(response.status,303);
  const cookie=response.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
  assert.equal(cookie.includes(env.OWNER_ACCESS_KEY),false);
  const request=new Request('https://qubit.test/api/quantum/status',{headers:{Cookie:cookie.split(';')[0]}});
  assert.equal(await ownerSignedIn(request,env),true);
  assert.equal((await ownerRequest(request,env)).headers.get('oai-authenticated-user-id'),'qubit-owner');
  env.OWNER_ACCESS_KEY+='rotated'; assert.equal(await ownerSignedIn(request,env),false);
});
test('forged identities, altered cookies and cross-origin login cannot authorize hardware',async()=>{
  const env=fixture();
  const forged=new Request('https://qubit.test/api/quantum/jobs',{headers:{'oai-authenticated-user-id':'attacker','oai-authenticated-user-email':'fake@example.test'}});
  const clean=await ownerRequest(forged,env);
  assert.equal(clean.headers.has('oai-authenticated-user-id'),false);
  assert.equal(clean.headers.has('oai-authenticated-user-email'),false);
  assert.equal((await login(env,env.OWNER_ACCESS_KEY,'https://attacker.test')).status,403);
  const valid=await login(env);const cookie=valid.headers.get('set-cookie').split(';')[0];
  const last=cookie.at(-1);const altered=cookie.slice(0,-1)+(last==='A'?'B':'A');
  assert.equal(await ownerSignedIn(new Request('https://qubit.test/',{headers:{Cookie:altered}}),env),false);
  assert.equal(await ownerSignedIn(new Request('https://qubit.test/',{headers:{Cookie:cookie+'; '+cookie}}),env),false);
});
test('login guesses are bounded and unconfigured sign-in fails closed',async()=>{
  const env=fixture();
  for(let i=0;i<5;i++) assert.equal((await login(env,'wrong')).status,401);
  assert.equal((await login(env)).status,429);
  delete env.OWNER_ACCESS_KEY;
  assert.equal((await ownerAuthResponse(new Request('https://qubit.test/owner-login'),env)).status,503);
  assert.equal(await ownerSignedIn(new Request('https://qubit.test/'),env),false);
});
