import { MongoLite } from '../src/index.js';
import { DocumentWithId } from '../src/types.js';

interface User extends DocumentWithId {
  name: string;
  email: string;
  age: number;
  address: {
    city: string;
    country: string;
  };
  tags: string[];
}

async function main() {
  // Initialize the client with an in-memory database for this example
  const client = new MongoLite(':memory:', { verbose: true });

  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to in-memory SQLite database');

    // Get a collection
    const usersCollection = client.collection<User>('users');

    // Insert some sample data
    console.log('Inserting sample data...');
    await usersCollection.insertMany([
      {
        name: 'Alice Smith',
        email: 'alice@example.com',
        age: 30,
        address: { city: 'New York', country: 'USA' },
        tags: ['customer', 'premium']
      },
      {
        name: 'Bob Johnson',
        email: 'bob@example.com',
        age: 25,
        address: { city: 'London', country: 'UK' },
        tags: ['customer']
      },
      {
        name: 'Charlie Brown',
        email: 'charlie@example.com',
        age: 35,
        address: { city: 'Paris', country: 'France' },
        tags: ['customer', 'premium', 'beta']
      },
      {
        name: 'Diana Prince',
        email: 'diana@example.com',
        age: 28,
        address: { city: 'Berlin', country: 'Germany' },
        tags: ['customer', 'beta']
      }
    ]);

    // Create a simple index on the email field (which should be unique)
    console.log('\nCreating unique index on email field...');
    const emailIndexResult = await usersCollection.createIndex(
      { email: 1 },
      { unique: true, name: 'idx_email_unique' }
    );
    console.log('Email index created:', emailIndexResult);

    // Create a compound index on age and name
    console.log('\nCreating compound index on age and name...');
    const ageNameIndexResult = await usersCollection.createIndex({ age: -1, name: 1 });
    console.log('Age+Name index created:', ageNameIndexResult);

    // Create an index on a nested field
    console.log('\nCreating index on nested field (address.city)...');
    const cityIndexResult = await usersCollection.createIndex({ 'address.city': 1 });
    console.log('City index created:', cityIndexResult);

    // List all indexes
    console.log('\nListing all indexes:');
    const indexes = await usersCollection.listIndexes().toArray();
    console.log(JSON.stringify(indexes, null, 2));

    // Demonstrate performance improvement with index
    console.log('\nDemonstrating query performance:');
    
    // Query with an indexed field
    console.log('Querying with indexed field (email):');
    console.time('email-query');
    const userByEmail = await usersCollection.findOne({ email: 'charlie@example.com' });
    console.timeEnd('email-query');
    console.log(`Found user: ${userByEmail?.name}`);

    // Query with an indexed nested field
    console.log('\nQuerying with indexed nested field (address.city):');
    console.time('city-query');
    const userByCity = await usersCollection.findOne({ 'address.city': 'Berlin' });
    console.timeEnd('city-query');
    console.log(`Found user: ${userByCity?.name}`);

    // Try to insert a duplicate email (should fail with unique constraint)
    console.log('\nTrying to insert a duplicate email (should fail):');
    try {
      await usersCollection.insertOne({
        name: 'Alice Clone',
        email: 'alice@example.com', // Already exists
        age: 31,
        address: { city: 'Chicago', country: 'USA' },
        tags: ['customer']
      });
    } catch (error) {
      console.log(`Expected error occurred: ${(error as Error).message}`);
    }

    // Drop a specific index
    console.log('\nDropping the age+name index:');
    const dropResult = await usersCollection.dropIndex(ageNameIndexResult.name);
    console.log('Drop result:', dropResult);

    // List indexes after dropping one
    console.log('\nListing indexes after dropping one:');
    const remainingIndexes = await usersCollection.listIndexes().toArray();
    console.log(JSON.stringify(remainingIndexes, null, 2));

    // Drop all indexes
    console.log('\nDropping all indexes:');
    const dropAllResult = await usersCollection.dropIndexes();
    console.log('Drop all result:', dropAllResult);

    // Confirm all indexes are gone
    console.log('\nConfirming all indexes are gone:');
    const finalIndexes = await usersCollection.listIndexes().toArray();
    console.log(JSON.stringify(finalIndexes, null, 2));

  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    // Close the database connection
    await client.close();
    console.log('\nDatabase connection closed.');
  }
}

main().catch(console.error);
