const fetch = require("node-fetch");

const token = process.env.GITHUB_TOKEN;

const token =  process.env.GITHUB_TOKEN,
const baseURL =  process.env.GITHUB_BASE_API_URL || 'https://api.github.com',
  
async function checkRateLimit() {
  const res = await fetch("https://api.github.com/rate_limit", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "rate-limit-checker"
    }
  });

  const json = await res.json();
  console.log("Rate Limit:", json.rate);
}

checkRateLimit().catch(console.error);
