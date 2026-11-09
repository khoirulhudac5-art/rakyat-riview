import { BuyerError, config, guard, token, cookies, upstream, user, cardInput } from '../lib/buyer-service.mjs';
import { directReview } from '../pembeli/maps.mjs';
import restrictedBuyer from '../lib/restricted-app-adapter.mjs';

export default async function handler(req, res) {
  const selectedAction=req.method==='GET'?req.query?.action:req.body?.action;
  if(process.env.BUYER_PILOT_ENABLED==='true'&&!['session','refresh','signout'].includes(selectedAction)){
    const {createPilotHandlers}=await import('../lib/public-pilot.mjs');return createPilotHandlers().api(req,res);
  }
  if(process.env.BUYER_RESTRICTED_APP==='true'&&!['mode','session','refresh','signout'].includes(selectedAction))return restrictedBuyer(req,res);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Metode tidak diizinkan.' });
  try {
    const cfg = config();
    guard(req, cfg);
    const action = req.method === 'GET' ? req.query?.action : req.body?.action;
    const body = req.body || {};
    if (req.method === 'GET' && action === 'mode') return res.status(200).json({ mode: process.env.BUYER_RESTRICTED_APP==='true'?'restricted':'supabase',...(process.env.BUYER_RESTRICTED_APP==='true'||process.env.BUYER_FIRST_CLAIM_ENABLED==='true'?{activation_flow:'first_claim'}:{}) });
    if (req.method === 'POST' && ['signup', 'signin'].includes(action)) {
      if (typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
        typeof body.password !== 'string' || body.password.length > 256 || body.password.length < (action === 'signup' ? 8 : 1)) throw new BuyerError(400, 'Email atau password tidak valid. Password baru minimal 8 karakter.');
      const data = await upstream(cfg, action === 'signup' ? `/auth/v1/signup?redirect_to=${encodeURIComponent(cfg.origin + '/pembeli/index.html')}` : '/auth/v1/token?grant_type=password',
        { method: 'POST', body: { email: body.email.trim(), password: body.password } });
      if (data?.access_token) res.setHeader('Set-Cookie', cookies(data, cfg));
      return res.status(200).json({ success: true, signed_in: Boolean(data?.access_token), message: action === 'signup' ? 'Jika pendaftaran dapat diproses, periksa email untuk verifikasi lalu masuk.' : 'Berhasil masuk.' });
    }
    if (req.method === 'POST' && action === 'refresh') {
      const refresh = token(req, 'r', cfg);
      if (!refresh) throw new BuyerError(401, 'Silakan masuk kembali.');
      try {
        const data = await upstream(cfg, '/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refresh } });
        res.setHeader('Set-Cookie', cookies(data, cfg));
      } catch (error) { if (error.status === 400 || error.status === 401) res.setHeader('Set-Cookie', cookies(null, cfg)); throw error; }
      return res.status(200).json({ success: true });
    }
    if (req.method === 'POST' && action === 'signout') {
      let access = token(req, 'a', cfg);
      // Clear local cookies even when the upstream session already expired.
      res.setHeader('Set-Cookie', cookies(null, cfg));
      try {
        const refresh=token(req,'r',cfg);
        let revoked=false;
        if(access){try{await upstream(cfg,'/auth/v1/logout?scope=local',{method:'POST',access});revoked=true;}catch(error){if(error.status!==401)throw error;}}
        if(!revoked&&refresh){
          try{const data=await upstream(cfg,'/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:refresh}});access=data.access_token;await upstream(cfg,'/auth/v1/logout?scope=local',{method:'POST',access});}
          catch(error){if(![400,401].includes(error.status))throw error;}
        }
      }catch{return res.status(502).json({error:'Sesi browser dihapus, tetapi pencabutan sesi server belum terkonfirmasi.'});}
      return res.status(200).json({ success: true });
    }
    const session = await user(req, cfg);
    if (req.method === 'GET' && action === 'session') return res.status(200).json({ user: session.user });
    if(req.method==='POST' && action==='first-claim'){
      if(process.env.BUYER_FIRST_CLAIM_ENABLED!=='true')throw new BuyerError(503,'Klaim kartu baru belum diaktifkan. Informasi Anda tetap tersimpan.');
      if(!session.user.google)throw new BuyerError(403,'Masuk menggunakan akun Google untuk mengklaim kartu baru.');
      const args=cardInput(body);
      if(!/^[A-Za-z0-9_-]{24}$/.test(body.card_code)||!directReview(body.review_url)||directReview(body.review_url)!==body.review_url)throw new BuyerError(400,'Identitas kartu atau link review belum valid.');
      let result;
      if(body.activation_token){
        if(typeof body.activation_token!=='string'||body.activation_token.length<16||body.activation_token.length>128)throw new BuyerError(400,'Token aktivasi tidak valid.');
        result=await upstream(cfg,'/rest/v1/rpc/buyer_claim_v2_with_token',{method:'POST',access:session.access,body:{p_card_code:body.card_code,p_token:body.activation_token,p_business_name:args.p_business_name,p_review_url:args.p_review_url}});
        if(result?.code==='invalid_token')throw new BuyerError(403,'Token aktivasi rahasia tidak valid atau kartu sudah pernah diklaim.');
      } else {
        if(process.env.BUYER_REQUIRE_ACTIVATION_TOKEN==='true')throw new BuyerError(400,'Token aktivasi rahasia diperlukan untuk mengklaim kartu.');
        result=await upstream(cfg,'/rest/v1/rpc/buyer_first_claim',{method:'POST',access:session.access,body:args});
      }
      if(result?.code==='rate_limited'){res.setHeader('Retry-After','900');throw new BuyerError(429,'Terlalu banyak percobaan klaim. Tunggu 15 menit lalu coba lagi.');}
      if(result?.code==='not_ready')throw new BuyerError(409,'Kartu belum ditandai siap diaktifkan oleh sistem inventaris. Coba lagi setelah status stok siap.');
      if(result?.success!==true)throw new BuyerError(409,'Kartu tidak dapat diklaim. Kartu mungkin sudah aktif, dimiliki akun lain, atau menggunakan metode aktivasi lama.');
      return res.status(200).json({success:true,card_code:body.card_code});
    }
    if (req.method === 'GET' && action === 'cards') {
      const cards = await upstream(cfg, '/rest/v1/rpc/buyer_list_cards', { method: 'POST', access: session.access, body: {} });
      if (!Array.isArray(cards)) throw new BuyerError(502, 'Respons daftar kartu tidak valid. Coba lagi.');
      return res.status(200).json({ cards, statistics: { available: false, visits: null, redirects: null, message: 'Pelacakan kunjungan belum tersedia. Tidak ada riwayat yang direkayasa.' } });
    }
    if (req.method === 'POST' && ['activate', 'update', 'claim'].includes(action)) {
      let args;
      if (action === 'claim') {
        if (typeof body.card_code !== 'string' || !/^[a-zA-Z0-9_-]{1,30}$/.test(body.card_code) || typeof body.pin !== 'string' || !body.pin || body.pin.length > 1024) throw new BuyerError(400, 'Kode kartu atau PIN tidak valid.');
        args = { p_card_code: body.card_code, p_pin: body.pin };
      } else args = cardInput(body, action === 'activate');
      const rpc = { activate: 'buyer_activate_card', update: 'buyer_update_card', claim: 'buyer_claim_card' }[action];
      const result = await upstream(cfg, `/rest/v1/rpc/${rpc}`, { method: 'POST', access: session.access, body: args });
      if (result !== true) throw new BuyerError(400, 'Kartu tidak dapat diproses. Periksa bukti kepemilikan, status kartu, atau tunggu jika terkunci.');
      return res.status(200).json({ success: true });
    }
    return res.status(400).json({ error: 'Aksi tidak dikenal.' });
  } catch (error) {
    return res.status(error instanceof BuyerError ? error.status : 500).json({ error: error instanceof BuyerError ? error.message : 'Terjadi gangguan server.' });
  }
}
