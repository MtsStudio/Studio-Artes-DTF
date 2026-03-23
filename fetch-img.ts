fetch('https://ibb.co/gbFSvgxg').then(r => r.text()).then(t => {
  const m = t.match(/https:\/\/i\.ibb\.co\/[^"']+/);
  console.log(m ? m[0] : 'not found');
});
