'use strict';
require('dotenv').config();
const prisma = require('../src/config/db');

async function main() {
  const msgs = await prisma.agentMessage.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' }
  });
  console.log('LATEST MESSAGES:', JSON.stringify(msgs, null, 2));
  await prisma.$disconnect();
}
main();
