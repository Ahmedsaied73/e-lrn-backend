const prisma = require('./db');
const bcrypt = require('bcrypt');
const config = require('./env');

/**
 * Ensures that a default admin exists in the system.
 * Credentials are sourced exclusively from environment variables (config.admin.*).
 * Run on application startup.
 */
async function setupDefaultAdmin() {
  try {
    const adminExists = await prisma.user.findFirst({
      where: { role: 'ADMIN' }
    });

    if (!adminExists) {
      const hashedPassword = await bcrypt.hash(config.admin.password, 10);

      const admin = await prisma.user.create({
        data: {
          name: 'Site Administrator',
          email: config.admin.email,
          password: hashedPassword,
          role: 'ADMIN'
        }
      });

      console.log('Default admin created:', admin.email);
    } else {
      console.log('Admin already exists:', adminExists.email);
    }
  } catch (error) {
    console.error('Error setting up default admin:', error);
  }
}

module.exports = { setupDefaultAdmin };