import { MongoLite } from './dist/';
import path from 'path';

interface User {
  _id?: string;
  name: string;
  age: number;
  email: string;
  address?: {
    street: string;
    city: string;
  };
  hobbies?: string[];
}

async function main() {
  // Initialize the client.
  // You can use ':memory:' for an in-memory database, or provide a file path.
  const dbPath = path.join(__dirname, 'mydatabase.sqlite');
  const client = new MongoLite(dbPath);

  try {
    // Connect to the database (optional, operations will auto-connect)
    await client.connect();
    console.log('Connected to SQLite database.');

    // Get a collection (equivalent to a table)
    const usersCollection = client.collection<User>('users');

    // Insert a document
    const insertResult = await usersCollection.insertOne({
      name: 'Alice Wonderland',
      age: 30,
      email: 'alice@example.com',
      address: { street: '123 Main St', city: 'Anytown' },
      hobbies: ['reading', 'coding'],
    });
    console.log('Inserted user:', insertResult);
    const userId = insertResult.insertedId;


    // Insert multiple documents
    const insertManyResult = await usersCollection.insertMany([
      {
        name: 'Bob Builder',
        age: 35,
        email: 'test@test.com',
        address: { street: '456 Elm St', city: 'Othertown' },
        hobbies: ['building', 'designing'],
      },
      {
        name: 'Charlie Chaplin',
        age: 40,
        email: 'test2@test.com',
        address: { street: '789 Oak St', city: 'Sometown' },
        hobbies: ['acting', 'comedy'],
      },
    ]);
    console.log('Inserted multiple users:', insertManyResult);
    
    // Find a document
    const foundUser = await usersCollection.findOne({ _id: userId });
    console.log('Found user by ID:', foundUser);

    const foundUserByEmail = await usersCollection.findOne({ email: 'alice@example.com' });
    console.log('Found user by email:', foundUserByEmail);

    // Find with nested query
    const foundUserByCity = await usersCollection.findOne({ 'address.city': 'Anytown' });
    console.log('Found user by city:', foundUserByCity);

    // Find with operator ($gt)
    const olderUsers = await usersCollection.find({ age: { $gt: 25 } }).toArray();
    console.log('Users older than 25:', olderUsers);

    // Update a document
    const updateResult = await usersCollection.updateOne(
      { _id: userId },
      { $set: { age: 31, 'address.street': '456 New St' }, $push: { hobbies: 'gardening' } }
    );
    console.log('Update result:', updateResult);

    const updatedUser = await usersCollection.findOne({ _id: userId });
    console.log('Updated user:', updatedUser);

    // Delete a document
    const deleteResult = await usersCollection.deleteOne({ _id: userId });
    console.log('Delete result:', deleteResult);

    const notFoundUser = await usersCollection.findOne({ _id: userId });
    console.log('User after deletion (should be null):', notFoundUser);
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    // Close the database connection when done
    await client.close();
    console.log('Database connection closed.');
  }
}

main();
