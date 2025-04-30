/**
 * Script to manually mark an enrollment as paid in the database
 * 
 * Usage: 
 * node scripts/markEnrollmentAsPaid.js --userId=<userId> --courseId=<courseId>
 * 
 * or:
 * node scripts/markEnrollmentAsPaid.js --enrollmentId=<enrollmentId>
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Parse command line arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.split('=');
  if (key.startsWith('--')) {
    acc[key.slice(2)] = value;
  }
  return acc;
}, {});

async function markEnrollmentAsPaid() {
  try {
    let enrollment;
    
    // Either find by enrollmentId or by userId and courseId
    if (args.enrollmentId) {
      enrollment = await prisma.enrollment.findUnique({
        where: { id: parseInt(args.enrollmentId) },
        include: { user: true, course: true }
      });
    } else if (args.userId && args.courseId) {
      // First check if enrollment exists
      enrollment = await prisma.enrollment.findFirst({
        where: {
          userId: parseInt(args.userId),
          courseId: parseInt(args.courseId)
        },
        include: { user: true, course: true }
      });
      
      // If not, create it
      if (!enrollment) {
        enrollment = await prisma.enrollment.create({
          data: {
            userId: parseInt(args.userId),
            courseId: parseInt(args.courseId),
            isPaid: false
          },
          include: { user: true, course: true }
        });
        console.log(`Created new enrollment for user ${args.userId} in course ${args.courseId}`);
      }
    } else {
      console.error('Error: You must provide either --enrollmentId or both --userId and --courseId');
      process.exit(1);
    }
    
    if (!enrollment) {
      console.error('Error: Enrollment not found');
      process.exit(1);
    }
    
    // Update the enrollment to paid status
    const updatedEnrollment = await prisma.enrollment.update({
      where: { id: enrollment.id },
      data: {
        isPaid: true,
        paymentDate: new Date()
      }
    });
    
    console.log(`Enrollment #${updatedEnrollment.id} has been marked as paid`);
    console.log(`User: ${enrollment.user.name} (${enrollment.user.email})`);
    console.log(`Course: ${enrollment.course.title}`);
    console.log(`Payment date: ${updatedEnrollment.paymentDate}`);
    
  } catch (error) {
    console.error('Error marking enrollment as paid:', error);
  } finally {
    await prisma.$disconnect();
  }
}

markEnrollmentAsPaid(); 