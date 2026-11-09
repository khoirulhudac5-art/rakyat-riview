// Persistent synthetic fixtures for the loopback product preview. No Supabase.
import {randomBytes} from 'node:crypto';
import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {firstClaimModel} from './first-claim-model.mjs';
import {directReview} from '../pembeli/maps.mjs';

export const demoAccounts = Object.freeze({
  first:{id:'preview-google-a',email:'pembeli-a@example.test',name:'Pembeli A',google:true,synthetic:true},
  second:{id:'preview-google-b',email:'pembeli-b@example.test',name:'Pembeli B',google:true,synthetic:true}
});
const fail=(status,error)=>({status,data:{error}});
export function createProductModel({file=null,now=()=>Date.now()}={}){
  let state={version:1,synthetic:true,cards:[],events:[],audit:[]};
  const limits=new Map();
  if(file&&existsSync(file)){
    state=JSON.parse(readFileSync(file,'utf8'));
    if(state.version!==1||state.synthetic!==true||!Array.isArray(state.cards)||!Array.isArray(state.events)||!Array.isArray(state.audit))throw Error('State preview tidak valid; file dipertahankan tanpa ditimpa.');
  }
  function save(){if(!file)return;mkdirSync(dirname(file),{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(state,null,2),{mode:0o600});renameSync(file+'.tmp',file);}
  const timestamp=()=>new Date(now()).toISOString();
  function audit(card,action,actor,reason=''){state.audit.push({at:timestamp(),card_code:card.card_code,action,actor,reason});}
  function create(quantity,actor='Admin simulasi'){
    if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000)return fail(400,'Jumlah kartu harus 1–1.000.');
    const cards=[];
    for(let i=0;i<quantity;i++){
      let code;do{code=randomBytes(18).toString('base64url');}while(state.cards.some(c=>c.card_code===code));
      const card={card_code:code,business_name:'',review_url:'',active:false,owner:null,pin:null,claim_mode:'google_first_claim',inventory_state:'ready',activation_revision:0,created_at:timestamp()};
      state.cards.push(card);cards.push(card);audit(card,'create',actor);
    }
    save();return {status:200,data:{success:true,cards:structuredClone(cards)}};
  }
  if(!state.cards.length)create(3,'Inventaris awal simulasi');
  function statistics(codes=state.cards.map(c=>c.card_code)){
    const allowed=new Set(codes),events=state.events.filter(e=>allowed.has(e.card_code));
    const summarize=items=>{
      const series=Array.from({length:30},(_,i)=>({date:new Date(now()-(29-i)*86400000).toISOString().slice(0,10),visits:0,redirects:0}));
      for(const event of items){const point=series.find(p=>p.date===event.at.slice(0,10));if(point){point.visits++;if(event.redirected)point.redirects++;}}
      return {visits:items.length,redirects:items.filter(e=>e.redirected).length,series};
    };
    return {available:true,synthetic:true,...summarize(events),by_card:Object.fromEntries(codes.map(code=>[code,summarize(events.filter(e=>e.card_code===code))])),google_reviews:{available:false},message:'Kunjungan URL preview lokal, termasuk kunjungan ulang. QR dan NFC memakai URL yang sama. Scan bukan review Google.'};
  }
  function rows(account=null,origin=''){
    return state.cards.filter(c=>!account||c.owner===account.id).map(c=>({card_code:c.card_code,business_name:c.business_name,review_url:c.review_url,active:c.active,claim_mode:c.claim_mode,inventory_state:c.inventory_state,activation_revision:c.activation_revision,created_at:c.created_at,owner_label:c.owner?Object.values(demoAccounts).find(a=>a.id===c.owner)?.email||'Akun simulasi':null,card_url:origin+'/r/'+c.card_code,...statistics([c.card_code]).by_card[c.card_code]}));
  }
  function claim(account,body){
    if(!account)return fail(401,'Masuk sebagai akun simulasi terlebih dahulu.');
    const card=state.cards.find(c=>c.card_code===body.card_code),owned=Boolean(card?.owner);
    const result=firstClaimModel(state.cards,account,body,limits,now());
    if(result.status===200&&!owned){card.activation_revision++;audit(card,'claim',account.email);save();}
    return result;
  }
  function update(account,body){
    if(!account)return fail(401,'Sesi berakhir. Silakan masuk kembali.');
    const card=state.cards.find(c=>c.card_code===body.card_code);
    if(!card||card.owner!==account.id||!card.active)return fail(403,'Anda tidak memiliki akses untuk mengubah kartu ini.');
    if(typeof body.business_name!=='string'||!body.business_name.trim()||body.business_name.trim().length>150||!directReview(body.review_url)||directReview(body.review_url)!==body.review_url)return fail(400,'Isi nama usaha dan link Google Review langsung yang valid.');
    card.business_name=body.business_name.trim();card.review_url=body.review_url;audit(card,'update',account.email);save();
    return {status:200,data:{success:true}};
  }
  function reset(body){
    const card=state.cards.find(c=>c.card_code===body.card_code);
    if(card&&card.claim_mode!=='google_first_claim')return fail(409,'Reset Aktivasi V2 tidak berlaku untuk kartu legacy V1.');
    if(!card||!card.active||!card.owner)return fail(409,'Kartu sudah berubah atau belum aktif. Muat ulang status.');
    if(body.confirmation!==card.card_code||body.acknowledged!==true||!Number.isSafeInteger(body.expected_revision)||body.expected_revision!==card.activation_revision||typeof body.reason!=='string'||body.reason.trim().length<20||body.reason.length>1000)return fail(400,'Konfirmasi, revision, dan alasan reset belum sesuai.');
    Object.assign(card,{owner:null,business_name:'',review_url:'',active:false,inventory_state:'ready',activation_revision:card.activation_revision+1});
    audit(card,'reset','Admin simulasi',body.reason.trim());save();return {status:200,data:{success:true}};
  }
  function status(code){
    const c=state.cards.find(c=>c.card_code===code);
    return c?{status:200,data:{code:c.card_code,activation_state:c.active?'active':'inactive',claim_allowed:!c.owner&&!c.active&&c.inventory_state==='ready'}}:fail(404,'Kartu simulasi tidak ditemukan.');
  }
  function scan(code,count=true){
    const card=state.cards.find(c=>c.card_code===code);if(!card)return fail(404,'Kartu simulasi tidak ditemukan.');
    const target=card.active&&directReview(card.review_url)?card.review_url:'/pembeli/mulai.html?card='+encodeURIComponent(code);
    if(count){state.events.push({at:timestamp(),card_code:code,redirected:target===card.review_url});save();}
    return {status:302,location:target};
  }
  return {create,claim,update,reset,status,scan,statistics,rows,audit:()=>structuredClone(state.audit),next:()=>state.cards.find(c=>!c.owner&&!c.active)?.card_code||create(1).data.cards[0].card_code};
}
