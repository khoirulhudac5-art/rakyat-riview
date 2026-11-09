// LOCAL SYNTHETIC SHIPPING/SCAN SIMULATOR ONLY. Never mount in production.
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { reviewUrl } from '../lib/buyer-service.mjs';
export function scanPrototype({ cards, sessions }) {
  const code='SYN-SCAN', secret=randomBytes(32).toString('base64url');
  const digest=s=>createHash('sha256').update(s).digest('hex');
  let proofHash=digest(secret);
  const tickets=new Map();
  cards.push({card_code:code,business_name:'',review_url:'',active:false,owner:null,pin:null,attempts:0,locked:0});
  const cookie=(req,key)=>(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(key+'='))?.slice(key.length+1);
  return async(req,res,url)=>{
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));return true;};
    res.setHeader('Referrer-Policy','no-referrer');
    if(url.pathname==='/preview-package'){
      if(req.method!=='GET')return json(405,{});
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulasi kemasan · Rakyat Review</title><link rel="stylesheet" href="/assets/buyer.css"><main style="max-width:600px;margin:40px auto;padding:24px"><h1>Simulasi kemasan tersegel</h1><p class="notice">HANYA PREVIEW SINTETIS. Halaman ini mewakili QR rahasia di balik segel barang, bukan halaman publik yang boleh tersedia di produksi.</p><p>Pembeli membuka segel lalu memindai QR aktivasi. Tidak ada kode yang perlu diketik.</p><a class="btn primary" href="/pembeli/scan.html#proof=${secret}">Simulasikan scan QR di balik segel</a><p><a href="/r/${code}">Scan URL publik kartu</a></p><p>QR aktivasi hanya dapat digunakan sekali. Restart server untuk mengulang simulasi dari awal.</p></main></html>`);return true;
    }
    if(url.pathname==='/r/'+code || url.pathname==='/r/'+code+'/'){
      if(!['GET','HEAD'].includes(req.method))return json(405,{});
      const card=cards.find(c=>c.card_code===code);
      res.writeHead(302,{Location:card.active?card.review_url:'/pembeli/scan.html'});res.end();return true;
    }
    const files={'/pembeli/scan.html':['../pembeli/scan.html','text/html; charset=utf-8'],'/pembeli/scan.js':['../pembeli/scan.js','text/javascript; charset=utf-8']};
    if(files[url.pathname]){
      if(!['GET','HEAD'].includes(req.method))return json(405,{});
      const [file,type]=files[url.pathname];res.setHeader('Content-Type',type);res.end(req.method==='HEAD'?undefined:await readFile(new URL(file,import.meta.url)));return true;
    }
    if(url.pathname!=='/api/scan')return false;
    const card=cards.find(c=>c.card_code===code);
    if(req.method==='GET')return json(200,{code,active:card.active});
    if(req.method!=='POST')return json(405,{});
    if(req.headers.origin!==`http://${req.headers.host}`||req.headers['x-buyer-request']!=='1')return json(403,{error:'Permintaan tidak diizinkan.'});
    const user=sessions.get(cookie(req,'rr_preview'));if(!user)return json(401,{error:'Masuk ke akun pembeli terlebih dahulu.'});
    let body;try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>8192)return json(413,{});}body=JSON.parse(raw);}catch{return json(400,{error:'Isian tidak valid.'});}
    if(body.action==='verify'){
      if(card.active||card.owner||typeof body.proof!=='string'||body.proof.length>128||!proofHash||digest(body.proof)!==proofHash)return json(403,{error:'Bukti kemasan tidak valid atau sudah digunakan.'});
      const ticket=randomBytes(32).toString('base64url');tickets.set(ticket,{user:user.id,code,expires:Date.now()+600000});proofHash=null;
      res.setHeader('Set-Cookie',`rr_scan_claim=${ticket}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600`);
      return json(200,{verified:true});
    }
    const key=cookie(req,'rr_scan_claim'),claim=tickets.get(key);
    if(!claim||claim.user!==user.id||claim.code!==code||claim.expires<=Date.now()||(body.card_code&&body.card_code!==claim.code))return json(403,{error:'Scan QR rahasia di balik segel untuk membuktikan kepemilikan.'});
    if(body.action==='ready')return json(200,{verified:true});
    if(body.action!=='activate')return json(400,{});
    if(card.active||card.owner)return json(409,{error:'Kartu sudah diaktifkan.'});
    if(typeof body.business_name!=='string'||!body.business_name.trim()||body.business_name.trim().length>150||!reviewUrl(body.review_url))return json(400,{error:'Periksa nama usaha dan link Google Review HTTPS.'});
    // Synchronous in-memory transaction: ownership and activation change together.
    Object.assign(card,{business_name:body.business_name.trim(),review_url:body.review_url,owner:user.id,active:true,pin:randomBytes(32).toString('hex')});
    tickets.delete(key);res.setHeader('Set-Cookie','rr_scan_claim=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return json(200,{success:true,code});
  };
}
