import { MongoLite } from '../src/index.js';
import path from 'path';

interface User {
    _id?: string;
    name: string;
    age: number;
    email: string;
    isActive: boolean;
    department: string;
    salary: number;
    address: {
        street: string;
        city: string;
        country: string;
    };
    skills: string[];
    joinDate: string;
}

async function setupTestData() {
    console.log('🔧 Setting up test data for query debugging...');

    const dbPath = path.join(process.cwd(), 'debug.sqlite');
    const client = new MongoLite(dbPath);

    try {
        await client.connect();
        console.log('Connected to debug database.');

        const usersCollection = client.collection<User>('users');

        // Clear existing data
        await usersCollection.deleteMany({});

        // Insert test users
        const testUsers: Omit<User, '_id'>[] = [
            {
                name: 'Alice Johnson',
                age: 28,
                email: 'alice@company.com',
                isActive: true,
                department: 'Engineering',
                salary: 85000,
                address: {
                    street: '123 Tech St',
                    city: 'San Francisco',
                    country: 'USA'
                },
                skills: ['JavaScript', 'TypeScript', 'React', 'Node.js'],
                joinDate: '2022-01-15'
            },
            {
                name: 'Bob Smith',
                age: 34,
                email: 'bob@company.com',
                isActive: true,
                department: 'Engineering',
                salary: 95000,
                address: {
                    street: '456 Code Ave',
                    city: 'Seattle',
                    country: 'USA'
                },
                skills: ['Python', 'Django', 'PostgreSQL', 'Docker'],
                joinDate: '2021-03-10'
            },
            {
                name: 'Carol Davis',
                age: 31,
                email: 'carol@company.com',
                isActive: false,
                department: 'Marketing',
                salary: 70000,
                address: {
                    street: '789 Marketing Blvd',
                    city: 'New York',
                    country: 'USA'
                },
                skills: ['Marketing', 'SEO', 'Analytics', 'Content Writing'],
                joinDate: '2020-07-22'
            },
            {
                name: 'David Wilson',
                age: 29,
                email: 'david@company.com',
                isActive: true,
                department: 'Engineering',
                salary: 90000,
                address: {
                    street: '321 Developer Dr',
                    city: 'Austin',
                    country: 'USA'
                },
                skills: ['Go', 'Kubernetes', 'AWS', 'Microservices'],
                joinDate: '2021-11-05'
            },
            {
                name: 'Eva Brown',
                age: 26,
                email: 'eva@company.com',
                isActive: true,
                department: 'Design',
                salary: 75000,
                address: {
                    street: '654 Design Lane',
                    city: 'Los Angeles',
                    country: 'USA'
                },
                skills: ['UI/UX', 'Figma', 'Adobe Creative Suite', 'User Research'],
                joinDate: '2023-02-14'
            },
            {
                name: 'Frank Miller',
                age: 42,
                email: 'frank@company.com',
                isActive: true,
                department: 'Management',
                salary: 120000,
                address: {
                    street: '987 Executive Rd',
                    city: 'Chicago',
                    country: 'USA'
                },
                skills: ['Leadership', 'Strategy', 'Project Management', 'Team Building'],
                joinDate: '2019-01-08'
            }
        ];

        for (const user of testUsers) {
            await usersCollection.insertOne(user);
        }

        console.log(`✅ Inserted ${testUsers.length} test users.`);

        // Also create a products collection for more complex testing
        const productsCollection = client.collection('products');
        await productsCollection.deleteMany({});

        const testProducts = [
            {
                name: 'Laptop Pro',
                price: 1299.99,
                category: 'Electronics',
                inStock: true,
                tags: ['computer', 'work', 'portable'],
                specs: {
                    cpu: 'Intel i7',
                    ram: '16GB',
                    storage: '512GB SSD'
                },
                reviews: [
                    { rating: 5, comment: 'Excellent laptop!' },
                    { rating: 4, comment: 'Good performance' }
                ]
            },
            {
                name: 'Wireless Mouse',
                price: 29.99,
                category: 'Electronics',
                inStock: true,
                tags: ['mouse', 'wireless', 'accessory'],
                specs: {
                    connectivity: 'Bluetooth',
                    battery: '6 months',
                    dpi: '1600'
                },
                reviews: [
                    { rating: 4, comment: 'Works well' },
                    { rating: 5, comment: 'Great value' }
                ]
            },
            {
                name: 'Office Chair',
                price: 249.99,
                category: 'Furniture',
                inStock: false,
                tags: ['chair', 'office', 'ergonomic'],
                specs: {
                    material: 'Mesh',
                    adjustable: true,
                    warranty: '5 years'
                },
                reviews: [
                    { rating: 5, comment: 'Very comfortable' }
                ]
            }
        ];

        for (const product of testProducts) {
            await productsCollection.insertOne(product);
        }

        console.log(`✅ Inserted ${testProducts.length} test products.`);

        console.log('');
        console.log('🎯 Test data ready! You can now run the query debugger:');
        console.log('  npm run debug-queries');
        console.log('');
        console.log('Try these example queries:');
        console.log('  .use users');
        console.log('  .find {"department": "Engineering"}');
        console.log('  .find {"age": {"$gte": 30}, "isActive": true}');
        console.log('  .find {"skills": {"$in": ["JavaScript", "Python"]}}');
        console.log('  .find {"address.city": "San Francisco"}');
        console.log('  .find {"salary": {"$gt": 80000}}');
        console.log('');
        console.log('  .use products');
        console.log('  .find {"category": "Electronics", "inStock": true}');
        console.log('  .find {"price": {"$lt": 50}}');
        console.log('  .find {"tags": {"$all": ["computer", "work"]}}');
        console.log('');

    } finally {
        await client.close();
    }
}

setupTestData().catch(error => {
    console.error('Error setting up test data:', error);
    process.exit(1);
});
