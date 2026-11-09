import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const html=await readFile(new URL('../r/001/index.html',import.meta.url),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
test('legacy scan preserves active redirect; unconfigured card only opens draft, unknown stays error',async()=>{
  for(const [rows,expected]of [[[{review_url:'https://www.google.com/maps'}],'https://www.google.com/maps'],[[{review_url:null}],'/pembeli/mulai.html?card=002'],[[{review_url:'https://evil.example'}],null],[[{review_url:'https://google.com/url?q=https://evil.example'}],null],[[],null]]){
    let destination=null;const status={textContent:''};
    const context=vm.createContext({URL,window:{location:{pathname:'/r/002',replace:value=>destination=value}},document:{getElementById:()=>status},fetch:async()=>({ok:true,json:async()=>rows})});
    await vm.runInContext(script.replace('    bukaUlasan();','    globalThis.done = bukaUlasan();'),context);await context.done;assert.equal(destination,expected);if(!rows.length)assert.match(status.textContent,/Hubungi pengelola/);
  }
});
