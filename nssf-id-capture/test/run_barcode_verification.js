const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/results' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const data = JSON.parse(body);
      console.log('\n====================================');
      console.log('       TEST RESULTS FROM BROWSER     ');
      console.log('====================================\n');
      console.log(data.log);
      
      // Save test log to verification_results.txt
      fs.writeFileSync(path.join(__dirname, 'verification_results.txt'), data.log, 'utf8');
      
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      process.exit(0);
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(59954, () => {
  console.log('Test result receiver listening on port 59954...');
  
  const tempProfileDir = 'C:\\Users\\HP\\AppData\\Local\\Temp\\chrome-profile-test-temp';
  try {
    if (fs.existsSync(tempProfileDir)) {
      fs.rmSync(tempProfileDir, { recursive: true, force: true });
    }
  } catch (e) {}

  const chromeCmd = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless --disable-gpu --user-data-dir="${tempProfileDir}" "http://localhost:59953/test_barcode_verification.html"`;
  console.log('Running Chrome headless...');
  exec(chromeCmd);
});
