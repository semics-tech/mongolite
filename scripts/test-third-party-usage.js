#!/usr/bin/env node

/**
 * This script simulates using the package as a third-party dependency.
 * It creates temporary ESM and CommonJS projects and tests importing/requiring
 * the module from each, which helps catch path resolution issues that might
 * occur in real-world usage of either module system.
 */

import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

// Get the current directory
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(join(__dirname, '..'));

function testInProject({ label, packageType, testFileName, testScript }) {
  const tempDir = mkdtempSync(join(tmpdir(), 'mongolite-test-'));
  console.log(`📁 [${label}] Created temporary test directory: ${tempDir}`);

  try {
    const packageJson = {
      name: 'mongolite-test-project',
      version: '1.0.0',
      type: packageType,
      private: true,
      dependencies: {
        '@semics-tech/mongolite': 'file:' + rootDir,
      },
    };

    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));
    writeFileSync(join(tempDir, testFileName), testScript);

    console.log(`📦 [${label}] Installing the package in test environment...`);
    execSync('npm install', { cwd: tempDir, stdio: 'inherit' });

    console.log(`\n🧪 [${label}] Testing package as a third-party dependency...`);
    execSync(`node ${testFileName}`, { cwd: tempDir, stdio: 'inherit' });

    console.log(`✅ [${label}] Passed.\n`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const esmTestScript = `
import { MongoLite } from '@semics-tech/mongolite';

async function testMongoLite() {
  console.log('🔍 Testing MongoLite ESM import in a third-party project...');
  const client = new MongoLite(':memory:');
  await client.connect();
  console.log('✅ Connected to database - Module imports are working correctly!');
  const collection = client.collection('test');
  await collection.insertOne({ test: 'data' });
  console.log('✅ Document inserted - Internal imports are working correctly!');
  const result = await collection.findOne({ test: 'data' });
  console.log('✅ Document retrieved - Query functionality works correctly!');
  await client.close();
  console.log('✅ Connection closed - All operations completed successfully!');
}

testMongoLite().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
`;

const cjsTestScript = `
const { MongoLite } = require('@semics-tech/mongolite');

async function testMongoLite() {
  console.log('🔍 Testing MongoLite CommonJS require() in a third-party project...');
  const client = new MongoLite(':memory:');
  await client.connect();
  console.log('✅ Connected to database - Module imports are working correctly!');
  const collection = client.collection('test');
  await collection.insertOne({ test: 'data' });
  console.log('✅ Document inserted - Internal imports are working correctly!');
  const result = await collection.findOne({ test: 'data' });
  console.log('✅ Document retrieved - Query functionality works correctly!');
  await client.close();
  console.log('✅ Connection closed - All operations completed successfully!');
}

testMongoLite().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
`;

try {
  testInProject({
    label: 'ESM',
    packageType: 'module',
    testFileName: 'test-mongolite.mjs',
    testScript: esmTestScript,
  });

  testInProject({
    label: 'CJS',
    packageType: 'commonjs',
    testFileName: 'test-mongolite.cjs',
    testScript: cjsTestScript,
  });
} catch (error) {
  console.error('\n❌ Third-party usage test failed!');
  console.error(error);
  process.exit(1);
}

console.log('\n🎉 Third-party usage test completed successfully!');
console.log('The package can be correctly imported (ESM) and required (CommonJS) in other projects.');
