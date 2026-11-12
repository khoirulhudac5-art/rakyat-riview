import fs from 'node:fs';

const raw = fs.readFileSync('lib/admin-production.mjs', 'utf8');
const lines = raw.split('\n');

const startIdx = lines.findIndex(l => l.includes('const codes=generateUniqueCardCodes(quantity);'));
const endIdx = lines.findIndex(l => l.includes('return res.status(200).json({success:true,batch_id:request_id,cards});'));

if (startIdx === -1 || endIdx === -1) {
  console.error('Indices not found:', { startIdx, endIdx });
  process.exit(1);
}

const newLines = [
  '  const codes=generateUniqueCardCodes(quantity);',
  '  const cardsData=codes.map(card_code=>{',
  '    const activation_code=String(Math.floor(100000+Math.random()*900000));',
  '    const activation_hash=createHash(\'sha256\').update(activation_code).digest(\'hex\');',
  '    return {card_code,activation_code,activation_hash};',
  '  });',
  '  const cardsPayload=cardsData.map(c=>({card_code:c.card_code}));',
  '  const actor=process.env.ADMIN_OPERATOR_ID||\'admin:production-operator\';',
  '  try{',
  '   const result=await invokeRpc(\'admin_generate_v2_cards_direct\',{',
  '    p_request_id:request_id,',
  '    p_quantity:quantity,',
  '    p_cards:cardsPayload,',
  '    p_actor:actor',
  '   });',
  '   if(result?.success!==true||result.batch_id!==request_id||!Array.isArray(result.cards)||result.cards.length!==quantity){',
  '    throw Error(\'Hasil pembuatan belum dapat dikonfirmasi.\');',
  '   }',
  '   const key=process.env.SUPABASE_SECRET_KEY;',
  '   if(key){',
  '    const headers={apikey:key,Authorization:\'Bearer \'+key,\'Content-Type\':\'application/json\'};',
  '    try{',
  '     await fetch(`${target}/rest/v1/buyer_card_activation`,{',
  '      method:\'POST\',',
  '      headers:{...headers,Prefer:\'resolution=merge-duplicates\'},',
  '      body:JSON.stringify(cardsData.map(c=>({card_code:c.card_code,token_hash:c.activation_hash})))',
  '     });',
  '    }catch{}',
  '    try{',
  '     await fetch(`${target}/rest/v1/card_activation`,{',
  '      method:\'POST\',',
  '      headers:{...headers,Prefer:\'resolution=ignore-duplicates\'},',
  '      body:JSON.stringify(cardsData.map(c=>({card_code:c.card_code,activation_code_hash:c.activation_hash})))',
  '     });',
  '    }catch{}',
  '   }',
  '   const publicOrigin=process.env.CARD_PUBLIC_ORIGIN||origin;',
  '   const cards=cardsData.map((c)=>{',
  '    const url=`${publicOrigin}/r/${c.card_code}`;',
  '    return {',
  '     card_code:c.card_code,',
  '     activation_code:c.activation_code,',
  '     card_url:url,',
  '     qr_url:url,',
  '     nfc_url:url',
  '    };',
  '   });',
  '   return res.status(200).json({success:true,batch_id:request_id,cards});'
];

lines.splice(startIdx, endIdx - startIdx + 1, ...newLines);
fs.writeFileSync('lib/admin-production.mjs', lines.join('\n'), 'utf8');
console.log('Successfully patched lib/admin-production.mjs');
