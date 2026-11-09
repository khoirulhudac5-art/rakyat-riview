import {directReview} from './maps.mjs';

// Public example checked against the real resolver and Google Maps redirect.
// This is never presented as a conversion of the buyer's input or their business.
export const publicReviewExample={
  name:'Mathews Theatres (D23)',
  maps_url:'https://maps.app.goo.gl/M8LNtTPfTM8eFN148',
  review_url:'https://search.google.com/local/writereview?placeid=ChIJlXzqDCCyEmsRtNKefKjwtbo'
};
export function localProductPreview(enabled,origin){
  try{const url=new URL(origin);return enabled===true&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname);}catch{return false;}
}
export function mountReviewFallback({input,before,enabled=false}){
  if(!localProductPreview(enabled,location.origin))return {update(){}};
  const box=document.createElement('details');box.className='local-review-fallback';box.dataset.localPreview='true';
  const id=input.id+'-direct-review';
  box.innerHTML=`<summary>Konversi bermasalah? Gunakan link review langsung</summary><div class="review-fallback-body"><span class="simulation-tag">SIMULASI LOKAL</span><p>Anda dapat menempel link Google Review langsung tanpa layanan konversi. Ini tidak mengubah link Maps yang gagal menjadi hasil konversi.</p><label for="${id}">Link Google Review langsung</label><input id="${id}" type="text" inputmode="url" autocomplete="off" spellcheck="false" maxlength="2048" placeholder="https://search.google.com/local/writereview?placeid=…" aria-describedby="${id}-note"><p class="fallback-note" id="${id}-note">Gunakan link Google Review HTTPS dengan Place ID yang sudah tersedia.</p><button type="button" class="btn use-direct-review" disabled>Gunakan link langsung</button><div class="public-review-example"><p>Belum mempunyai link review? Untuk mencoba alur, gunakan contoh publik <strong>${publicReviewExample.name}</strong>. Tujuan contoh ini bukan usaha Anda dan tidak berasal dari konversi input di atas.</p><button type="button" class="btn use-public-example">Gunakan contoh publik untuk simulasi</button></div><button type="button" class="btn text retry-review-conversion">Coba konversi Maps lagi</button></div>`;
  before.before(box);
  const field=box.querySelector('input'),use=box.querySelector('.use-direct-review'),note=box.querySelector('.fallback-note'),retry=box.querySelector('.retry-review-conversion');
  let lastMaps='';retry.disabled=true;
  const apply=value=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
  field.addEventListener('input',()=>{
    const valid=directReview(field.value.trim());use.disabled=!valid;
    note.textContent=valid?'Format link langsung sesuai. Klik Gunakan link langsung.':field.value?'Format belum sesuai. Gunakan link search.google.com/local/writereview dengan satu Place ID.':'Gunakan link Google Review HTTPS dengan Place ID yang sudah tersedia.';
    field.setAttribute('aria-invalid',field.value&&!valid?'true':'false');
  });
  use.onclick=()=>{const valid=directReview(field.value.trim());if(valid){apply(valid);note.textContent='Link langsung digunakan atas pilihan Anda. Tidak ada konversi Maps.';}};
  box.querySelector('.use-public-example').onclick=()=>{field.value=publicReviewExample.review_url;use.disabled=false;field.setAttribute('aria-invalid','false');apply(publicReviewExample.review_url);note.textContent='Contoh publik untuk simulasi: '+publicReviewExample.name+'. Bukan hasil konversi link Maps atau lokasi usaha Anda.';};
  retry.onclick=()=>{if(lastMaps)apply(lastMaps);};
  return {update(result){
    if(result.state==='loading'&&!directReview(input.value.trim())){lastMaps=input.value.trim();retry.disabled=false;}
    if(result.state==='error'&&(/^RESOLVER_/.test(result.code||'')||!result.code))box.open=true;
  }};
}
