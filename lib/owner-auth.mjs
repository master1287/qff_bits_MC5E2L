// Standalone hosting: only the owner may spend the configured IBM allocation.
// Chat-room access continues to use the existing room invitations and tokens.
const COOKIE = '__Host-qubit-owner';
const AGE = 12 * 60 * 60;
const encoder = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
function unb64(value) { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
async function signingKey(secret) { return crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']); }
function configured(env) { return typeof env.OWNER_ACCESS_KEY === 'string' && env.OWNER_ACCESS_KEY.length >= 32 && env.OWNER_ACCESS_KEY.length <= 256; }
const headers = {
  'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
};
function page(message='', status=200) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qubit owner sign-in</title><style>@font-face{font-family:Poppins;src:url(/fonts/poppins-0.ttf)}body{margin:0;background:#0b0b0d;color:#eee;font:15px Poppins,Arial,sans-serif;display:grid;min-height:100vh;place-items:center}main{width:min(380px,85vw);border:1px solid #333;padding:32px;border-radius:4px}h1{font-size:26px}h1 span{color:#ff7a1a}p{color:#aaa;line-height:1.6}input,button{box-sizing:border-box;width:100%;padding:13px;margin-top:12px;border:1px solid #444;border-radius:4px;background:#161619;color:#eee;font:inherit}button{background:#ff7a1a;color:#111;font-weight:600;border:0}a{color:#ffad70}small{display:block;margin-top:20px;color:#aaa}</style><main><h1>qubit<span>.</span> Owner sign-in</h1><p>Use your private owner access key to run IBM hardware experiments. Your chat partner can join a conversation through its invitation.</p>${message ? `<p role="alert">${message}</p>` : ''}<form method="post" action="/owner-session"><label for="key">Owner access key</label><input id="key" name="key" type="password" autocomplete="current-password" required minlength="32" maxlength="256"><button>Sign in</button></form><small><a href="/">Back to messenger</a></small></main></html>`, {status,headers});
}
export async function ownerSignedIn(request, env) {
  if (!configured(env)) return false;
  const cookies = (request.headers.get('Cookie') || '').split(';').map(c=>c.trim()).filter(c=>c.startsWith(COOKIE+'='));
  if (cookies.length !== 1) return false;
  try {
    const token = cookies[0].slice(COOKIE.length+1);
    const [expiry, nonce, signature, extra] = token.split('.');
    if (extra || !/^\d{10}$/.test(expiry) || !/^[A-Za-z0-9_-]{22}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const now = Math.floor(Date.now()/1000);
    if (Number(expiry) <= now || Number(expiry) > now+AGE) return false;
    const signatureBytes=unb64(signature);
    if (b64(signatureBytes)!==signature) return false;
    return await crypto.subtle.verify('HMAC', await signingKey(env.OWNER_ACCESS_KEY), signatureBytes, encoder.encode('qubit-owner-v1.'+expiry+'.'+nonce));
  } catch { return false; }
}
export async function ownerAuthResponse(request, env) {
  const url = new URL(request.url);
  if (!['/owner-login','/owner-session','/owner-logout'].includes(url.pathname)) return null;
  if (url.pathname === '/owner-login' && request.method === 'GET') return page(configured(env) ? '' : 'Owner sign-in is not configured yet.', configured(env) ? 200 : 503);
  if (request.method !== 'POST') return new Response('Method not allowed',{status:405,headers:{Allow:'POST'}});
  if (request.headers.get('Origin') !== url.origin) return new Response('Forbidden',{status:403});
  if (url.pathname === '/owner-logout') return new Response(null,{status:303,headers:{Location:'/', 'Set-Cookie':`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,'Cache-Control':'no-store'}});
  if (!configured(env) || !env.DB) return page('Owner sign-in is not configured yet.',503);
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return page('Invalid sign-in request.',415);
  if (Number(request.headers.get('Content-Length')||0)>4096) return page('Invalid sign-in request.',413);
  const reader = request.body?.getReader();
  const chunks=[]; let bytes=0;
  if (reader) for (;;) {
    const {done,value}=await reader.read(); if(done) break;
    bytes+=value.length; if(bytes>4096) { await reader.cancel(); return page('Invalid sign-in request.',413); }
    chunks.push(value);
  }
  const joined=new Uint8Array(bytes); let offset=0;
  for(const chunk of chunks) { joined.set(chunk,offset); offset+=chunk.length; }
  const body = new TextDecoder().decode(joined);
  const address = request.headers.get('CF-Connecting-IP') || 'local';
  const id = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(address))));
  const now = Date.now();
  const attempt = await env.DB.prepare(`INSERT INTO owner_login_attempts (id, attempts, reset_at) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts+1 END, reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END RETURNING attempts`).bind(id,now+1800000,now,now,now+1800000).first();
  if (!attempt || attempt.attempts>5) return page('Too many sign-in attempts. Try again in 30 minutes.',429);
  const candidate = new URLSearchParams(body).get('key') || '';
  const [left,right] = await Promise.all([candidate,env.OWNER_ACCESS_KEY].map(value=>crypto.subtle.digest('SHA-256',encoder.encode(value)).then(b=>new Uint8Array(b))));
  let difference=0; for(let i=0;i<left.length;i++) difference |= left[i]^right[i];
  if (difference) return page('The owner access key is incorrect.',401);
  await env.DB.prepare('DELETE FROM owner_login_attempts WHERE id = ?').bind(id).run();
  const expiry = Math.floor(Date.now()/1000)+AGE;
  const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
  const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC',await signingKey(env.OWNER_ACCESS_KEY),encoder.encode('qubit-owner-v1.'+expiry+'.'+nonce))));
  return new Response(null,{status:303,headers:{Location:'/', 'Set-Cookie':`${COOKIE}=${expiry}.${nonce}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${AGE}`, 'Cache-Control':'no-store'}});
}

export async function ownerRequest(request, env) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith('oai-authenticated-user-')) headers.delete(name);
  if (await ownerSignedIn(request, env)) headers.set('oai-authenticated-user-id','qubit-owner');
  return new Request(request,{headers});
}
