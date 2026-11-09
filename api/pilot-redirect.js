import {createPilotHandlers,serverRedirect} from '../lib/public-pilot.mjs';
const handlers=createPilotHandlers({redirectRPC:serverRedirect});
export default function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(process.env.BUYER_PILOT_ENABLED!=='true')return res.status(503).json({error:'Pilot belum dibuka.'});
 return handlers.redirect(req,res);
}
