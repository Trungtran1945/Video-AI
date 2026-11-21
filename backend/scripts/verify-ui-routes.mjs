import { chromium } from 'playwright';

async function verifyUiRoutes() {
  console.log('=== Playwright UI Route Verification ===');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (err) => {
    console.error('Browser pageerror:', err.message);
    pageErrors.push(err.message);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error('Browser console.error:', msg.text());
    }
  });

  // 1. Visit Login page and login as admin if needed
  console.log('Navigating to http://localhost:5173/login ...');
  await page.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' });

  // If on login page, wait for the form to render and submit login
  if (page.url().includes('/login')) {
    console.log('Waiting for #email input...');
    await page.waitForSelector('#email', { timeout: 10000 });
    console.log('Filling login credentials...');
    await page.fill('#email', 'admin@asf.local');
    await page.fill('#password', 'admin1234');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 10000 }).catch(() => {});
  }
  console.log('Current URL after auth check:', page.url());

  const routes = [
    { url: 'http://localhost:5173/dashboard', name: 'Dashboard' },
    { url: 'http://localhost:5173/projects', name: 'Projects' },
    { url: 'http://localhost:5173/projects/new', name: 'CreateProject' },
    { url: 'http://localhost:5173/composer', name: 'Composer' },
    { url: 'http://localhost:5173/outputs', name: 'Outputs' },
    { url: 'http://localhost:5173/settings', name: 'Settings' },
    { url: 'http://localhost:5173/', name: 'Landing' },
  ];

  for (const r of routes) {
    console.log(`Navigating to ${r.name} (${r.url})...`);
    await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1200);
    const title = await page.title();
    console.log(`  -> ${r.name} loaded. URL: ${page.url()}, Title: "${title}"`);

    if (r.name === 'CreateProject') {
      const content = await page.content();
      const hasComposer = content.includes('AI Media Composer');
      const hasTranslate = content.includes('Dịch thuật') && content.includes('lồng tiếng');
      const hasScript = content.includes('SCRIPT_TO_VIDEO') || content.includes('Tạo video từ kịch bản');
      console.log(`  -> CreateProject Check: hasComposer=${hasComposer}, hasTranslate=${hasTranslate}, hasScript=${hasScript}`);

      await page.screenshot({ path: 'screenshot_createproject_verified.png' });
      console.log('  -> Saved screenshot to screenshot_createproject_verified.png');

      if (!hasComposer || !hasTranslate || hasScript) {
        throw new Error('CreateProject mode cards assertion failed: expected 2 modes, got invalid cards');
      }
    }
  }

  await browser.close();

  if (pageErrors.length > 0) {
    console.error(`Encountered ${pageErrors.length} unhandled browser errors.`);
    process.exit(1);
  }

  console.log('ALL UI ROUTES SUCCESSFULLY VERIFIED WITH ZERO ERRORS!');
}

verifyUiRoutes().catch((err) => {
  console.error('UI verification failed:', err);
  process.exit(1);
});
