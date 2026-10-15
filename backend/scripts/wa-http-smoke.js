const API_BASE_URL = (process.env.E2E_API_URL || 'http://localhost:5000').replace(/\/$/, '');
const TEST_URL = process.env.E2E_WA_HTTP_TEST_URL || `${API_BASE_URL}/api/admin/wa-api/test`;

function redactApiKey(text) {
  return String(text)
    .replace(/(["']?(?:api[_-]?key|apikey)["']?\s*[:=]\s*["']?)[^"'&,}\s]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|apikey)=)[^&#\s]+/gi, '$1[REDACTED]');
}

async function main() {
  const missing = ['E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD', 'TEST_NUMBER'].filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  let login;
  try {
    login = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    console.error(`Admin login request failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!login.ok) {
    console.error(`Admin login failed with HTTP ${login.status}; response body was not printed.`);
    process.exitCode = 1;
    return;
  }

  let credentials;
  try {
    credentials = await login.json();
  } catch {
    console.error('Admin login returned invalid JSON; response body was not printed.');
    process.exitCode = 1;
    return;
  }
  if (!credentials || !credentials.token) {
    console.error('Admin login response did not contain a session token; response body was not printed.');
    process.exitCode = 1;
    return;
  }

  let response;
  try {
    response = await fetch(TEST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: process.env.TEST_NUMBER, text: process.env.TEST_MESSAGE || 'WA HTTP smoke test' }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    console.error(`WhatsApp API test request failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const rawBody = await response.text();
  console.log(`HTTP status: ${response.status}`);
  console.log('Raw response body (API key redacted):');
  console.log(redactApiKey(rawBody) || '(empty response)');

  let result;
  try {
    result = JSON.parse(rawBody);
  } catch {
    result = null;
  }
  if (!response.ok || (result && (result.success === false || result.ok === false))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
