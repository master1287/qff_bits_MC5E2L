import handler from 'vinext/server/fetch-handler';

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    // Retired sign-in links return visitors directly to the public messenger.
    if (['/owner-login','/owner-session','/owner-logout'].includes(new URL(request.url).pathname)) {
      return new Response(null,{status:303,headers:{Location:'/', 'Cache-Control':'no-store',
        'Set-Cookie':'__Host-qubit-owner=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'}});
    }
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) if (name.startsWith('oai-authenticated-user-')) headers.delete(name);
    return handler.fetch(new Request(request,{headers}),env,ctx);
  },
};
