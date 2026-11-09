// Independent local-only server. Default is entirely synthetic; --live explicitly
// enables the new Supabase handlers with environment configuration, never old APIs.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import buyerHandler from '../api/buyer.js';
import googleHandler from '../api/buyer-google.js';
import statusHandler from '../api/buyer-status.js';
import {stagingConfig} from './staging-config.mjs';
import {existingConfig} from './existing-config.mjs';
import { scanPrototype } from './scan-prototype.mjs';
import convertReview from '../api/convert-review.js';
import {firstClaimModel} from './first-claim-model.mjs';
import {adminLocalAdapter} from './admin-local-adapter.mjs';

export function createPreview({ live = false, scan = false, experience = false, firstClaim = false, target='staging' } = {}) {
  if(live && firstClaim)throw new Error('Model first claim lokal tidak boleh memakai Supabase live.');
  if(live && experience)throw new Error('Preview buyer experience tidak memakai Supabase live.');
  if(live && scan)throw new Error('Prototipe scan tidak boleh memakai Supabase live.');
  if(!['staging','existing'].includes(target))throw Error('Unknown preview target.');
  const staging=live?(target==='existing'?existingConfig():stagingConfig()):null;
  const adminEnabled=live&&target==='existing'&&process.env.BUYER_EXISTING_ADMIN_PREVIEW==='true'&&process.env.BUYER_EXISTING_PREVIEW_WRITES==='true'&&process.env.BUYER_EXISTING_AUTH_ONLY!=='true';
  const adminAdapter=adminEnabled?adminLocalAdapter():null;
  if (!live && (process.env.NODE_ENV === 'production' || process.env.VERCEL)) {
    throw new Error('Preview sintetis hanya diizinkan pada lingkungan lokal.');
  }
  const users = new Map(), sessions = new Map();
  const cards = [
    {card_code:'SYN-DRAFT',business_name:'',review_url:'',active:false,owner:null,pin:null,attempts:0,locked:0},
    {card_code:'SYN-NEW',business_name:'',review_url:'',active:false,owner:null,pin:null,attempts:0,locked:0},
    {card_code:'SYN-OLD',business_name:'Usaha Sintetis Lama',review_url:'https://www.google.com/maps',active:true,owner:null,pin:'synthetic-pin',attempts:0,locked:0}
  ];
  const firstClaimCode=firstClaim?randomBytes(18).toString('base64url'):null,claimLimits=new Map();
  if(firstClaimCode)cards.push({card_code:firstClaimCode,business_name:'',review_url:'',active:false,owner:null,pin:null,claim_mode:'google_first_claim',inventory_state:'ready'});
  const files = new Map([
    ['/', 'pembeli/index.html'],['/pembeli/', 'pembeli/index.html'],
    ...['index.html','dashboard.html','aktivasi.html','account.js','account.css','dashboard-data.mjs','mulai.html','maps.mjs','review-fallback.mjs','drafts.mjs','wizard.mjs','oauth.html','oauth.mjs','experience.mjs','experience.css','auth-check.html','auth-check.mjs','auth-wizard-test.mjs'].map(f=>['/pembeli/'+f,'pembeli/'+f]),
    ['/assets/rakyat-review-logo.png','assets/rakyat-review-logo.png'],
    ['/aktivasi.html','aktivasi.html'],
    ['/assets/activation.css','assets/activation.css'],
    ['/assets/buyer.css','assets/buyer.css']
    ,['/dashboard.html','dashboard.html'],['/kartu.html','kartu.html'],['/assets/buyer.js','assets/buyer.js'],['/assets/buyer-account.mjs','assets/buyer-account.mjs'],['/admin-v2.html','admin-v2.html'],['/assets/admin-v2.js','assets/admin-v2.js'],['/assets/admin-v2.css','assets/admin-v2.css']
  ]);
  const scanHandler=scan?scanPrototype({cards,sessions}):null;
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const url=new URL(req.url,'http://127.0.0.1');
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    if ((!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
      ![`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`].includes(req.headers.host))) {
      return json(403,{error:'Preview sintetis hanya tersedia melalui localhost.'});
    }
    if(scanHandler && await scanHandler(req,res,url))return;
    const authOnly=live&&target==='existing'&&process.env.BUYER_EXISTING_AUTH_ONLY==='true';
    if(url.pathname.startsWith('/api/admin-')||url.pathname==='/api/v2-admin'){
      if(!adminAdapter)return json(503,{error:'Adapter Admin lokal belum diizinkan.'});
      if(await adminAdapter(req,res))return;
      return json(404,{});
    }
    if(['/admin.html','/admin-login.html','/assets/admin-v2-reset.js','/assets/admin-v2-reset.css'].includes(url.pathname)){
      if(!adminEnabled)return json(503,{error:'Preview Admin tertutup.'});
      if(!['GET','HEAD'].includes(req.method))return json(405,{});
      const file=url.pathname.slice(1);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');return res.end(req.method==='HEAD'?undefined:await readFile(new URL('../'+file,import.meta.url)));
    }
    const authWizard=authOnly&&process.env.BUYER_EXISTING_AUTH_WIZARD_TEST==='true';
    if(authWizard&&url.pathname==='/preview-auth-wizard'&&req.method==='GET'){res.writeHead(302,{Location:'/pembeli/mulai.html?card=AUTH-WIZARD-LOCAL'});res.end();return;}
    if(authWizard&&url.pathname==='/api/buyer-status'&&req.method==='GET'&&url.searchParams.get('card')==='AUTH-WIZARD-LOCAL')return json(200,{code:'AUTH-WIZARD-LOCAL',activation_state:'inactive',claim_allowed:false,auth_test:true});
    if(authWizard&&url.pathname==='/api/convert-review'&&req.method==='POST'){
      if(req.headers.origin!==process.env.BUYER_APP_ORIGIN||req.headers['x-buyer-request']!=='1')return json(403,{});
      let body;try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)return json(413,{});}body=JSON.parse(raw);}catch{return json(400,{});}
      return convertReview({method:'POST',body},{setHeader:(...args)=>res.setHeader(...args),status(n){this.code=n;return this;},json(data){return json(this.code||200,data);}});
    }
    if(authOnly&&url.pathname==='/api/buyer'){
      let body={};if(req.method==='POST'){try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)return json(413,{});}body=JSON.parse(raw);}catch{return json(400,{});}}
      const action=req.method==='GET'?url.searchParams.get('action'):body.action;
      if(req.method==='GET'&&action==='mode'&&authWizard)return json(200,{mode:'supabase',auth_wizard_test:true});
      if(!((req.method==='GET'&&['mode','session'].includes(action))||(req.method==='POST'&&['refresh','signout'].includes(action))))return json(403,{error:'Pengujian Auth saja: operasi kartu, demo, dan email/password diblokir.'});
      return buyerHandler({method:req.method,headers:req.headers,query:Object.fromEntries(url.searchParams),body},{setHeader:(...args)=>res.setHeader(...args),status(n){this.code=n;return this;},json(data){if((this.code||200)===200&&((action==='session'&&data.user?.google===true)||['refresh','signout'].includes(action)))console.log('[AUTH-ONLY] '+action+' verified by Supabase');return json(this.code||200,data);}});
    }
    if(authOnly&&(url.pathname==='/api/buyer-status'||url.pathname==='/api/convert-review'||url.pathname.startsWith('/r/')))return json(403,{error:'Pengujian Auth saja: akses kartu tidak dijalankan.'});
    if(live&&target==='existing'&&req.method!=='GET'&&req.method!=='HEAD'&&process.env.BUYER_EXISTING_PREVIEW_WRITES!=='true'&&!(authOnly&&url.pathname==='/api/buyer-google'))return json(503,{error:'Mode persiapan existing: operasi tulis belum disetujui.'});
    if(live && /^\/r\/[A-Za-z0-9_-]{1,30}\/?$/.test(url.pathname)&&req.method==='GET'){
      // Substitute public staging configuration only in this local response.
      let html=await readFile(new URL('../r/001/index.html',import.meta.url),'utf8');
      html=html.replace(/const SUPABASE_URL = "[^"]*";/,'const SUPABASE_URL = '+JSON.stringify(staging.url)+';').replace(/const SUPABASE_KEY = "[^"]*";/,'const SUPABASE_KEY = '+JSON.stringify(staging.key)+';');
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;
    }
    if(live && ['/api/buyer-google','/api/buyer-status','/api/convert-review'].includes(url.pathname)){
      if(!['GET','POST'].includes(req.method))return json(405,{});
      let body={};try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)return json(413,{});}if(raw)body=JSON.parse(raw);}catch{return json(400,{});}
      if(url.pathname==='/api/convert-review'&&(req.method!=='POST'||req.headers.origin!==process.env.BUYER_APP_ORIGIN||req.headers['x-buyer-request']!=='1'))return json(403,{});
      const handler={'/api/buyer-google':googleHandler,'/api/buyer-status':statusHandler,'/api/convert-review':convertReview}[url.pathname];
      return handler({method:req.method,headers:req.headers,query:Object.fromEntries(url.searchParams),body},{setHeader:(...args)=>res.setHeader(...args),status(n){this.code=n;return this;},json(data){if(authOnly&&url.pathname==='/api/buyer-google'&&body.action==='callback')console.log('[AUTH-ONLY] callback HTTP '+(this.code||200));return json(this.code||200,data);}});
    }
    if(firstClaim && url.pathname==='/preview-new-card' && req.method==='GET'){res.writeHead(302,{Location:'/r/'+firstClaimCode});res.end();return;}
    if(!live && req.method==='GET' && url.pathname==='/api/buyer-google')return json(200,{enabled:false});
    if(!live && req.method==='POST' && url.pathname==='/api/buyer-google')return json(503,{error:'Google OAuth belum dikonfigurasi pada preview sintetis. Draft tetap tersimpan.'});
    if(!live && req.method==='GET' && url.pathname==='/api/buyer-status'){
      const card=cards.find(c=>c.card_code===url.searchParams.get('card'));
      return card?json(200,{code:card.card_code,activation_state:card.active?'active':'inactive',claim_allowed:Boolean(firstClaim&&card.claim_mode==='google_first_claim'&&card.inventory_state==='ready'&&!card.active&&!card.owner)}):json(404,{error:'Kartu tidak ditemukan.'});
    }
    if(experience && /^\/r\/[A-Za-z0-9_-]{1,30}\/?$/.test(url.pathname)){
      if(req.method!=='GET')return json(405,{});
      const code=url.pathname.split('/')[2],card=cards.find(c=>c.card_code===code);if(!card)return json(404,{error:'Kartu tidak ditemukan.'});
      res.writeHead(302,{Location:card.active?card.review_url:'/pembeli/mulai.html?card='+encodeURIComponent(code)});res.end();return;
    }
    if(!live && url.pathname==='/api/convert-review'){
      if(req.method!=='POST')return json(405,{});
      if(req.headers.origin!==`http://${req.headers.host}`||req.headers['x-buyer-request']!=='1')return json(403,{});
      let body;try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)return json(413,{});}body=JSON.parse(raw);}catch{return json(400,{});}
      return convertReview({method:'POST',body},{setHeader:(...args)=>res.setHeader(...args),status(n){this.code=n;return this;},json(data){return json(this.code||200,data);}});
    }
    if(url.pathname!=='/api/buyer'){
      if(!['GET','HEAD'].includes(req.method))return json(405,{error:'Metode tidak diizinkan.'});
      const file=files.get(url.pathname);if(!file)return json(404,{error:'Not found'});
      try{const data=await readFile(new URL('../'+file,import.meta.url));res.setHeader('Content-Type',file.endsWith('.png')?'image/png':file.endsWith('.css')?'text/css; charset=utf-8':/\.m?js$/.test(file)?'text/javascript; charset=utf-8':'text/html; charset=utf-8');return res.end(req.method==='HEAD'?undefined:data);}catch{return json(500,{error:'File belum tersedia.'});}
    }
    if(!['GET','POST'].includes(req.method))return json(405,{error:'Metode tidak diizinkan.'});
    let body={};
    try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)return json(413,{error:'Payload terlalu besar.'});}if(raw)body=JSON.parse(raw);}
    catch{return json(400,{error:'JSON tidak valid.'});}
    if(live){
      const request={method:req.method,headers:req.headers,body,query:Object.fromEntries(url.searchParams)};
      const response={setHeader:(...args)=>res.setHeader(...args),status(n){this.code=n;return this;},json(data){return json(this.code||200,data);}};
      return buyerHandler(request,response);
    }
    // Mock mutations are origin-checked too. No request can reach Supabase here.
    if(req.method==='POST'&&(req.headers.origin!==`http://${req.headers.host}`||req.headers['x-buyer-request']!=='1'))return json(403,{error:'Permintaan tidak diizinkan.'});
    const action=req.method==='GET'?url.searchParams.get('action'):body.action;
    const sid=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('rr_preview='))?.slice(11);
    const account=sessions.get(sid);
    if(req.method==='GET'&&action==='mode')return json(200,{mode:'synthetic'});
    if(req.method==='POST'&&action==='demo-signin'){
      const second=firstClaim&&body.account==='second';
      const demo={id:second?'local-demo-second':'local-demo-buyer',email:second?'second@example.test':'demo@example.test',google:true,name:second?'Akun Google Contoh B':'Akun Google Contoh A'};
      if(!cards.some(c=>c.card_code==='SYN-DEMO'))cards.push({card_code:'SYN-DEMO',business_name:'Mathews Theatres - Contoh publik',review_url:'https://search.google.com/local/writereview?placeid=ChIJlXzqDCCyEmsRtNKefKjwtbo',active:true,owner:demo.id,pin:'synthetic-demo-pin',attempts:0,locked:0});
      const next=randomBytes(24).toString('hex');sessions.set(next,demo);
      res.setHeader('Set-Cookie',`rr_preview=${next}; Path=/; HttpOnly; SameSite=Strict`);
      return json(200,{success:true,signed_in:true});
    }
    if(req.method==='POST'&&['signup','signin'].includes(action)){
      if(typeof body.email!=='string'||!body.email.includes('@')||typeof body.password!=='string'||body.password.length<8||body.password.length>256)return json(400,{error:'Gunakan email sintetis dan password contoh minimal 8 karakter.'});
      const email=body.email.toLowerCase(),existing=users.get(email);
      if(action==='signup'){
        if(existing)return json(400,{error:'Akun contoh sudah tersedia. Silakan masuk.'});
        const salt=randomBytes(16).toString('hex');users.set(email,{id:randomBytes(12).toString('hex'),email,salt,hash:scryptSync(body.password,salt,32)});
      }else if(!existing||!timingSafeEqual(existing.hash,scryptSync(body.password,existing.salt,32)))return json(401,{error:'Kredensial contoh tidak valid.'});
      const next=randomBytes(24).toString('hex');sessions.set(next,users.get(email));res.setHeader('Set-Cookie',`rr_preview=${next}; Path=/; HttpOnly; SameSite=Strict`);return json(200,{success:true,signed_in:true});
    }
    if(req.method==='POST'&&action==='signout'){sessions.delete(sid);res.setHeader('Set-Cookie','rr_preview=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return json(200,{success:true});}
    if(!account)return json(401,{error:'Silakan masuk ke preview sintetis.'});
    if(req.method==='POST'&&action==='refresh')return json(200,{success:true});
    if(req.method==='GET'&&action==='session')return json(200,{user:{id:account.id,email:account.email,google:Boolean(account.google),name:account.name||null}});
    if(req.method==='POST'&&action==='first-claim'&&firstClaim){const result=firstClaimModel(cards,account,body,claimLimits);if(result.status===429)res.setHeader('Retry-After','900');return json(result.status,result.data);}
    if(req.method==='GET'&&action==='cards')return json(200,{cards:cards.filter(c=>c.owner===account.id).map(({card_code,business_name,review_url,active})=>({card_code,business_name,review_url,active})),statistics:{available:false,visits:null,redirects:null}});
    if(req.method!=='POST')return json(400,{error:'Aksi tidak dikenal.'});
    const card=cards.find(c=>c.card_code===body.card_code);
    if(!card)return json(400,{error:'Kartu contoh tidak dapat diproses.'});
    if(action==='claim'){
      if(card.locked>Date.now()||!card.active||(card.owner&&card.owner!==account.id))return json(400,{error:'Kartu tidak dapat dihubungkan.'});
      if(card.locked&&card.locked<=Date.now()){card.attempts=0;card.locked=0;}
      if(typeof body.pin!=='string'||body.pin!==card.pin){card.attempts++;if(card.attempts>=5)card.locked=Date.now()+900000;return json(400,{error:'PIN salah atau kartu terkunci.'});}
      card.owner=account.id;card.attempts=0;return json(200,{success:true});
    }
    if(!['activate','update'].includes(action))return json(400,{error:'Aksi tidak dikenal.'});
    const {cardInput}=await import('../lib/buyer-service.mjs');
    try{cardInput(body,action==='activate');}catch{return json(400,{error:'Isian kartu tidak valid.'});}
    if(action==='activate'){
      if(card.active||card.owner||body.activation_code!=='SYNTHETIC-ONLY')return json(400,{error:'Aktivasi contoh ditolak.'});
      card.owner=account.id;card.active=true;card.pin=body.pin;
    }else if(card.owner!==account.id)return json(400,{error:'Kartu bukan milik akun ini.'});
    card.business_name=body.business_name.trim();card.review_url=body.review_url;return json(200,{success:true});
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const live=process.argv.includes('--live');
  const server=createPreview({live});
  server.on('error',e=>{console.error(`Preview gagal: ${e.message}`);process.exitCode=1;});
  server.listen(live?4179:4176,'127.0.0.1',()=>console.log(live?'http://127.0.0.1:4179/pembeli/ - STAGING ONLY':'http://127.0.0.1:4176/pembeli/ - PREVIEW SINTETIS, tanpa database'));
}
