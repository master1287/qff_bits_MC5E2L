export function ownerSignedIn(request: Request, env: Cloudflare.Env): Promise<boolean>;
export function ownerAuthResponse(request: Request, env: Cloudflare.Env): Promise<Response | null>;
export function ownerRequest(request: Request, env: Cloudflare.Env): Promise<Request>;
