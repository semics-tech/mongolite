import { MongoLite } from '../src';
import path from 'path';

// Define our document types with TypeScript interfaces
interface Product {
  _id?: string;
  name: string;
  price: number;
  category: string;
  tags: string[];
  inStock: boolean;
  details?: {
    description: string;
    manufacturer: string;
    dimensions?: {
      width: number;
      height: number;
      depth: number;
    };
  };
}

interface Order {
  _id?: string;
  customerId: string;
  orderDate: string;
  items: Array<{
    productId: string;
    quantity: number;
    price: number;
  }>;
  total: number;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  shippingAddress: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
}

async function main() {
  // Use in-memory database for this example
  const client = new MongoLite(':memory:');
  
  try {
    await client.connect();
    console.log('Connected to in-memory SQLite database');
    
    // Get our collections
    const productsCollection = client.collection<Product>('products');
    const ordersCollection = client.collection<Order>('orders');
    
    // Insert some products
    const productInsertions = await Promise.all([
      productsCollection.insertOne({
        name: 'Laptop',
        price: 999.99,
        category: 'Electronics',
        tags: ['computer', 'work', 'gaming'],
        inStock: true,
        details: {
          description: 'Powerful laptop for work and gaming',
          manufacturer: 'TechCo',
          dimensions: {
            width: 14,
            height: 0.7,
            depth: 9.5
          }
        }
      }),
      productsCollection.insertOne({
        name: 'Coffee Maker',
        price: 79.99,
        category: 'Kitchen',
        tags: ['appliance', 'coffee', 'morning'],
        inStock: true,
        details: {
          description: 'Programmable drip coffee maker',
          manufacturer: 'HomeGoods'
        }
      }),
      productsCollection.insertOne({
        name: 'Headphones',
        price: 149.99,
        category: 'Electronics',
        tags: ['audio', 'music', 'wireless'],
        inStock: false,
        details: {
          description: 'Noise-cancelling wireless headphones',
          manufacturer: 'AudioTech'
        }
      })
    ]);
    
    console.log(`Inserted ${productInsertions.length} products`);
    
    // Create an order
    const customerId = 'customer-123';
    const orderInsertResult = await ordersCollection.insertOne({
      customerId,
      orderDate: new Date().toISOString(),
      items: [
        {
          productId: productInsertions[0].insertedId,
          quantity: 1,
          price: 999.99
        },
        {
          productId: productInsertions[1].insertedId,
          quantity: 2,
          price: 79.99
        }
      ],
      total: 999.99 + (2 * 79.99),
      status: 'pending',
      shippingAddress: {
        street: '123 Main St',
        city: 'Anytown',
        state: 'CA',
        postalCode: '12345',
        country: 'USA'
      }
    });
    
    console.log(`Created order with ID: ${orderInsertResult.insertedId}`);
    
    // Query 1: Find all electronics products
    const electronicsProducts = await productsCollection.find({
      category: 'Electronics'
    }).toArray();
    
    console.log('Electronics products:');
    electronicsProducts.forEach(product => {
      console.log(`- ${product.name} ($${product.price})`);
    });
    
    // Query 2: Find in-stock products under $100
    const affordableInStock = await productsCollection.find({
      price: { $lt: 100 },
      inStock: true
    }).toArray();
    
    console.log('\nAffordable in-stock products:');
    affordableInStock.forEach(product => {
      console.log(`- ${product.name} ($${product.price})`);
    });
    
    // Query 3: Find products with specific tags
    const wirelessProducts = await productsCollection.find({
      tags: { $in: ['wireless'] }
    }).toArray();
    
    console.log('\nWireless products:');
    wirelessProducts.forEach(product => {
      console.log(`- ${product.name} (in stock: ${product.inStock})`);
    });
    
    // Query 4: Find orders for a specific customer
    const customerOrders = await ordersCollection.find({
      customerId
    }).toArray();
    
    console.log(`\nOrders for customer ${customerId}:`);
    customerOrders.forEach(order => {
      console.log(`- Order ID: ${order._id}, Status: ${order.status}, Total: $${order.total.toFixed(2)}`);
      console.log(`  Items: ${order.items.reduce((sum, item) => sum + item.quantity, 0)}`);
    });
    
    // Update 1: Update order status
    const updateResult = await ordersCollection.updateOne(
      { _id: orderInsertResult.insertedId },
      { $set: { status: 'processing' } }
    );
    
    console.log(`\nUpdated order status: ${updateResult.modifiedCount} document modified`);
    
    // Update 2: Update product price and add a tag
    const productUpdateResult = await productsCollection.updateOne(
      { name: 'Laptop' },
      { 
        $set: { price: 899.99 },
        $push: { tags: 'sale' }
      }
    );
    
    console.log(`Updated product: ${productUpdateResult.modifiedCount} document modified`);
    
    // Verify updates
    const updatedOrder = await ordersCollection.findOne({ _id: orderInsertResult.insertedId });
    console.log(`\nUpdated order status: ${updatedOrder?.status}`);
    
    const updatedProduct = await productsCollection.findOne({ name: 'Laptop' });
    console.log(`Updated laptop price: $${updatedProduct?.price}, tags: ${updatedProduct?.tags.join(', ')}`);
    
  } catch (error) {
    console.error('Error in advanced example:', error);
  } finally {
    await client.close();
    console.log('\nDatabase connection closed');
  }
}

// Run the example
main().catch(console.error);
