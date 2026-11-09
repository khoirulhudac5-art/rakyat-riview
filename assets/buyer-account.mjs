// Existing authenticated API and restricted wrapper contract; never opens access.
import {normalizeDashboard} from '../pembeli/dashboard-data.mjs';
export async function requestBuyer(action,body,retry=true){
 let response;
 try{response=await fetch('/api/buyer'+(body?'':'?action='+action),{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json','X-Buyer-Request':'1'}:{},...(body?{body:JSON.stringify({...body,action})}:{})});}
 catch{throw Error('Koneksi terputus. Silakan coba lagi.');}
 const data=await response.json().catch(()=>({}));
 if(response.status===401&&retry&&action!=='refresh'&&action!=='signout'){
  await requestBuyer('refresh',{},false);return requestBuyer(action,body,false);
 }
 if(!response.ok){const error=Error(data.error||'Permintaan belum dapat diproses.');error.status=response.status;error.code=data.code;throw error;}
 return data;
}
export async function ownedDashboard(simulation=false){
 const data=await requestBuyer('cards');return normalizeDashboard(data,{simulation});
}
