const express = require('express');
const cors = require('cors'); // Import CORS package
const cookieParser = require('cookie-parser'); // Import cookie-parser package
const { performance } = require('perf_hooks');
const Authrouter = require('./src/routes/auth');
const Userrouter = require('./src/routes/users');
const Courserouter = require('./src/routes/courses');
const Videorouter = require('./src/routes/videos');
const YoutubeRouter = require('./src/routes/youtubeRoutes');
const StreamRouter = require('./src/routes/streamRoutes');
const SearchRouter = require('./src/routes/searchRoutes');
const PaymentRouter = require('./src/routes/paymentRoutes');
const enrollmentRoutes = require('./src/routes/enrollmentRoutes');
const videoProgressRoutes = require('./src/routes/videoProgressRoutes');
const quizRoutes = require('./src/routes/quizRoutes');
const assignmentRoutes = require('./src/routes/assignmentRoutes');
const { requestLogger } = require('./src/controllers/quizController');
const rateLimit = require('express-rate-limit');

const { setupDefaultAdmin } = require('./src/config/setupAdmin');
const path = require('path');
const app = express();
const port = 3005;
const events = require('events');
events.EventEmitter.defaultMaxListeners = 15;

// Initialize default admin on startup
setupDefaultAdmin().catch(console.error);

// Configure CORS to allow requests from any origin
app.use(cors({
    origin: '*', // Allow all origins
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Allow all methods
    allowedHeaders: ['Content-Type', 'Authorization'], // Allow these headers
    exposedHeaders: ['Content-Length', 'X-Total-Count'], // Expose these headers
    credentials: true, // Allow cookies
    maxAge: 86400 // Cache preflight request results for 24 hours (in seconds)
}));

app.use(express.json());
app.use(cookieParser()); // Add cookie-parser middleware
// Add request logger middleware to log all requests
app.use(requestLogger);

// // Set up rate limiter: maximum of 100 requests per 15 minutes per IP
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // limit each IP to 100 requests per windowMs
//   message: 'Too many requests from this IP, please try again later.'
// });

// // Apply rate limiter to all requests
// app.use(limiter);

// Serve uploaded files statically
// app.use('/enroll' , enrollRouter); // Add the enrollment router
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use("/user", Userrouter);
app.use('/enroll',enrollmentRoutes);
app.use('/auth', Authrouter);
app.use('/courses', Courserouter);
app.use('/videos', Videorouter);
app.use('/youtube', YoutubeRouter);
app.use('/stream', StreamRouter);
app.use('/search', SearchRouter);
app.use('/payments', PaymentRouter);
app.use('/progress', videoProgressRoutes);
app.use('/quizzes', quizRoutes);
app.use('/assignments', assignmentRoutes);


app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
    console.log('CORS enabled for all origins');
});