import path from 'node:path';
// Minimal quote-aware matcher: exactly Node executable + the expected script.
export function matchesAdminNodeProcess(info,{executable=process.execPath,workspace=process.cwd()}={}){
 const tokens=String(info.commandLine||'').match(/"[^"]*"|[^\s"]+/g)?.map(s=>s.startsWith('"')?s.slice(1,-1):s)||[];
 const normalize=p=>path.win32.normalize(p).toLowerCase();
 if(tokens.length!==2||String(info.name).toLowerCase()!=='node.exe'||normalize(info.executablePath||'')!==normalize(executable)||normalize(tokens[0])!==normalize(executable))return false;
 const expected=path.win32.join(workspace,'scripts','start-admin-generate-live.mjs');
 const script=path.win32.isAbsolute(tokens[1])?tokens[1]:path.win32.join(workspace,tokens[1]);
 return normalize(script)===normalize(expected);
}
