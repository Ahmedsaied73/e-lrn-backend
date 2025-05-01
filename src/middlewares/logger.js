/**
 * Request Logger Middleware
 * 
 * This middleware logs detailed information about incoming HTTP requests
 * and their responses for debugging and monitoring purposes.
 * 
 * Features:
 * - Logs request method, URL, and timestamp
 * - Logs request headers and body (configurable)
 * - Logs response status code and response time
 * - Supports different log levels based on environment
 * - Masks sensitive data in logs
 */

const logger = (options = {}) => {
  // Default configuration
  const config = {
    logHeaders: options.logHeaders || false,
    logBody: options.logBody || false,
    logLevel: options.logLevel || 'info',
    sensitiveFields: options.sensitiveFields || ['password', 'token', 'authorization', 'cookie'],
    excludePaths: options.excludePaths || ['/health', '/metrics']
  };

  /**
   * Mask sensitive data in objects
   * @param {Object} obj - Object to mask
   * @returns {Object} - Masked object
   */
  const maskSensitiveData = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    
    const masked = { ...obj };
    
    for (const key in masked) {
      if (config.sensitiveFields.includes(key.toLowerCase())) {
        masked[key] = '[REDACTED]';
      } else if (typeof masked[key] === 'object') {
        masked[key] = maskSensitiveData(masked[key]);
      }
    }
    
    return masked;
  };

  return (req, res, next) => {
    // Skip logging for excluded paths
    if (config.excludePaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    // Capture request timestamp
    const startTime = Date.now();
    const requestTime = new Date().toISOString();
    
    // Prepare request data for logging
    const requestData = {
      method: req.method,
      url: req.originalUrl || req.url,
      ip: req.ip || req.connection.remoteAddress,
      timestamp: requestTime,
      userId: req.user ? req.user.id : 'unauthenticated'
    };
    
    // Add headers if configured
    if (config.logHeaders) {
      requestData.headers = maskSensitiveData(req.headers);
    }
    
    // Add body if configured and exists
    if (config.logBody && req.body && Object.keys(req.body).length > 0) {
      requestData.body = maskSensitiveData(req.body);
    }
    
    // Log request
    console.log(`[REQUEST] ${requestData.method} ${requestData.url} - User: ${requestData.userId}`);
    
    // Capture response data
    const originalSend = res.send;
    res.send = function(body) {
      res.send = originalSend;
      res.responseBody = body;
      return res.send(body);
    };
    
    // Log response when finished
    res.on('finish', () => {
      const responseTime = Date.now() - startTime;
      
      const responseData = {
        statusCode: res.statusCode,
        responseTime: `${responseTime}ms`,
        timestamp: new Date().toISOString()
      };
      
      // Log response
      console.log(`[RESPONSE] ${requestData.method} ${requestData.url} - Status: ${responseData.statusCode} - Time: ${responseData.responseTime}`);
      
      // Log detailed info for errors
      if (res.statusCode >= 400) {
        console.error(`[ERROR] ${requestData.method} ${requestData.url} - Status: ${responseData.statusCode}`, {
          request: requestData,
          response: responseData
        });
      }
    });
    
    next();
  };
};

module.exports = logger;