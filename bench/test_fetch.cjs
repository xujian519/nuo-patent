const { getSystemProxy } = require("/Users/xujian/projects/nuo-patent/dist/index.js");
const proxy = getSystemProxy();
console.log("Proxy detected:", JSON.stringify(proxy));

// Test fetch with nuo-patent
const { fetchHtml } = require("/Users/xujian/projects/nuo-patent/dist/index.js");

async function main() {
  try {
    const html = await fetchHtml("https://patents.google.com/patent/CN201559953U", {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });
    console.log("HTML length:", html.length);
    console.log("First 200:", html.substring(0, 200));
  } catch (e) {
    console.error("Error:", e.message);
    console.error("Stack:", e.stack?.substring(0, 300));
  }
}

main();
