#!/usr/bin/env node

/**
 * This script simulates using the package as a third-party dependency.
 * It creates a temporary directory and tests importing the module from there,
 * which helps catch path resolution issues that might occur in real-world usage.
 */

import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

// Get the current directory
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(join(__dirname, '..'));

// Create a temporary directory
const tempDir = mkdtempSync(join(tmpdir(), 'mongolite-test-'));
console.log(`📁 Created temporary test directory: ${tempDir}`);

try {
  // Create a package.json in the temp directory
  const packageJson = {
    "name": "mongolite-test-project",
    "version": "1.0.0",
    "type": "module",
    "private": true,
    "dependencies": {
      "mongolite-ts": "file:" + rootDir
    }
  };
  
  writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));
  
  // Create a test script that imports and uses the package
  const testScript = `
import { MongoLite } from 'mongolite-ts';

async function testMongoLite() {
  console.log('🔍 Testing MongoLite import in a third-party project...');
  
  try {
    // Initialize the client
    const client = new MongoLite(':memory:');
    
    // Connect to the database
    await client.connect();
    console.log('✅ Connected to database - Module imports are working correctly!');
    
    // Get a collection
    const collection = client.collection('test');
    
    // Test insertion
    const insertResult = await collection.insertOne({ test: 'data' });
    console.log('✅ Document inserted - Internal imports are working correctly!');
    
    // Test querying
    const result = await collection.findOne({ test: 'data' });
    console.log('✅ Document retrieved - Query functionality works correctly!');
    
    // Close the connection
    await client.close();
    console.log('✅ Connection closed - All operations completed successfully!');
    
    console.log('\\n🎉 Success! The package works correctly when used as a dependency.');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testMongoLite();
`;
  
  writeFileSync(join(tempDir, 'test-mongolite.js'), testScript);
  
  // Install the local package in the temp directory
  console.log('📦 Installing the package in test environment...');
  execSync('npm install', { 
    cwd: tempDir, 
    stdio: 'inherit'
  });
  
  // Run the test script
  console.log('\n🧪 Testing package as a third-party dependency...');
  execSync('node test-mongolite.js', { 
    cwd: tempDir, 
    stdio: 'inherit'
  });
  
} catch (error) {
  console.error('\n❌ Third-party usage test failed!');
  console.error(error);
  process.exit(1);
} finally {
  // Clean up - remove the temporary directory
  console.log(`\n🧹 Cleaning up test directory: ${tempDir}`);
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('\n✅ Third-party usage test completed successfully!');
console.log('The package can be correctly imported and used in other projects.');
