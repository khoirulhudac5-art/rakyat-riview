// Loopback-only synthetic JWT boundary for isolated PostgreSQL tests.
// These tokens are NOT Google/Supabase tokens and must never be used in an app.
import crypto from 'node:crypto';
import http from 'node:http';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const forbidden=()=>Object.assign(new Error('Synthetic JWT rejected'),{statusCode:401});

export function createSyntheticJwtFixture({now=()=>Date.now()}={}){
 const secret=crypto.randomBytes(48);
 const issuer='urn:rakyat-review:isolated-local-jwt';
 const audience='rakyat-review-restricted-local';
 function signJwt(claims={}){
  const seconds=Math.floor(now()/1000);
  const head=encode({alg:'HS256',typ:'JWT'});
  const body=encode({iss:issuer,aud:audience,iat:seconds,nbf:seconds-1,exp:seconds+300,role:'authenticated',...claims});
  const signature=crypto.createHmac('sha256',secret).update(head+'.'+body).digest('base64url');
  return head+'.'+body+'.'+signature;
 }
 function verifyJwt(token){
  if(typeof token!=='string'||token.length>8192)throw forbidden();
  const parts=token.split('.');
  if(parts.length!==3||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))throw forbidden();
  const expected=crypto.createHmac('sha256',secret).update(parts[0]+'.'+parts[1]).digest();
  const actual=Buffer.from(parts[2],'base64url');
  if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))throw forbidden();
  let header,claims;
  try{header=JSON.parse(Buffer.from(parts[0],'base64url'));claims=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{throw forbidden();}
  const seconds=Math.floor(now()/1000);
  if(!header||header.alg!=='HS256'||header.typ!=='JWT'||Object.keys(header).some(k=>!['alg','typ'].includes(k))
    ||!claims||claims.iss!==issuer||claims.aud!==audience||claims.role!=='authenticated'
    ||typeof claims.sub!=='string'||!UUID.test(claims.sub)
    ||!Number.isSafeInteger(claims.exp)||claims.exp<=seconds
    ||!Number.isSafeInteger(claims.iat)||claims.iat>seconds+30
    ||!Number.isSafeInteger(claims.nbf)||claims.nbf>seconds)throw forbidden();
  return Object.freeze({...claims});
 }
 return {signJwt,verifyJwt};
}

export async function createJwtBridge({verifyJwt,invoke,allowedRPCs=['buyer_test_action']}){
 if(typeof verifyJwt!=='function'||typeof invoke!=='function')throw new Error('JWT bridge callbacks required');
 const allowed=new Set(allowedRPCs);
 const server=http.createServer(async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  try{
   if(req.method!=='POST')return send(405,{error:'method_not_allowed'});
   const matched=/^\/rpc\/([a-z_]+)$/.exec(req.url||'');
   if(!matched||!allowed.has(matched[1]))return send(404,{error:'rpc_not_available'});
   const authorization=req.headers.authorization;
   if(typeof authorization!=='string'||!authorization.startsWith('Bearer '))return send(401,{error:'invalid_token'});
   // Verify before accepting any database context. No token or claims are logged.
   const claims=verifyJwt(authorization.slice(7));
   let data='',bytes=0;
   for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return send(413,{error:'request_too_large'});data+=chunk;}
   let parameters;
   try{parameters=JSON.parse(data);}catch{return send(400,{error:'invalid_json'});}
   if(!parameters||typeof parameters!=='object'||Array.isArray(parameters))return send(400,{error:'invalid_parameters'});
   const value=await invoke({subject:claims.sub,claims,rpc:matched[1],parameters});
   send(200,value);
  }catch(error){send(error?.statusCode===401?401:500,{error:error?.statusCode===401?'invalid_token':'rpc_failed'});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();
 if(!address||typeof address!=='object'||address.address!=='127.0.0.1'){server.close();throw new Error('Loopback JWT bridge isolation failed');}
 return {url:'http://127.0.0.1:'+address.port,close:()=>new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections?.();})};
}

// Exercise real HTTP and signature checks; invoke can execute the local-only RPC.
export async function runSyntheticJwtTransportTests({invoke,runId,cardCode,userA,userB,userC}){
 const fixture=createSyntheticJwtFixture();
 const results=[];
 let calls=0;
 const bridge=await createJwtBridge({verifyJwt:fixture.verifyJwt,invoke:async context=>{calls++;return invoke(context);}});
 const request=async(token,parameters={runId,cardCode,operation:'status'})=>{
  const response=await fetch(bridge.url+'/rpc/buyer_test_action',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(parameters),redirect:'error',signal:AbortSignal.timeout(10000)});
  return {status:response.status,body:await response.json()};
 };
 const check=(name,passed)=>{results.push({name,passed:Boolean(passed)});if(!passed)throw Object.assign(new Error('Synthetic JWT transport assertion failed'),{reason:name});};
 try{
  const a=await request(fixture.signJwt({sub:userA}));
  check('Signed synthetic JWT A reaches scoped PostgreSQL RPC',a.status===200&&a.body?.success===true);
  const b=await request(fixture.signJwt({sub:userB}));
  check('Signed synthetic JWT B reaches scoped PostgreSQL RPC',b.status===200&&b.body?.success===true);
  const c=await request(fixture.signJwt({sub:userC}));
  check('Valid JWT third account rejected by database registry',c.status===200&&c.body?.success===false&&c.body?.code==='test_denied');
  const before=calls;
  const valid=fixture.signJwt({sub:userA}),parts=valid.split('.');
  parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
  const cases=[
   ['missing JWT',null],['invalid signature',parts.join('.')],['malformed JWT','not.a.jwt'],
   ['expired JWT',fixture.signJwt({sub:userA,exp:Math.floor(Date.now()/1000)-1})],
   ['wrong issuer',fixture.signJwt({sub:userA,iss:'https://untrusted.example.test'})],
   ['wrong audience',fixture.signJwt({sub:userA,aud:'untrusted-audience'})],
   ['future not-before',fixture.signJwt({sub:userA,nbf:Math.floor(Date.now()/1000)+600})],
   ['invalid UUID subject',fixture.signJwt({sub:'not-a-uuid'})],
   ['elevated role claim',fixture.signJwt({sub:userA,role:'service_role'})],
  ];
  for(const [name,token] of cases){const response=await request(token);check(name+' denied before SQL',response.status===401&&calls===before);}
  // A payload cannot replace the verified JWT subject.
  const forged=await request(fixture.signJwt({sub:userC}),{runId,cardCode,operation:'status',subject:userA,user_id:userA,role:'service_role'});
  check('Payload identity and role cannot replace verified JWT account',forged.status===200&&forged.body?.code==='test_denied');
  return {results,syntheticJwtOnly:true,realSupabaseGoogleJwtTested:false,loopbackOnly:true};
 }finally{await bridge.close();}
}
