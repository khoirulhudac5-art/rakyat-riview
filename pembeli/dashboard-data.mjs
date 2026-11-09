// Dashboard data boundary. Ownership is determined by the authenticated server
// RPC, never by local drafts, query parameters, or this presentation adapter.
const counter=value=>{
 if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+$/.test(value)))return null;
 const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null;
};
const series=values=>{
 if(!Array.isArray(values))return [];
 const seen=new Set(),valid=[];
 for(const p of values){
  if(!p||typeof p.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.date))continue;
  const t=Date.parse(p.date+'T00:00:00Z');if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,10)!==p.date)continue;
  const visits=counter(p.visits),redirects=counter(p.redirects);if(visits===null||redirects===null)continue;
  // Duplicate daily aggregates are ambiguous; do not invent totals by adding them.
  if(seen.has(p.date))return [];
  seen.add(p.date);valid.push({date:p.date,visits,redirects});
 }
 return valid.sort((a,b)=>a.date.localeCompare(b.date));
};
const values=p=>({visits:counter(p?.visits),redirects:counter(p?.redirects),nfc:counter(p?.nfc),qr:counter(p?.qr),series:series(p?.series)});
export function normalizeDashboard(data,{simulation=false}={}){
 if(!data||!Array.isArray(data.cards))throw Error('Respons daftar kartu tidak valid. Silakan coba lagi.');
 const seen=new Set();
 const cards=data.cards.map(card=>{
  if(!card||typeof card.card_code!=='string'||!/^[A-Za-z0-9_-]{1,30}$/.test(card.card_code)||seen.has(card.card_code))throw Error('Respons identitas kartu tidak valid. Silakan coba lagi.');
  seen.add(card.card_code);
  return {...card,business_name:typeof card.business_name==='string'?card.business_name:'',review_url:typeof card.review_url==='string'?card.review_url:'',active:card.active===true};
 });
 const raw=data.statistics;
 const empty={available:false,synthetic:false,visits:null,redirects:null,nfc:null,qr:null,series:[],by_card:{}};
 if(raw?.available!==true||(!simulation&&raw.synthetic===true))return {cards,statistics:empty};
 const totals=values(raw),by_card=Object.fromEntries(cards.filter(c=>Object.hasOwn(raw.by_card||{},c.card_code)).map(c=>[c.card_code,values(raw.by_card[c.card_code])]));
 const hasData=p=>[p.visits,p.redirects,p.nfc,p.qr].some(n=>n!==null)||p.series.length>0;
 return {cards,statistics:{...totals,available:hasData(totals)||Object.values(by_card).some(hasData),synthetic:simulation,by_card}};
}
