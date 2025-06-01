import { MongoLiteDB } from './src/index.js';

async function testTrueProjection() {
  // Create a new database instance
  const db = new MongoLiteDB(':memory:');
  
  // Get a collection
  const collection = db.collection('test');
  
  // Insert a test document
  const result = await collection.insertOne({
    name: 'Test User',
    age: 30,
    email: 'test@example.com',
    address: {
      city: 'Test City',
      country: 'Test Country'
    }
  });
  
  console.log('Inserted document with ID:', result.insertedId);
  
  // Test projection with true values
  const docWithTrueProjection = await collection.findOne(
    { _id: result.insertedId },
    { name: true, 'address.city': true }
  );
  
  console.log('Document with true projection:', docWithTrueProjection);
  
  // Test projection with 1 values (for comparison)
  const docWith1Projection = await collection.findOne(
    { _id: result.insertedId },
    { name: 1, 'address.city': 1 }
  );
  
  console.log('Document with 1 projection:', docWith1Projection);
  
  // Test projection with false values
  const docWithFalseProjection = await collection.findOne(
    { _id: result.insertedId },
    { age: false, email: false }
  );
  
  console.log('Document with false projection:', docWithFalseProjection);
  
  // Clean up
  await db.close();
}

testTrueProjection().catch(console.error);
