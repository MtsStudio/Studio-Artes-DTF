const https = require('https');
https.get('https://ibb.co/gbFSvgxg', (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    const match = data.match(/https:\/\/i\.ibb\.co\/[^"']+/);
    console.log(match ? match[0] : 'Not found');
  });
});
