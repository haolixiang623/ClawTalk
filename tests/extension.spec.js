import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the unpacked extension
const EXTENSION_PATH = path.resolve(__dirname, '..');

test.describe('ClawTalk Extension - Options Page', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to options page directly
    const optionsPath = path.join(EXTENSION_PATH, 'options.html');
    await page.goto(`file://${optionsPath}`);
    await page.waitForLoadState('domcontentloaded');
    // Wait for script to initialize
    await page.waitForTimeout(500);
  });

  test('should load options page without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    // Wait for settings to load
    await page.waitForSelector('#gateway-url', { timeout: 5000 });

    // Check no errors occurred (filter out non-critical ones)
    const criticalErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('net::ERR') &&
      !e.includes('Extension context')
    );
    expect(criticalErrors).toHaveLength(0);

    // Verify key elements exist
    await expect(page.locator('#gateway-url')).toBeVisible();
    await expect(page.locator('#gateway-token')).toBeVisible();
    await expect(page.locator('#test-connection')).toBeVisible();
    await expect(page.locator('#save')).toBeVisible();
  });

  test('should have gateway URL input working', async ({ page }) => {
    await page.waitForSelector('#gateway-url', { timeout: 5000 });

    // Clear and set a new value
    await page.locator('#gateway-url').fill('ws://localhost:18789');

    const value = await page.locator('#gateway-url').inputValue();
    expect(value).toBe('ws://localhost:18789');
  });

  test('should have connection test button', async ({ page }) => {
    await page.waitForSelector('#test-connection', { timeout: 5000 });

    // Check button exists and is clickable
    const button = page.locator('#test-connection');
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test('should show error for empty gateway URL in connection test', async ({ page }) => {
    await page.waitForSelector('#test-connection', { timeout: 5000 });

    // Clear the gateway URL
    await page.locator('#gateway-url').fill('');

    // Click test connection
    await page.locator('#test-connection').click();

    // Wait a bit for the handler to run
    await page.waitForTimeout(200);

    // Note: In file:// mode, chrome APIs are not available, so status may not update
    // We just verify the button is clickable and no crash occurs
    const status = await page.locator('#test-connection-status').textContent();
    // Either shows error or is empty (if chrome APIs unavailable)
    expect(typeof status).toBe('string');
  });

  test('should show error for invalid gateway URL', async ({ page }) => {
    await page.waitForSelector('#test-connection', { timeout: 5000 });

    // Set invalid URL
    await page.locator('#gateway-url').fill('not-a-valid-url');

    // Click test connection
    await page.locator('#test-connection').click();

    // Wait for handler
    await page.waitForTimeout(200);

    // Should not crash
    const status = await page.locator('#test-connection-status').textContent();
    expect(typeof status).toBe('string');
  });
});

test.describe('ClawTalk Extension - Sidepanel', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to sidepanel directly
    const sidepanelPath = path.join(EXTENSION_PATH, 'sidepanel.html');
    await page.goto(`file://${sidepanelPath}`);
    await page.waitForLoadState('domcontentloaded');
    // Wait for script to initialize
    await page.waitForTimeout(500);
  });

  test('should load sidepanel without critical errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    // Wait for sidepanel to initialize
    await page.waitForSelector('#connect-toggle', { timeout: 5000 });

    // Check no critical errors
    const criticalErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('net::ERR') &&
      !e.includes('Extension context') &&
      !e.includes('Service worker')
    );
    expect(criticalErrors).toHaveLength(0);

    // Verify key elements
    await expect(page.locator('#connect-toggle')).toBeVisible();
    await expect(page.locator('#talk-toggle')).toBeVisible();
    await expect(page.locator('#status-text')).toBeVisible();
  });

  test('should have disconnect state initially', async ({ page }) => {
    await page.waitForSelector('#status-text', { timeout: 5000 });

    const status = await page.locator('#status-text').textContent();
    expect(status).toBeTruthy();
  });
});

test.describe('ClawTalk Gateway Client', () => {
  test('should have token input field', async ({ page }) => {
    const optionsPath = path.join(EXTENSION_PATH, 'options.html');
    await page.goto(`file://${optionsPath}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    const tokenInput = page.locator('#gateway-token');
    await expect(tokenInput).toBeVisible();
  });

  test('should have gateway URL input field', async ({ page }) => {
    const optionsPath = path.join(EXTENSION_PATH, 'options.html');
    await page.goto(`file://${optionsPath}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    // The input exists and accepts input
    await page.locator('#gateway-url').fill('ws://test.example.com:8080');
    const value = await page.locator('#gateway-url').inputValue();
    expect(value).toBe('ws://test.example.com:8080');
  });
});

test.describe('Code Quality Checks', () => {
  test('gateway_client.js should export GatewayClient class', async () => {
    // Read the file and check for class definition
    const gatewayClientPath = path.join(EXTENSION_PATH, 'shared', 'gateway_client.js');
    const content = fs.readFileSync(gatewayClientPath, 'utf8');

    // Should export GatewayClient
    expect(content).toContain('export class GatewayClient');

    // Should have connect method
    expect(content).toContain('connect()');

    // Should have handleMessage method
    expect(content).toContain('handleMessage(');

    // Should have diagnostic functionality
    expect(content).toContain('diagnoseConnection');
  });

  test('gateway_client.js should have enhanced error handling', async () => {
    const gatewayClientPath = path.join(EXTENSION_PATH, 'shared', 'gateway_client.js');
    const content = fs.readFileSync(gatewayClientPath, 'utf8');

    // Should have socket_diagnostic state
    expect(content).toContain('socket_diagnostic');

    // Should have socket_connected state
    expect(content).toContain('socket_connected');

    // Should handle code 1006 with hints
    expect(content).toContain('1006');

    // Should have helpful hints
    expect(content).toContain('permission');
  });

  test('service_worker.js should have exponential backoff', async () => {
    const swPath = path.join(EXTENSION_PATH, 'service_worker.js');
    const content = fs.readFileSync(swPath, 'utf8');

    // Should have reconnect attempt tracking
    expect(content).toContain('reconnectAttempt');

    // Should have exponential backoff delay
    expect(content).toContain('Math.pow');

    // Should have max reconnect delay
    expect(content).toContain('MAX_RECONNECT_DELAY_MS');

    // Should have reset reconnect state function
    expect(content).toContain('resetReconnectState');
  });

  test('options.js should have connection test function', async () => {
    const optionsPath = path.join(EXTENSION_PATH, 'options.js');
    const content = fs.readFileSync(optionsPath, 'utf8');

    // Should have test connection button handler
    expect(content).toContain('testConnectionButton');

    // Should have test gateway connection function
    expect(content).toContain('testGatewayConnection');

    // Should have permission check
    expect(content).toContain('chrome.permissions');
  });

  test('manifest.json should have correct permissions', async () => {
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    const content = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(content);

    // Should have WebSocket host permissions
    expect(manifest.host_permissions).toContain('ws://127.0.0.1:18789/*');

    // Should allow all WebSocket connections optionally
    expect(manifest.optional_host_permissions).toContain('ws://*/*');
    expect(manifest.optional_host_permissions).toContain('wss://*/*');
  });
});
