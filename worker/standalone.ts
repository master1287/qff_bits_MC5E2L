import handler from 'vinext/server/fetch-handler';
import { ownerAuthResponse, ownerRequest } from '../lib/owner-auth.mjs';

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const auth = await ownerAuthResponse(request, env);
    if (auth) return auth;
    // External clients cannot supply the identity consumed by the IBM routes.
    return handler.fetch(await ownerRequest(request,env),env,ctx);
  },
};
