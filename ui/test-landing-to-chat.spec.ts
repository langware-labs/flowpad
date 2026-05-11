import { test, expect } from '@playwright/test';

const APP_URL = 'http://localhost:4097';
const BACKEND_URL = 'http://localhost:9007';

test.setTimeout(120000); // 2 minutes timeout

test('Start new chat from landing page', async ({ page }) => {
  // Capture console errors
  const consoleErrors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(`[Console Error] ${msg.text()}`);
    }
  });

  // Capture network errors
  const networkErrors: string[] = [];
  page.on('requestfailed', request => {
    networkErrors.push(`[Network Error] ${request.url()} - ${request.failure()?.errorText}`);
  });

  console.log('Step 1: Navigate to landing page');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000); // Wait for initial render

  console.log('Step 2: Validate landing page is visible');
  // Wait for landing page to render - could be project grid or home page
  await page.waitForTimeout(2000);

  // Check for Desktop Setup modal and skip if present
  const skipButton = page.getByRole('button', { name: /skip/i });
  const isSkipVisible = await skipButton.isVisible().catch(() => false);
  if (isSkipVisible) {
    console.log('Desktop Setup modal detected, clicking Skip');
    await skipButton.click();
    await page.waitForTimeout(1000);
  }

  // Check for console errors after page load
  if (consoleErrors.length > 0) {
    console.error('Console errors after landing page load:', consoleErrors);
  }

  // Screenshot landing page
  await page.screenshot({ path: '/tmp/test-step-1-landing.png', fullPage: true });
  console.log('Screenshot saved: /tmp/test-step-1-landing.png');

  console.log('Step 3: Look for chat input or "New Flow" button');

  // Try to find chat input - could be on main page or need to click "New Flow"
  let chatInput = page.locator('textarea, input[type="text"]').filter({ hasText: '' }).first();

  // Check if we need to click "New Flow" button first
  const newFlowButton = page.getByRole('button', { name: /new flow|new chat|start/i });
  const isVisible = await newFlowButton.isVisible().catch(() => false);

  if (isVisible) {
    console.log('Found "New Flow" button, clicking it');
    await newFlowButton.click();
    await page.waitForTimeout(1000);
  }

  console.log('Step 4: Find chat input and type message');
  // Wait for "Recent Activity" loading to finish
  await page.waitForTimeout(2000);

  // Re-locate chat input after potential navigation
  chatInput = page.locator('textarea[placeholder*="work on" i], textarea[placeholder*="message" i], textarea[placeholder*="chat" i], textarea').first();
  await chatInput.waitFor({ state: 'visible', timeout: 5000 });

  await chatInput.fill('Hello, can you help me?');
  await page.waitForTimeout(500);

  // Screenshot with message typed
  await page.screenshot({ path: '/tmp/test-step-2-message-typed.png', fullPage: true });
  console.log('Screenshot saved: /tmp/test-step-2-message-typed.png');

  console.log('Step 5: Click send button');
  const urlBeforeSend = page.url();
  console.log('URL before send:', urlBeforeSend);

  // Find and click the send button (arrow icon)
  const sendButton = page.locator('button[type="submit"], button:has(svg)').last();
  await sendButton.click();

  console.log('Step 6: Wait for URL to change to shell path');
  // Wait for URL to change to shell path (e.g., /dock/shell/<id>)
  try {
    await page.waitForURL(/\/(dock\/shell|flow)\/[a-zA-Z0-9_-]+/, { timeout: 10000 });
  } catch (e) {
    console.warn('Navigation did not occur within timeout');
  }

  const urlAfterSend = page.url();
  console.log('URL after send:', urlAfterSend);

  // Check for console errors after sending
  if (consoleErrors.length > 0) {
    console.error('Console errors after sending message:', consoleErrors);
  }

  // Wait a bit to see if anything happens
  await page.waitForTimeout(3000);

  console.log('Step 7: Validate user message appears in chat');
  // Wait for user message to appear
  const userMessage = page.locator('text="Hello, can you help me?"');
  await userMessage.waitFor({ state: 'visible', timeout: 5000 });
  console.log('User message is visible');

  // Screenshot with user message
  await page.screenshot({ path: '/tmp/test-step-3-user-message.png', fullPage: true });
  console.log('Screenshot saved: /tmp/test-step-3-user-message.png');

  console.log('Step 8: Wait 5 seconds for AI response');
  await page.waitForTimeout(5000);

  // Check for console errors during AI response
  if (consoleErrors.length > 0) {
    console.error('Console errors during AI response:', consoleErrors);
  }

  console.log('Step 9: Validate AI response appears');
  // Look for AI response indicators - could be assistant message, thinking component, etc.
  const aiResponse = page.locator('[class*="message"], [class*="assistant"], [class*="thinking"]').nth(1);
  const hasAIResponse = await aiResponse.isVisible().catch(() => false);

  if (!hasAIResponse) {
    console.warn('No AI response visible after 5 seconds');
  } else {
    console.log('AI response is visible');
  }

  // Screenshot with AI response
  await page.screenshot({ path: '/tmp/test-step-4-ai-response.png', fullPage: true });
  console.log('Screenshot saved: /tmp/test-step-4-ai-response.png');

  console.log('Step 10: Validate chat input is empty and ready');
  const chatInputAfter = page.locator('textarea[placeholder*="message" i], textarea[placeholder*="chat" i], textarea').first();
  const inputValue = await chatInputAfter.inputValue();

  if (inputValue === '') {
    console.log('Chat input is empty and ready for next message');
  } else {
    console.warn('Chat input is not empty:', inputValue);
  }

  // Final screenshot
  await page.screenshot({ path: '/tmp/test-step-5-final.png', fullPage: true });
  console.log('Screenshot saved: /tmp/test-step-5-final.png');

  // Report all errors
  console.log('\n=== TEST SUMMARY ===');
  console.log('Final URL:', page.url());
  console.log('Console Errors:', consoleErrors.length);
  consoleErrors.forEach(err => console.error(err));

  console.log('Network Errors:', networkErrors.length);
  networkErrors.forEach(err => console.error(err));

  // Assertions (soft - we're diagnosing)
  if (!urlAfterSend.match(/\/(dock\/shell|flow)\/[a-zA-Z0-9_-]+/)) {
    console.error('FAIL: URL did not change to shell path');
  }
  if (consoleErrors.length > 0) {
    console.error('FAIL: Console errors detected');
  }
  if (inputValue !== '') {
    console.error('FAIL: Chat input not empty');
  }
});
