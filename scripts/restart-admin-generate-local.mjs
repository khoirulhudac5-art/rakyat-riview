// Targets only port 4194 + exact Node/script + matching private Admin signature.
import {execFileSync} from 'node:child_process';import {createHmac,timingSafeEqual} from 'node:crypto';
import {matchesAdminNodeProcess} from './admin-node-process.mjs';import {readAdminEnv,adminConfigStatus} from './admin-readonly-config.mjs';
const ps=code=>execFileSync('powershell.exe',['-NoProfile','-Command',code],{encoding:'utf8',windowsHide:true});
try{
 const info=JSON.parse(ps(`$ErrorActionPreference='Stop';$l=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4194 -State Listen);if($l.Count -ne 1){throw 'Unexpected listener count'};$p=Get-CimInstance Win32_Process -Filter "ProcessId = $($l[0].OwningProcess)";[pscustomobject]@{id=$p.ProcessId;name=$p.Name;executablePath=$p.ExecutablePath;commandLine=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`));
 if(!matchesAdminNodeProcess(info))throw Error('Process identity mismatch; no process stopped');
 const e={...process.env,...readAdminEnv('.env.admin-readonly')};if(!adminConfigStatus(e).ready)throw Error('Admin config unavailable');
 const origin='http://127.0.0.1:4194';const login=await fetch(origin+'/api/v2-admin?action=login',{method:'POST',headers:{origin,'content-type':'application/json','x-admin-request':'1'},body:JSON.stringify({action:'login',password:e.ADMIN_PASSWORD}),signal:AbortSignal.timeout(10000)});
 if(login.status!==200)throw Error('Known Admin backend authentication failed; no process stopped');
 const cookie=login.headers.get('set-cookie')?.split(';')[0]||'',parts=cookie.slice('__Host-rr_admin='.length).split('.');
 const signature=createHmac('sha256',e.ADMIN_SESSION_SECRET).update(parts[0]||'').digest('base64url');
 if(parts.length!==2||parts[1].length!==signature.length||!timingSafeEqual(Buffer.from(parts[1]),Buffer.from(signature)))throw Error('Backend signature identity mismatch; no process stopped');
 const logout=await fetch(origin+'/api/v2-admin?action=logout',{method:'POST',headers:{origin,cookie,'content-type':'application/json','x-admin-request':'1'},body:'{"action":"logout"}'});if(logout.status!==200)throw Error('Backend session cleanup failed');
 if(!Number.isInteger(info.id)||info.id<1)throw Error('Invalid process ID');
 execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';$l=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4194 -State Listen);if($l.Count -ne 1 -or $l[0].OwningProcess -ne [int]$env:RR_RESTART_PID){throw 'Listener changed'};$p=Get-CimInstance Win32_Process -Filter "ProcessId = $env:RR_RESTART_PID";if($p.CreationDate.ToUniversalTime().ToString('o') -ne $env:RR_RESTART_CREATED -or $p.CommandLine -cne $env:RR_RESTART_COMMAND){throw 'Process changed'};Stop-Process -Id $p.ProcessId -ErrorAction Stop`],{windowsHide:true,stdio:'pipe',env:{...process.env,RR_RESTART_PID:String(info.id),RR_RESTART_CREATED:info.created,RR_RESTART_COMMAND:info.commandLine}});
 console.log(JSON.stringify({knownBackendStopped:true,port:4194,matcher:'quote-aware exact argv',privateAdminSignatureVerified:true,otherProcessesStopped:false}));
}catch{console.error('STOP: backend restart identity/authentication check failed; no automatic retry.');process.exitCode=1;}
