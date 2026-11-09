// Unified loopback preview. Synthetic by default; --real explicitly reuses
// the existing Google Auth configuration without falling back to demo data.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createProductModel,demoAccounts} from './product-model.mjs';
import convertReview from '../api/convert-review.js';
import buyerHandler from '../api/buyer.js';
import googleHandler from '../api/buyer-google.js';
import restrictedBuyer,{restrictedStatus} from '../lib/restricted-app-adapter.mjs';
import {config as buyerConfig,upstream} from '../lib/buyer-service.mjs';
import {directReview} from '../pembeli/maps.mjs';

export function createProductPreview({file=resolve('.local-tools/product-preview/state.json'),now=()=>Date.now(),convert=convertReview,integration=false,restrictedRun=false,claimTest=null}={}){
  if(process.env.NODE_ENV==='production'||process.env.VERCEL)throw Error('Preview produk hanya untuk development lokal.');
  const cfg=integration?buyerConfig():null;
  if(integration&&(!cfg.local||cfg.url!=='https://svuagnobufhfpgzmsyxx.supabase.co'||process.env.BUYER_GOOGLE_ENABLED!=='true'||process.env.BUYER_RESTRICTED_APP!=='true'))throw Error('Real preview requires the existing project, real Google Auth and restricted adapter. No synthetic fallback.');
  let runCards=(process.env.RR_TEST_CARD_CODES||process.env.RR_TEST_CARD_CODE||'').split(',').filter(Boolean),runExpires=Date.parse(process.env.RR_TEST_RUN_EXPIRES_AT||'');
  if(restrictedRun&&(!integration||process.env.RR_TEST_APP_WRITES!=='true'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(process.env.RR_TEST_RUN_ID||'')||runCards.length!==2||new Set(runCards).size!==2||runCards.some(c=>!/^[A-Za-z0-9_-]{24}$/.test(c))||!Number.isFinite(runExpires)||runExpires<=now()||runExpires>now()+3600000))throw Error('Approved restricted-run configuration requires two distinct registered cards and a valid expiry. No fallback or database change.');
  const model=integration?null:createProductModel({file,now}),sessions=new Map(),adminSessions=new Map();
  const localContext='OAUTH-CONTEXT-LOCAL'; // Card context only; never exists/claims in Supabase.
  const capabilities={list:true,create:true,reset:true,audit:true},metadata={mode:'synthetic',capabilities};
  const files=new Map([
    ['/','pembeli/index.html'],['/pembeli/','pembeli/index.html'],['/dashboard.html','dashboard.html'],['/kartu.html','kartu.html'],['/assets/buyer.js','assets/buyer.js'],['/assets/buyer-account.mjs','assets/buyer-account.mjs'],['/admin-v2.html','admin-v2.html'],['/aktivasi.html','aktivasi.html'],
    ...['index.html','dashboard.html','aktivasi.html','account.js','account.css','dashboard-data.mjs','mulai.html','maps.mjs','review-fallback.mjs','drafts.mjs','wizard.mjs','oauth.html','oauth.mjs','experience.mjs','experience.css','auth-check.html','auth-check.mjs','auth-wizard-test.mjs','claim-test.mjs'].map(f=>['/pembeli/'+f,'pembeli/'+f]),
    ...['rakyat-review-logo.png','buyer.css','activation.css','admin-v2.js','admin-v2.css'].map(f=>['/assets/'+f,'assets/'+f])
  ]);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    const redirect=target=>{res.writeHead(302,{Location:target});res.end();};
    try{
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||![`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`].includes(req.headers.host))return json(403,{error:'Preview hanya tersedia pada loopback.'});
      const origin='http://'+req.headers.host,url=new URL(req.url,origin),cookie=name=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);
      if(integration&&origin!==cfg.origin)return json(403,{error:'Gunakan origin callback lokal yang sudah dikonfigurasi.'});
      const session=(store,name)=>{const id=cookie(name),s=store.get(id);if(!s||s.expires<=now()){store.delete(id);return null;}return s;};
      const setSession=(store,name,account)=>{const id=randomBytes(32).toString('hex');store.delete(cookie(name));store.set(id,{account,expires:now()+12*3600000});res.setHeader('Set-Cookie',`${name}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);};
      const endSession=(store,name)=>{store.delete(cookie(name));res.setHeader('Set-Cookie',`${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);};
      const testing=restrictedRun&&now()<runExpires;
      if(integration&&claimTest&&await claimTest.handle(req,res,url))return;
      if(url.pathname==='/preview-new-card'&&req.method==='GET'){
        if(restrictedRun&&!testing)return json(403,{code:'V2_ACCESS_CLOSED',error:'Run pengujian sudah berakhir.'});
        const selected=url.searchParams.get('card');if(testing&&selected&&!runCards.includes(selected))return json(404,{error:'Kartu tidak terdaftar pada run ini.'});
        return redirect(integration?'/pembeli/mulai.html?card='+(testing?selected||runCards[0]:localContext):'/r/'+model.next());
      }
      if(integration&&url.pathname.startsWith('/r/')){
        if(!testing)return json(403,{code:'V2_ACCESS_CLOSED',error:'Scan pengujian live tetap ditutup di luar run yang diizinkan.'});
        if(!['GET','HEAD'].includes(req.method))return json(405,{});
        const match=/^\/r\/([A-Za-z0-9_-]{24})\/?$/.exec(url.pathname),code=match?.[1];
        if(!runCards.includes(code))return json(404,{error:'Kartu tidak terdaftar pada run ini.'});
        // Same public view as the permanent V1/V2 redirect, narrowed here to the
        // two operator-registered dummy identities. No JWT or customer scan.
        let rows;try{rows=await upstream(cfg,'/rest/v1/card_public?card_code=eq.'+encodeURIComponent(code)+'&select=card_code,review_url&limit=1');}catch{return json(503,{error:'Tujuan kartu uji belum dapat dibaca; tidak ada redirect pengganti.'});}
        if(now()>=runExpires)return json(403,{code:'V2_ACCESS_CLOSED',error:'Run pengujian sudah berakhir.'});
        if(!Array.isArray(rows)||rows.length>1||rows.some(c=>c.card_code!==code))return json(502,{error:'Respons kartu uji tidak sesuai.'});
        if(!rows.length||!rows[0].review_url)return redirect('/pembeli/mulai.html?card='+code);
        const destination=directReview(rows[0].review_url);if(!destination||destination!==rows[0].review_url)return json(502,{error:'Tujuan kartu uji tidak valid.'});
        return redirect(destination);
      }
      if(/^\/r\/[A-Za-z0-9_-]{1,30}\/?$/.test(url.pathname)&&['GET','HEAD'].includes(req.method)){const result=model.scan(url.pathname.split('/')[2],req.method==='GET');return result.location?redirect(result.location):json(result.status,result.data);}
      const api=['/api/buyer','/api/buyer-status','/api/buyer-google','/api/convert-review','/api/v2-admin'].includes(url.pathname);
      if(!api){
        if(!['GET','HEAD'].includes(req.method))return json(405,{error:'Metode tidak diizinkan.'});
        const fileName=files.get(url.pathname);if(!fileName)return json(404,{error:'Not found'});
        const file=await readFile(new URL('../'+fileName,import.meta.url));
        res.setHeader('Content-Type',fileName.endsWith('.png')?'image/png':fileName.endsWith('.css')?'text/css; charset=utf-8':/\.m?js$/.test(fileName)?'text/javascript; charset=utf-8':'text/html; charset=utf-8');return res.end(req.method==='HEAD'?undefined:file);
      }
      if(!['GET','POST'].includes(req.method))return json(405,{error:'Metode tidak diizinkan.'});
      let body={};
      if(req.method==='POST'){
        const header=url.pathname==='/api/v2-admin'?'x-admin-request':'x-buyer-request';
        if(req.headers.origin!==origin||req.headers[header]!=='1'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(403,{error:'Permintaan tidak diizinkan.'});
        let raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>16384)return json(413,{error:'Payload terlalu besar.'});}
        try{body=JSON.parse(raw);if(!body||Array.isArray(body)||typeof body!=='object')throw Error();}catch{return json(400,{error:'JSON tidak valid.'});}
      }
      const action=req.method==='GET'?url.searchParams.get('action'):body.action||url.searchParams.get('action');
      const send=result=>json(result.status,result.data);
      const bridgeResponse={setHeader:(...v)=>res.setHeader(...v),status(n){this.code=n;return this;},json(data){if(integration&&(this.code||200)===200){if(url.pathname==='/api/buyer-google'&&action==='callback')console.log('[REAL AUTH] callback completed by Supabase');if(url.pathname==='/api/buyer'&&action==='session'&&data.user?.google===true)console.log('[REAL AUTH] Google session verified by Supabase');if(url.pathname==='/api/buyer'&&['refresh','signout'].includes(action))console.log('[REAL AUTH] '+action+' completed by Supabase');if(url.pathname==='/api/buyer'&&action==='signout')claimTest?.noteSignout(req);}return json(this.code||200,data);}};
      if(integration){
        const closed=()=>json(403,{code:'V2_ACCESS_CLOSED',error:'Google Login tersedia. Akses kartu V2 tetap closed; klaim, daftar, dan edit kartu live belum diizinkan. Draft Anda tetap tersimpan.'});
        if(url.pathname==='/api/buyer-google')return await googleHandler({method:req.method,headers:req.headers,body},bridgeResponse);
        if(url.pathname==='/api/buyer'&&req.method==='GET'&&action==='mode')return json(200,{mode:'restricted',real_auth:true,card_access:testing?'restricted':'closed',local_card_context:!testing,activation_flow:'first_claim',preview_scan_url:'/preview-new-card'});
        if(url.pathname==='/api/buyer'&&((req.method==='GET'&&action==='session')||(req.method==='POST'&&['refresh','signout'].includes(action))))return await buyerHandler({method:req.method,headers:req.headers,query:Object.fromEntries(url.searchParams),body},bridgeResponse);
        // No card reads/writes are sent to live while the restricted package is
        // closed. Future approved runs use these existing wrapper adapters,
        // never the original RPCs or the synthetic model.
        if(url.pathname==='/api/buyer-status'){
          if(req.method!=='GET')return json(405,{});
          if(testing)return await restrictedStatus({method:req.method,headers:req.headers,query:Object.fromEntries(url.searchParams)},bridgeResponse);
          if(url.searchParams.get('card')===localContext)return json(200,{code:localContext,activation_state:'unverified',claim_allowed:false,local_context:true,activation_reason:'v2_access_closed'});
          return closed();
        }
        if(url.pathname==='/api/buyer'){
          if(action==='demo-signin')return json(403,{error:'Mode Google nyata: akun demo tidak tersedia.'});
          if((req.method==='GET'&&['cards','stats','statistics','status'].includes(action))||(req.method==='POST'&&['first-claim','update'].includes(action))){if(testing)return await restrictedBuyer({method:req.method,headers:req.headers,query:Object.fromEntries(url.searchParams),body},bridgeResponse);return closed();}
          return json(403,{error:'Preview integrasi menggunakan Google asli dan adapter restricted. Aksi tidak tersedia.'});
        }
        if(url.pathname==='/api/v2-admin')return closed();
      }
      if(url.pathname==='/api/convert-review'){
        if(req.method!=='POST')return json(405,{error:'Gunakan POST.'});
        return await convert({method:'POST',body},{setHeader:(...v)=>res.setHeader(...v),status(n){this.code=n;return this;},json(data){return json(this.code||200,data);}});
      }
      if(url.pathname==='/api/buyer-google')return req.method==='GET'?json(200,{enabled:false,simulation:true}):json(503,{error:'Preview produk menggunakan dua akun simulasi. Login Google nyata tersedia melalui preview integrasi terpisah.'});
      if(url.pathname==='/api/buyer-status')return req.method==='GET'?send(model.status(url.searchParams.get('card'))):json(405,{});
      if(url.pathname==='/api/v2-admin'){
        const admin=session(adminSessions,'rr_product_admin');
        if(req.method==='POST'&&action==='login'){
          if(body.password!=='demo-admin')return json(401,{...metadata,error:'Sandi Admin simulasi tidak sesuai.'});
          setSession(adminSessions,'rr_product_admin',{id:'admin-simulation'});return json(200,{...metadata,authenticated:true});
        }
        if(req.method==='POST'&&action==='logout'){endSession(adminSessions,'rr_product_admin');return json(200,{success:true,...metadata});}
        if(!admin)return json(401,{...metadata,authenticated:false,error:'Masuk sebagai Admin simulasi.'});
        if(req.method==='GET'&&action==='session')return json(200,{...metadata,authenticated:true});
        if(req.method==='GET'&&action==='cards')return json(200,{...metadata,cards:model.rows(null,origin),statistics:model.statistics()});
        if(req.method==='GET'&&action==='statistics')return json(200,{...metadata,statistics:model.statistics()});
        if(req.method==='GET'&&action==='audit')return json(200,{...metadata,events:model.audit()});
        if(req.method==='POST'&&action==='create')return send(model.create(body.quantity));
        if(req.method==='POST'&&action==='reset')return send(model.reset(body));
        return json(400,{error:'Aksi Admin tidak tersedia.'});
      }
      const account=session(sessions,'rr_product_buyer')?.account;
      if(req.method==='GET'&&action==='mode')return json(200,{mode:'synthetic',product_preview:true,preview_scan_url:'/preview-new-card'});
      if(req.method==='POST'&&action==='demo-signin'){
        if(body.account&&!Object.hasOwn(demoAccounts,body.account))return json(400,{error:'Akun simulasi tidak valid.'});
        setSession(sessions,'rr_product_buyer',demoAccounts[body.account||'first']);return json(200,{success:true,signed_in:true});
      }
      if(req.method==='POST'&&action==='signout'){endSession(sessions,'rr_product_buyer');return json(200,{success:true});}
      if(!account)return json(401,{error:'Masuk menggunakan akun simulasi A atau B.'});
      if(req.method==='GET'&&action==='session')return json(200,{user:account});
      if(req.method==='POST'&&action==='refresh')return json(200,{success:true,simulation:true});
      if(req.method==='GET'&&action==='cards')return json(200,{cards:model.rows(account,origin),statistics:model.statistics(model.rows(account).map(c=>c.card_code))});
      if(req.method==='GET'&&['stats','statistics'].includes(action))return json(200,{statistics:model.statistics(model.rows(account).map(c=>c.card_code))});
      if(req.method==='POST'&&action==='first-claim')return send(model.claim(account,body));
      if(req.method==='POST'&&action==='update')return send(model.update(account,body));
      return json(400,{error:'Preview ini menggunakan akun simulasi dan klaim V2 tanpa PIN. Aksi tidak tersedia.'});
    }catch{if(!res.headersSent)json(500,{error:'Preview lokal gagal memproses permintaan. Tidak ada koneksi production.'});else res.end();}
  });
  server.configureRestrictedRun=plan=>{
    if(!integration||plan.status!=='ACTIVE_RESTRICTED_TEST'||plan.project_ref!=='svuagnobufhfpgzmsyxx'||plan.fixtures?.length!==2||plan.fixtures.some(c=>!/^[A-Za-z0-9_-]{24}$/.test(c.card_code))||new Set(plan.fixtures.map(c=>c.card_code)).size!==2||!Number.isFinite(Date.parse(plan.expires_at))||Date.parse(plan.expires_at)<=now())throw Error('Cannot activate local adapter without a verified live restricted plan');
    runCards=plan.fixtures.map(c=>c.card_code);runExpires=Date.parse(plan.expires_at)-5000;restrictedRun=true;
    process.env.RR_TEST_RUN_ID=plan.run_id;process.env.RR_TEST_CARD_CODES=runCards.join(',');process.env.RR_TEST_RUN_EXPIRES_AT=plan.expires_at;process.env.RR_TEST_APP_WRITES='true';
  };
  server.closeRestrictedRun=()=>{restrictedRun=false;runCards=[];runExpires=0;process.env.RR_TEST_APP_WRITES='false';};
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.includes('--real')){
    const {startRealProduct}=await import('./preview-product-real.mjs');await startRealProduct(createProductPreview);
  }else{
  const port=Number(process.env.PRODUCT_PREVIEW_PORT||4186),server=createProductPreview();
  server.on('error',e=>{console.error('Preview gagal:',e.code||'local error');process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`SIMULASI LOKAL — tidak memakai Supabase\nPembeli: http://127.0.0.1:${port}/pembeli/\nScan kartu: http://127.0.0.1:${port}/preview-new-card\nAdmin: http://127.0.0.1:${port}/admin-v2.html (sandi demo-admin)\nState: .local-tools/product-preview/state.json`));
  }
}
