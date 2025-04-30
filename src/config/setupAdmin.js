const prisma = require('./db');
const bcrypt = require('bcrypt');

/**
 * Ensures that a default teacher/admin exists in the system
 * This will be run on application startup
 */
async function setupDefaultAdmin() {
  try {
    // Check if admin already exists
    const adminExists = await prisma.user.findFirst({
      where: {
        role: 'ADMIN'
      }
    });

    if (!adminExists) {
      // Create default admin/teacher if none exists
      const hashedPassword = await bcrypt.hash('admin123', 10);
      
      const admin = await prisma.user.create({
        data: {
          name: 'Site Administrator',
          email: 'admin@elearning.com',
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