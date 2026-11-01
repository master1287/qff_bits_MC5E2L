process.env.QUBIT_HOST='cloudflare';
const cli=new URL('./cli.js',import.meta.resolve('vinext'));
process.argv=[process.execPath,cli.pathname,'dev','--port','5173'];
await import(cli.href);
