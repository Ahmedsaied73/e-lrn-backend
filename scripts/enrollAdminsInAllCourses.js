/**
 * Script to automatically enroll all admin users in all courses
 * 
 * Usage: 
 * node scripts/enrollAdminsInAllCourses.js
 * 
 * Optional flags:
 * --markAsPaid=true (default) - Mark all enrollments as paid
 * --force=false (default) - Skip confirmation prompt
 */

const { PrismaClient } = require('@prisma/client');
const readline = require('readline');
const prisma = new PrismaClient();

// Parse command line arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.split('=');
  if (key.startsWith('--')) {
    acc[key.slice(2)] = value;
  }
  return acc;
}, {});

// Set default values
const markAsPaid = args.markAsPaid !== 'false'; // Default to true
const skipConfirmation = args.force === 'true'; // Default to false

// Create interface for user confirmation
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function confirmAction() {
  if (skipConfirmation) return true;
  
  return new Promise((resolve) => {
    rl.question('This will enroll all admin users in all courses. Continue? (y/n): ', (answer) => {
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function enrollAdminsInAllCourses() {
  try {
    console.log('Finding all admin users...');
    
    // Get all admin users
    const adminUsers = await prisma.user.findMany({
      where: { role: 'ADMIN' }
    });
    
    if (adminUsers.length === 0) {
      console.log('No admin users found');
      return;
    }
    
    console.log(`Found ${adminUsers.length} admin users`);
    
    // Get all courses
    const courses = await prisma.course.findMany();
    
    if (courses.length === 0) {
      console.log('No courses found');
      return;
    }
    
    console.log(`Found ${courses.length} courses`);
    
    // Confirm the action
    const confirmed = await confirmAction();
    if (!confirmed) {
      console.log('Operation cancelled');
      return;
    }
    
    console.log('Enrolling admin users in all courses...');
    
    // For each admin user, enroll in each course
    const results = [];
    
    for (const user of adminUsers) {
      for (const course of courses) {
        // Check if enrollment already exists
        const existingEnrollment = await prisma.enrollment.findFirst({
          where: {
            userId: user.id,
            courseId: course.id
          }
        });
        
        if (existingEnrollment) {
          // Update existing enrollment if needed
          if (markAsPaid && !existingEnrollment.isPaid) {
            await prisma.enrollment.update({
              where: { id: existingEnrollment.id },
              data: {
                isPaid: true,
                paymentDate: new Date()
              }
            });
            results.push(`Updated enrollment for ${user.email} in course "${course.title}" as paid`);
          } else {
            results.push(`Enrollment for ${user.email} in course "${course.title}" already exists`);
          }
        } else {
          // Create new enrollment
          await prisma.enrollment.create({
            data: {
              userId: user.id,
              courseId: course.id,
              isPaid: markAsPaid,
              paymentDate: markAsPaid ? new Date() : null
            }
          });
          results.push(`Enrolled ${user.email} in course "${course.title}"`);
        }
      }
    }
    
    // Display results
    console.log('\nResults:');
    results.forEach(result => console.log(`- ${result}`));
    console.log('\nOperation completed successfully');
    
  } catch (error) {
    console.error('Error enrolling admins in courses:', error);
  } finally {
    rl.close();
    await prisma.$disconnect();
  }
}

enrollAdminsInAllCourses(); 