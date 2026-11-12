import fs from 'node:fs';

const files = ['index.html', 'pembeli/index.html'];

for (const f of files) {
  let content = fs.readFileSync(f, 'utf8');
  const searchStr = '<head>';
  const replacement = `<head><script>(function(){var h=window.location.hash||'';if(h&&(h.indexOf('access_token=')!==-1||h.indexOf('error=')!==-1)){window.location.replace('/pembeli/auth-callback.html'+window.location.search+h);}})();</script>`;

  if (!content.includes('/pembeli/auth-callback.html')) {
    content = content.replace(searchStr, replacement);
    fs.writeFileSync(f, content, 'utf8');
    console.log(`Successfully added redirect handler to ${f}`);
  } else {
    console.log(`Redirect handler already in ${f}`);
  }
}
