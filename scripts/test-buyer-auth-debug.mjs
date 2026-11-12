import { config } from '../lib/buyer-service.mjs';

const candidateUrl = 'https://rakyat-riview-hzghqxxr6-rakprem.vercel.app';

async function testAuth() {
  console.log('Testing against candidate:', candidateUrl);

  // Test 1: Check session without cookie
  const r1 = await fetch(candidateUrl + '/api/buyer?action=session');
  console.log('1. Session without cookie status:', r1.status);
  const b1 = await r1.json();
  console.log('   Body:', b1);

  // Test 2: Mode endpoint
  const r2 = await fetch(candidateUrl + '/api/buyer?action=mode');
  console.log('2. Mode status:', r2.status, 'body:', await r2.json());

  // Test 3: Sign in with invalid password
  const r3 = await fetch(candidateUrl + '/api/buyer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Buyer-Request': '1',
      Origin: candidateUrl
    },
    body: JSON.stringify({
      action: 'signin',
      email: 'chili01@mexicanglamour.com',
      password: 'wrongpassword123'
    })
  });
  console.log('3. Invalid signin status:', r3.status, 'body:', await r3.json());
}

testAuth().catch(console.error);
