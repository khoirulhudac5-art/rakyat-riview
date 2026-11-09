// Explicitly mounted local test adapter; never automatically added to deployment.
import create from '../api/admin-create-v2.js';
import reset from '../api/admin-reset-v2.js';
import list from '../api/admin-v2-cards.js';
import login from '../api/admin-login.js';
import logout from '../api/admin-logout.js';
import v2Admin from '../api/v2-admin.js';
import {requireAdminSession} from '../lib/admin-session.mjs';
const handlers=new Map([['/api/v2-admin',v2Admin],['/api/admin-login',login],['/api/admin-logout',logout],['/api/admin-create-v2',create],['/api/admin-reset-v2',reset],['/api/admin-v2-cards',list]]);
export function adminLocalAdapter(){
 if(process.env.NODE_ENV==='production'||process.env.VERCEL)throw Error('Local Admin adapter only');
 return async function(req,res){
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  if(!handlers.has(pathname)&&pathname!=='/api/admin-session')return false;
  const respond={setHeader:(...args)=>res.setHeader(...args),status(n){this.code=n;return this;},json(v){res.writeHead(this.code||200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(v));}};
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||![`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`].includes(req.headers.host)){respond.status(403).json({error:'Local only'});return true;}
  if(pathname==='/api/admin-session'){if(req.method!=='GET')respond.status(405).json({});else if(requireAdminSession(req,respond))respond.json({success:true});return true;}
  let raw='',body={};
  try{for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384){respond.status(413).json({});return true;}}if(raw)body=JSON.parse(raw);}catch{respond.status(400).json({});return true;}
  await handlers.get(pathname)({method:req.method,headers:req.headers,body,query:Object.fromEntries(new URL(req.url,'http://127.0.0.1').searchParams)},respond);return true;
 };
}
