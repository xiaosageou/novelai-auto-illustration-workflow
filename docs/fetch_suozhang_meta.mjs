import https from 'https';

const url = 'https://novelai.quicktagcloud.com/?c=suozhang';

https.get(url, (res) => {
  let html = '';
  res.on('data', chunk => html += chunk);
  res.on('end', () => {
    console.log('HTML size:', html.length);

    // Look for all json references or release hashes
    const jsonMatches = [...new Set(html.match(/https?:\/\/[^\s"'<>]+?\.json[^\s"'<>]*/g) || [])];
    console.log('JSON matches:', jsonMatches);

    // Look for releases or assets
    const assetMatches = [...new Set(html.match(/https:\/\/assets\.quicktagcloud\.com[^\s"'<>]*/g) || [])];
    console.log('Asset matches:', assetMatches.slice(0, 20));

    // Look for inline JSON configs or codex manifests
    const codexMatches = [...new Set(html.match(/"id"\s*:\s*"[^"]+"/g) || [])];
    console.log('ID matches count:', codexMatches.length);

    // Look for script tags
    const scriptSrcs = [...new Set(html.match(/src="[^"]+"/g) || [])];
    console.log('Script srcs:', scriptSrcs);

    // Check if there are codex lists in the page
    const cMatches = [...new Set(html.match(/suozhang[^"'\s<>]*/g) || [])];
    console.log('suozhang matches:', cMatches.slice(0, 30));
  });
}).on('error', err => console.error(err));
