/**
 * Mux Webhook Setup Utility
 * 
 * This script helps developers set up and test Mux webhooks in development environments.
 * It provides instructions for setting up tunneling and configuring webhooks.
 */

import 'dotenv/config';
import muxConfig from '../src/config/muxConfig.js';
import Mux from '@mux/mux-node';
import readline from 'readline';
const chalkModule = await import('chalk');
const chalk = chalkModule.default; // You may need to install this: npm install chalk

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Check if Mux is configured
if (!muxConfig.isConfigured()) {
  console.error(chalk.red('❌ Mux configuration is incomplete!'));
  console.log(chalk.yellow('Please make sure the following environment variables are set in your .env file:'));
  console.log('  - MUX_TOKEN_ID');
  console.log('  - MUX_TOKEN_SECRET');
  console.log('  - MUX_WEBHOOK_SECRET');
  process.exit(1);
}

// Initialize Mux client
const { tokenId, tokenSecret } = muxConfig.credentials;
const mux = new Mux(tokenId, tokenSecret);

// Main function
async function main() {
  console.log(chalk.green('\n🎬 Mux Webhook Setup Utility'));
  console.log(chalk.cyan('============================\n'));
  
  // Display current configuration
  console.log(chalk.yellow('Current Configuration:'));
  console.log(`Webhook URL: ${chalk.green(muxConfig.webhooks.getWebhookUrl())}`);
  console.log(`Environment: ${chalk.green(process.env.NODE_ENV || 'development')}\n`);
  
  if (muxConfig.isDevelopment) {
    console.log(chalk.yellow('Development Environment Detected!'));
    console.log('For webhooks to work in development, you need to expose your local server to the internet.');
    console.log('\nYou can use one of these tunneling tools:');
    
    Object.entries(muxConfig.developmentInstructions).forEach(([tool, command]) => {
      console.log(`  - ${chalk.cyan(tool)}: ${command}`);
    });
    
    console.log('\nAfter starting a tunnel, update your .env file with:');
    console.log(chalk.green('DEV_TUNNEL_URL=https://your-tunnel-url'));
    
    const tunnelUrl = await promptUser('Enter your tunnel URL (or press Enter to skip): ');
    if (tunnelUrl) {
      process.env.DEV_TUNNEL_URL = tunnelUrl;
      console.log(`Using tunnel URL: ${chalk.green(tunnelUrl)}`);
    }
  }
  
  // Display webhook options
  console.log('\n' + chalk.yellow('What would you like to do?'));
  console.log('  1. Test webhook configuration');
  console.log('  2. List existing webhooks');
  console.log('  3. Create a new webhook');
  console.log('  4. Exit');
  
  const choice = await promptUser('Enter your choice (1-4): ');
  
  switch (choice) {
    case '1':
      await testWebhookConfiguration();
      break;
    case '2':
      await listWebhooks();
      break;
    case '3':
      await createWebhook();
      break;
    case '4':
      console.log(chalk.green('\nExiting. Goodbye!'));
      process.exit(0);
    default:
      console.log(chalk.red('\nInvalid choice. Please try again.'));
      await main();
  }
  
  // Ask if user wants to continue
  const continueChoice = await promptUser('\nDo you want to continue? (y/n): ');
  if (continueChoice.toLowerCase() === 'y') {
    await main();
  } else {
    console.log(chalk.green('\nExiting. Goodbye!'));
    process.exit(0);
  }
}

// Test webhook configuration
async function testWebhookConfiguration() {
  console.log(chalk.cyan('\nTesting Webhook Configuration...'));
  
  // Display webhook URL
  const webhookUrl = muxConfig.webhooks.getWebhookUrl();
  console.log(`Webhook URL: ${chalk.green(webhookUrl)}`);
  
  // Check if URL is accessible
  console.log('\nChecking if webhook URL is publicly accessible...');
  console.log(chalk.yellow('Note: This is a basic check and may not be 100% accurate.'));
  
  try {
    const response = await fetch(webhookUrl, { method: 'HEAD' });
    if (response.ok) {
      console.log(chalk.green('✅ Webhook URL appears to be accessible!'));
    } else {
      console.log(chalk.red(`❌ Webhook URL returned status: ${response.status}`));
      console.log('This may indicate that your URL is not properly configured or accessible.');
    }
  } catch (error) {
    console.log(chalk.red(`❌ Error accessing webhook URL: ${error.message}`));
    console.log('This may indicate that your URL is not properly configured or accessible.');
  }
  
  // Display webhook secret status
  if (muxConfig.credentials.webhookSecret) {
    console.log(chalk.green('\n✅ Webhook secret is configured.'));
  } else {
    console.log(chalk.red('\n❌ Webhook secret is not configured.'));
    console.log('Add MUX_WEBHOOK_SECRET to your .env file.');
  }
  
  console.log('\nTo manually test your webhook:');
  console.log('1. Create a webhook in the Mux dashboard pointing to your webhook URL');
  console.log('2. Use the "Send test webhook" feature in the Mux dashboard');
  console.log('3. Check your server logs for webhook processing');
}

// List existing webhooks
async function listWebhooks() {
  console.log(chalk.cyan('\nListing Existing Webhooks...'));
  
  try {
    const { data } = await mux.webhooks.list();
    
    if (data.length === 0) {
      console.log(chalk.yellow('No webhooks found.'));
    } else {
      console.log(chalk.green(`Found ${data.length} webhooks:\n`));
      
      data.forEach((webhook, index) => {
        console.log(chalk.cyan(`Webhook #${index + 1}:`));
        console.log(`  ID: ${webhook.id}`);
        console.log(`  URL: ${webhook.url}`);
        console.log(`  Status: ${webhook.status}`);
        console.log(`  Created At: ${new Date(webhook.created_at).toLocaleString()}`);
        console.log('');
      });
    }
  } catch (error) {
    console.error(chalk.red(`Error listing webhooks: ${error.message}`));
  }
}

// Create a new webhook
async function createWebhook() {
  console.log(chalk.cyan('\nCreating a New Webhook...'));
  
  const webhookUrl = await promptUser(`Enter webhook URL (default: ${muxConfig.webhooks.getWebhookUrl()}): `);
  const url = webhookUrl || muxConfig.webhooks.getWebhookUrl();
  
  try {
    const { data } = await mux.webhooks.create({
      url,
      events: muxConfig.webhooks.supportedEvents
    });
    
    console.log(chalk.green('\n✅ Webhook created successfully!'));
    console.log(`  ID: ${data.id}`);
    console.log(`  URL: ${data.url}`);
    console.log(`  Events: ${data.events.join(', ')}`);
    console.log(`  Status: ${data.status}`);
    
    console.log(chalk.yellow('\nImportant:'));
    console.log('1. Make sure your server is running and accessible at the webhook URL');
    console.log('2. Verify that MUX_WEBHOOK_SECRET in your .env file matches the signing secret in the Mux dashboard');
    console.log('3. You can test the webhook by uploading a video or using the "Send test webhook" feature in the Mux dashboard');
  } catch (error) {
    console.error(chalk.red(`Error creating webhook: ${error.message}`));
  }
}

// Helper function to prompt user for input
function promptUser(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Run the main function
main().catch(error => {
  console.error(chalk.red(`Error: ${error.message}`));
  process.exit(1);
}).finally(() => {
  rl.close();
});