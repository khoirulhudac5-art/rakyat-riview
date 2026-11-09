import {stagingConfig} from './staging-config.mjs';
import {createPreview} from './preview-accounts.mjs';
stagingConfig();
const server=createPreview({live:true});
server.on('error',()=>{console.error('Staging preview could not start.');process.exitCode=1;});
server.listen(4179,'127.0.0.1',()=>console.log('STAGING ONLY: http://127.0.0.1:4179/pembeli/ - no synthetic accounts, no automatic migrations.'));
