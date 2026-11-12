export const draftKey=code=>'rr-review-draft:'+code;
export function saveDraft(storage,code,data){
  if(!/^[A-Za-z0-9_-]{1,30}$/.test(code))throw Error('Identitas kartu tidak valid.');
  const token=typeof data.token==='string'?data.token.slice(0,128):'';
  const canonical=typeof data.canonical==='string'?data.canonical.slice(0,8192):(typeof data.canonical_url==='string'?data.canonical_url.slice(0,8192):'');
  storage.setItem(draftKey(code),JSON.stringify({code,name:data.name.slice(0,150),maps:data.maps.slice(0,8192),canonical,token,step:data.step===3?3:2,time:Date.now()}));
  let index;try{index=JSON.parse(storage.getItem('rr-review-draft-index')||'[]');}catch{index=[];}
  if(!Array.isArray(index))index=[];
  storage.setItem('rr-review-draft-index',JSON.stringify([...new Set([code,...index.filter(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,30}$/.test(v))])].slice(0,100)));
}
export function loadDraft(storage,code){try{const v=JSON.parse(storage.getItem(draftKey(code)));return v&&v.code===code&&typeof v.name==='string'&&typeof v.maps==='string'&&v.name.length<=150&&v.maps.length<=8192&&Date.now()-v.time<86400000&&v.time<=Date.now()?{...v,canonical:typeof v.canonical==='string'?v.canonical:'',token:typeof v.token==='string'?v.token:''}:null;}catch{return null;}}
export function removeDraft(storage,code){storage.removeItem(draftKey(code));let index;try{index=JSON.parse(storage.getItem('rr-review-draft-index')||'[]');}catch{index=[];}storage.setItem('rr-review-draft-index',JSON.stringify(Array.isArray(index)?index.filter(v=>v!==code):[]));}
export function safeReturn(value,origin){
  try{
    const u=new URL(value,origin);
    if(u.origin!==origin)return '/pembeli/dashboard.html';
    if(u.pathname==='/dashboard.html')return u.pathname;
    if(u.pathname==='/kartu.html'&&/^[A-Za-z0-9_-]{1,30}$/.test(u.searchParams.get('id')||''))return u.pathname+'?id='+encodeURIComponent(u.searchParams.get('id'));
    if(u.pathname==='/pembeli/claim-test.html'&&u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname))return u.pathname+(['A','B'].includes(u.searchParams.get('account'))?'?account='+u.searchParams.get('account'):'');
    if(u.pathname==='/pembeli/mulai.html'){
      const cardCode=u.searchParams.get('card')||u.searchParams.get('kartu')||u.searchParams.get('code');
      if(cardCode&&/^[A-Za-z0-9_-]{1,30}$/.test(cardCode)){
        const token=u.searchParams.get('token')||u.searchParams.get('activation_token')||'';
        const tab=u.searchParams.get('tab');
        const params=new URLSearchParams({card:cardCode});
        if(token&&/^[A-Za-z0-9_-]{16,128}$/.test(token))params.set('token',token);
        if(tab)params.set('tab',tab);
        return u.pathname+'?'+params.toString();
      }
    }
    if(['/pembeli/dashboard.html','/pembeli/aktivasi.html','/pembeli/auth-check.html','/pembeli/auth-callback.html'].includes(u.pathname))return u.pathname;
    return '/pembeli/dashboard.html';
  }catch{return '/pembeli/dashboard.html';}
}
export async function googleLogin(next,{selectAccount=false}={}){
  sessionStorage.setItem('rr-oauth-return',safeReturn(next,location.origin));
  const r=await fetch('/api/buyer-google',{method:'POST',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action:'start'})});const data=await r.json();if(!r.ok)throw Error(data.error||'Login Google belum tersedia.');
  if(typeof data.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.state))throw Error('Login belum dapat dimulai. Coba lagi.');
  sessionStorage.setItem('rr-oauth-state',data.state);
  // Server constructs the provider URL, never use a user-supplied return URL.
  const u=new URL(data.url);if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.pathname!=='/auth/v1/authorize')throw Error('Tujuan login tidak valid.');
  // Only the local session-preparation page requests an explicit Google account
  // chooser. Existing wizard/login behavior and Supabase configuration stay intact.
  if(selectAccount&&location.protocol==='http:'&&['127.0.0.1','localhost'].includes(location.hostname)&&location.pathname==='/pembeli/claim-test.html')u.searchParams.set('prompt','select_account');
  location.assign(u.href);
}
