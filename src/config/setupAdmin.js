const prisma = require('./db');
const bcrypt = require('bcrypt');
const config = require('./env');
const { randomBase36Slug } = require('../utils/slugs');

let adminSeeded = false;

/**
 * Ensures that a default admin exists in the system.
 * Credentials are sourced exclusively from environment variables (config.admin.*).
 * Run on application startup.
 */
async function setupDefaultAdmin() {
  try {
    const adminExists = await prisma.user.findFirst({
      where: { role: 'ADMIN', deletedAt: null },
      select: { id: true, email: true, essayPhotoEnabled: true },
    });

    if (!adminExists) {
      const hashedPassword = await bcrypt.hash(config.admin.password, 10);

      const admin = await prisma.user.create({
        data: {
          name: 'Site Administrator',
          email: config.admin.email,
          password: hashedPassword,
          role: 'ADMIN',
          slug: randomBase36Slug(),
          essayPhotoEnabled: true,
        }
      });

      adminSeeded = true;
      console.log('Default admin created:', admin.email);
    } else {
      if (config.features && config.features.essayPhoto && !adminExists.essayPhotoEnabled) {
        await prisma.user.update({
          where: { id: adminExists.id },
          data: { essayPhotoEnabled: true },
        }).catch(() => {});
      }
      adminSeeded = true;
      console.log('Admin already exists:', adminExists.email);
    }
  } catch (error) {
    adminSeeded = false;
    console.error('Error setting up default admin:', error);
  }
}

function isAdminSeeded() {
  return adminSeeded;
}

module.exports = { setupDefaultAdmin, isAdminSeeded };