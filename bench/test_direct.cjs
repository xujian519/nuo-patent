// Test without proxy - bypass proxy detection
const https = require('https');

const options = {
  hostname: 'patents.google.com',
  path: '/patent/CN201559953U/en',
  method: 'GET',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,en-US;q=0.9',
  }
};

const req = https.request(options, (res) => {
  console.log('Status:', res.statusCode);
  console.log('Headers:', JSON.stringify(res.headers));
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Body length:', data.length);
    console.log('Body first 300:', data.substring(0, 300));
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.setTimeout(30000, () => {
  console.error('Timeout');
  req.destroy();
});

req.end();
