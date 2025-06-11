import { MongoLite } from '../src';
import path from 'path';

interface User {
  _id?: string;
  name: string;
  email: string;
}

interface Product {
  _id?: string;
  name: string;
  price: number;
}

async function main() {
  // Initialize the client
  const dbPath = path.join(__dirname, 'example-database.sqlite');
  const client = new MongoLite(dbPath);

  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to SQLite database.');

    // Get a collection and insert a document to create it
    const usersCollection = client.collection<User>('users');
    await usersCollection.insertOne({
      name: 'John Doe',
      email: 'john@example.com',
    });

    // Create another collection
    const productsCollection = client.collection<Product>('products');
    await productsCollection.insertOne({
      name: 'Laptop',
      price: 1299.99,
    });

    // List all collections in the database
    const collections = await client.listCollections().toArray();
    console.log('Collections in the database:', collections);

    // Output should include 'users' and 'products'
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Close the connection
    await client.close();
    console.log('Connection closed.');
  }
}

main().catch(console.error);
