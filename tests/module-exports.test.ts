/**
 * This test verifies that the built module correctly exports the expected
 * classes and interfaces. It helps catch build configuration issues that
 * might cause runtime errors when importing the module.
 * 
 * It also specifically tests for path resolution issues that can occur
 * when the package is installed in third-party projects.
 */

// First, import from the built module (dist/index.js)
import { MongoLite, MongoLiteCollection } from '../dist/index.js';

// Basic test to ensure MongoLite is exported correctly
if (typeof MongoLite !== 'function') {
  throw new Error('MongoLite is not exported as a constructor function');
}

// Test MongoLiteCollection export
if (typeof MongoLiteCollection !== 'function') {
  throw new Error('MongoLiteCollection is not exported as a constructor function');
}

// This section tests the internal module resolution
async function testInternalModuleResolution() {
  try {
    // Check internal module imports by actually using the functionality
    // This will fail if path resolution for internal modules is broken
    const client = new MongoLite(':memory:');
    
    // Connect to verify db.js is correctly imported
    await client.connect();
    
    // Get a collection to verify collection.js is correctly imported
    const collection = client.collection('test_collection');
    
    // Insert a document to verify the full chain of dependencies works
    const insertResult = await collection.insertOne({
      _id: 'test',
      testField: 'This tests the complete import chain'
    });
    
    if (!insertResult || !insertResult.insertedId) {
      throw new Error('Failed to insert document - possible module resolution issue');
    }
    
    // Query the document to ensure all components work together
    const foundDoc = await collection.findOne({ _id: 'test' });
    if (!foundDoc || foundDoc.testField !== 'This tests the complete import chain') {
      throw new Error('Failed to find document - possible module resolution issue');
    }
    
    // Clean up
    await client.close();
    
    console.log('✅ Module export test passed - MongoLite is correctly exported');
    console.log('✅ Internal module resolution test passed - All internal imports work correctly');
  } catch (error) {
    console.error('❌ Module resolution test failed:', error);
    process.exit(1);
  }
}

// Run the comprehensive test
testInternalModuleResolution();
