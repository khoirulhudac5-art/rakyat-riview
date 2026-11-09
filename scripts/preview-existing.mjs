import {existingConfig} from './existing-config.mjs';
import {createPreview} from './preview-accounts.mjs';
existingConfig();
const server=createPreview({live:true,target:'existing'});
server.on('error',()=>{console.error('Existing-project preview could not start.');process.exitCode=1;});
server.listen(4180,'127.0.0.1',()=>console.log('EXISTING PROJECT: http://127.0.0.1:4180/pembeli/ - writes blocked unless separately enabled; no automatic migrations.'));
