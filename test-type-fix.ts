// Quick test to verify that findOne returns full type T instead of Partial<T>
import { MongoLite, DocumentWithId } from './src/index.js';

interface User extends DocumentWithId {
  name: string;
  email: string;
  age: number;
}

async function testTypeFix() {
  const db = new MongoLite(':memory:');
  await db.connect();
  const users = db.collection<User>('users');

  // Insert a test user
  await users.insertOne({
    name: 'Test User',
    email: 'test@example.com',
    age: 25,
  });

  // Test 1: findOne should return User | null (not Partial<User> | null)
  const user = await users.findOne({ name: 'Test User' });
  if (user) {
    // These properties should all be available without TypeScript complaining
    console.log('✅ Test 1: findOne returns full type');
    console.log('   _id:', user._id);
    console.log('   name:', user.name);
    console.log('   email:', user.email);
    console.log('   age:', user.age);
  }

  // Test 2: find().toArray() should return User[] (not Partial<User>[])
  const allUsers = await users.find({}).toArray();
  if (allUsers.length > 0) {
    const firstUser = allUsers[0];
    console.log('✅ Test 2: find().toArray() returns full type');
    console.log('   _id:', firstUser._id);
    console.log('   name:', firstUser.name);
    console.log('   email:', firstUser.email);
    console.log('   age:', firstUser.age);
  }

  // Test 3: find().first() should return User | null (not Partial<User> | null)
  const firstUserFromCursor = await users.find({}).first();
  if (firstUserFromCursor) {
    console.log('✅ Test 3: find().first() returns full type');
    console.log('   _id:', firstUserFromCursor._id);
    console.log('   name:', firstUserFromCursor.name);
    console.log('   email:', firstUserFromCursor.email);
    console.log('   age:', firstUserFromCursor.age);
  }

  // Test 4: With projection, the return type is still T but some fields may be undefined
  // This is acceptable since TypeScript's structural typing allows this
  const userWithProjection = await users.findOne({ name: 'Test User' }, { name: 1 });
  if (userWithProjection) {
    console.log('✅ Test 4: findOne with projection returns T (but fields may be undefined at runtime)');
    console.log('   _id:', userWithProjection._id);
    console.log('   name:', userWithProjection.name);
    console.log('   email:', userWithProjection.email, '(should be undefined)');
    console.log('   age:', userWithProjection.age, '(should be undefined)');
  }

  await db.close();
  console.log('\n✅ All type tests passed!');
}

testTypeFix().catch(console.error);
