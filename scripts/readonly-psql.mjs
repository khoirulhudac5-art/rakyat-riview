import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
// Only trusted SELECT statements are accepted. Reject control/meta commands
// outside quoted values/comments before sending anything to PostgreSQL.
export function assertInspection(sql){
 const clean=sql.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--[^\r\n]*/g,' ').replace(/'(?:''|[^'])*'/g,"''").replace(/"(?:""|[^"])*"/g,'""');
 if(clean.includes('\\')||clean.includes('$')||clean.split(';').some(s=>s.trim()&&!/^\s*SELECT\b/i.test(s))||/\b(INTO|COMMIT|ROLLBACK|BEGIN|SET|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|CALL|DO|COPY)\b/i.test(clean))throw Error('Inspection SQL rejected');
}
export class ReadOnlyPSQL{
 constructor({executable,env}){
  this.child=spawn(executable,['-X','-q','-w','-A','-t','-v','ON_ERROR_STOP=1'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});this.buffer='';this.pending=null;this.dead=false;
  this.child.stdin.on('error',()=>this.fail());this.child.stderr.on('data',()=>{});
  this.child.stdout.on('data',chunk=>{this.buffer+=chunk;const p=this.pending;if(p&&this.buffer.includes(p.marker)){const at=this.buffer.indexOf(p.marker),value=this.buffer.slice(0,at).trim();this.buffer=this.buffer.slice(at+p.marker.length).replace(/^\r?\n/,'');this.pending=null;clearTimeout(p.timer);p.resolve(value);}});
  this.child.on('error',()=>this.fail());this.child.on('close',()=>this.fail());
 }
 fail(){this.dead=true;if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('Read-only connection lost or query failed'));this.pending=null;}}
 command(sql){if(this.dead||this.pending)throw Error('Read-only session unavailable');return new Promise((resolve,reject)=>{const marker='RR_'+randomBytes(20).toString('hex'),timer=setTimeout(()=>{this.fail();this.child.kill();},60000);this.pending={marker,resolve,reject,timer};this.child.stdin.write(sql+'\n\\echo '+marker+'\n');});}
 async check(){
  if(await this.command('SHOW transaction_read_only;')!=='on')throw Error('Read-only guard failed');
  const state=JSON.parse(await this.command("SELECT json_build_object('pid',pg_backend_pid(),'start',transaction_timestamp(),'readonly',current_setting('transaction_read_only'));"));
  if(state.readonly!=='on'||(this.identity&&(state.pid!==this.identity.pid||state.start!==this.identity.start)))throw Error('Read-only transaction identity changed');return state;
 }
 async begin(){this.identity=null;await this.command('BEGIN READ ONLY;');this.identity=await this.check();return this;}
 async query(sql){assertInspection(sql);await this.check();const value=await this.command(sql.trim().replace(/;?$/,';'));await this.check();return value;}
 async close(){if(!this.dead){try{await this.command('ROLLBACK;');}finally{this.child.stdin.end();}}}
}
export async function inspect({executable,env,queries}){const session=new ReadOnlyPSQL({executable,env});try{await session.begin();const values=[];for(const q of queries)values.push(await session.query(q));return values;}finally{await session.close();}}
