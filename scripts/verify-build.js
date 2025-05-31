#!/usr/bin/env node

/**
 * This script builds the project and then verifies that the built module
 * exports correctly work by running the module-exports.test.ts test.
 */

import { execSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Get the current directory
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = join(__dirname, '..');

try {
  // Step 1: Build the project
  console.log('📦 Building project...');
  execSync('npm run build', {
    cwd: rootDir,
    stdio: 'inherit',
  });

  // Step 2: Run the export verification test
  console.log('\n🧪 Verifying module exports...');
  execSync('node --import tsx tests/module-exports.test.ts', {
    cwd: rootDir,
    stdio: 'inherit',
  });

  console.log('\n✅ Build verification completed successfully!');
  console.log('The module is correctly built and exports are working as expected.');
} catch (error) {
  console.error('\n❌ Build verification failed!');
  console.error('Please check your build configuration and module exports.');
  process.exit(1);
}
